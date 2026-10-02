import { isRecord } from "../shared/query";
import { sanitizeErrorPayload, sanitizeValue, toErrorMessage } from "../shared/results";
import { UUID_PATTERN, generateSessionId } from "../shared/session-id";
import { getAuthenticatedConfig } from "./credentials";
import { getActiveAbortSignal, getOperationContext, noteOperationRequest } from "./operation-context";
import { CodecksOperationError } from "./operation-error";
import { enforceRateLimit, observeServerCooldown, parseRetryAfterMs, serverCooldownUntil, sleep } from "./pacing";
import { type CodecksConfig, type CodecksFetch } from "./types";
import { evictOnePasswordCredentialGeneration } from "../codecks-onepassword";
import { BoundedResponseError } from "../codecks-bounded-response";
import { readBoundedResponse } from "../codecks-bounded-response";

export const ALLOW_OUT_OF_SCOPE_DISPATCH = /^(1|true|yes)$/i.test(process.env.CODECKS_ALLOW_OUT_OF_SCOPE_DISPATCH ?? "");
export const RETRY_STATUS_CODES = new Set([500, 502, 503, 504]);
export const MAX_RETRY_ATTEMPTS = (() =>
{
    const value = Number.parseInt(process.env.CODECKS_RETRY_ATTEMPTS ?? "2", 10);
    if (!Number.isFinite(value))
    {
        return 2;
    }
    return Math.max(0, Math.min(5, value));
})();
export const RETRY_BASE_DELAY_MS = (() =>
{
    const value = Number.parseInt(process.env.CODECKS_RETRY_BASE_DELAY_MS ?? "300", 10);
    if (!Number.isFinite(value))
    {
        return 300;
    }
    return Math.max(100, Math.min(5000, value));
})();
export const RETRY_JITTER_MS = 125;
export const REQUEST_TIMEOUT_MS = (() =>
{
    const value = Number.parseInt(process.env.CODECKS_REQUEST_TIMEOUT_MS ?? "30000", 10);
    if (!Number.isFinite(value))
    {
        return 30000;
    }
    return Math.max(5000, Math.min(120000, value));
})();

export const normalizeDispatchPath = (value: string): string => value.trim().replace(/^\/+|\/+$/g, "");

export const getDispatchPolicyMessage = (path: string): string | null =>
{
    if (ALLOW_OUT_OF_SCOPE_DISPATCH)
    {
        return null;
    }

    if (/journey/i.test(path))
    {
        return "Journey automation is intentionally UI-only in this scope. Use the Codecks UI for Journey setup/apply/clone actions.";
    }

    if (/^(integrations?|discord|openDecks?|userReports?|importers?)(?:\/|$)/i.test(path))
    {
        return "Integration writes are out of scope for this workspace. Use integration-specific workflows in the Codecks UI.";
    }

    return null;
};

export const codecksAuthHeaders = (config: CodecksConfig): Record<string, string> => ({
    Authorization: `Bearer ${config.token}`,
    "X-Account": config.account,
});

export const safeApiDiagnostic = (value: unknown, credential: string): string | undefined =>
{
    if (typeof value !== "string" || !value.trim()) return undefined;
    if (/<\s*[a-z!/][^>]*>/i.test(value)) return "HTML error response (details withheld)";
    if (/\b(?:authorization|cookie|set-cookie|x-auth-token|x-api-key)\s*[:=]/i.test(value)) return undefined;
    const withoutCredential = credential ? value.split(credential).join("[REDACTED]") : value;
    const clean = sanitizeValue(withoutCredential)
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]|[\x00-\x1f\x7f-\x9f]/g, " ")
        .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[REDACTED]")
        .replace(/https?:\/\/\S+/gi, "[REDACTED]")
        .replace(/\b[a-z0-9_-]{32,}\b/gi, "[REDACTED]")
        .replace(/\b\d{6,}\b/g, "[REDACTED]")
        .replace(/\s+/g, " ").trim().slice(0, 240);
    return clean || undefined;
};

export const boundedApiErrorShape = (payload: unknown, credential: string): Array<{ path: string; type: string; count?: number }> =>
{
    const shape: Array<{ path: string; type: string; count?: number }> = [];
    const visit = (value: unknown, path: string, depth: number): void =>
    {
        if (shape.length >= 20 || depth > 3) return;
        const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
        shape.push({ path, type, ...(Array.isArray(value) ? { count: Math.min(value.length, 100) } : {}) });
        if (Array.isArray(value)) { for (const item of value.slice(0, 3)) visit(item, `${path}[]`, depth + 1); }
        else if (isRecord(value)) for (const [key, item] of Object.entries(value).slice(0, 20))
        {
            if (!/^[a-z_$][a-z0-9_$-]{0,39}$/i.test(key) || (credential && key.includes(credential))
                || /^cdx(?:at|ut)_/i.test(key) || /authorization|cookie|token|credential|password|secret|request|header|payload|body|raw|value|data/i.test(key)) continue;
            visit(item, `${path}.${key}`, depth + 1);
        }
    };
    visit(payload, "$", 0);
    return shape;
};

export const apiFailure = (response: Response, payload: unknown, path: string, retryPolicy: CodecksRequestRetryPolicy = "read-only", requestsAttempted = 1, credential = ""): CodecksOperationError =>
{
    const object = isRecord(payload) ? payload : {};
    const nested = isRecord(object.error) ? object.error : Array.isArray(object.errors) && isRecord(object.errors[0]) ? object.errors[0] : object;
    const knownCodes = ["missing_scope", "token_account_mismatch", "invalid_token", "token_expired", "not_a_member", "user_api_tokens_disabled"];
    const explicitCode = typeof nested.code === "string" && /^[a-z_]{1,80}$/i.test(nested.code) && sanitizeValue(nested.code) === nested.code ? nested.code : undefined;
    const errorString = typeof object.error === "string" && /^[a-z_]{1,80}$/i.test(object.error) && sanitizeValue(object.error) === object.error ? object.error : undefined;
    const messageCode = typeof nested.message === "string" && knownCodes.includes(nested.message) ? nested.message
        : typeof object.message === "string" && knownCodes.includes(object.message) ? object.message : undefined;
    const code = explicitCode ?? errorString ?? messageCode;
    const rawScope = nested.requiredScope ?? nested.required_scope ?? object.requiredScope ?? object.required_scope;
    const scope = typeof rawScope === "string" && /^[a-z0-9:_-]{1,100}$/i.test(rawScope) && sanitizeValue(rawScope) === rawScope ? rawScope : undefined;
    const rawApiPath = nested.path ?? object.path;
    const apiPath = typeof rawApiPath === "string" && /^[a-z_][a-z0-9_.\[\]-]{0,159}$/i.test(rawApiPath) ? sanitizeValue(rawApiPath) : undefined;
    const queryValidationCodes = ["invalid_query_shape", "unknown_model", "unknown_field", "unknown_relation", "unknown_operator", "invalid_value", "unknown_special_key", "invalid_order", "invalid_limit", "missing_ids", "relation_takes_no_query", "invalid_aggregate", "missing_scope"];
    const validationDetails: string[] = [];
    const collect = (value: unknown, depth = 0): void =>
    {
        if (depth > 4 || validationDetails.length >= 3) return;
        if (typeof value === "string") { const safe = safeApiDiagnostic(value, credential); if (safe && !validationDetails.includes(safe)) validationDetails.push(safe); return; }
        if (Array.isArray(value)) { for (const item of value.slice(0, 3)) collect(item, depth + 1); return; }
        if (!isRecord(value)) return;
        const field = [value.field, value.param, value.property].find(item => typeof item === "string" && /^[a-z][a-z0-9_.\[\]-]{0,79}$/i.test(item) && !/token|credential|password|secret/i.test(item));
        for (const key of ["message", "detail", "description", "reason", "error", "errors", "validation", "details"])
        {
            if (key in value && validationDetails.length < 3) {
                if (key === "error" && typeof value[key] === "string" && value[key] === code) continue;
                const before = validationDetails.length;
                collect(value[key], depth + 1);
                if (field && validationDetails.length > before) validationDetails[before] = `${field}: ${validationDetails[before]}`.slice(0, 240);
            }
        }
    };
    if (response.status >= 400 && response.status < 500 && response.status !== 401
        && (retryPolicy === "non-idempotent-mutation" || queryValidationCodes.includes(code ?? ""))) collect(payload);
    const validationMessage = validationDetails[0];
    const category = code === "missing_scope" ? "missing_scope" : code === "token_account_mismatch" ? "account_mismatch"
        : ["invalid_token", "token_expired", "not_a_member", "user_api_tokens_disabled"].includes(code ?? "") || response.status === 401 ? "authentication_rejected" : response.status === 403 ? "forbidden" : "api_error";
    return new CodecksOperationError(category, `Codecks API returned HTTP ${response.status}${code ? ` (${code})` : ""}.`, {
        httpStatus: response.status, path, ...(code ? { apiCode: code } : {}), ...(scope ? { requiredScope: scope } : {}), ...(apiPath ? { apiPath } : {}),
        ...(validationMessage ? { validationMessage, validationDetails } : {}),
        ...(retryPolicy === "non-idempotent-mutation" ? { errorShape: boundedApiErrorShape(payload, credential) } : {}),
        ...(retryPolicy === "non-idempotent-mutation" ? {
            requestsAttempted, dispatchAttempt: "http_response",
            mutationCertainty: [400, 401, 403].includes(response.status) ? "definitely_rejected" : "indeterminate",
        } : {}),
    });
};

export const normalizeDispatchPayload = (path: string, payload: Record<string, unknown>): Record<string, unknown> =>
{
    const normalizedPayload = { ...payload };

    if (path !== "cards/update")
    {
        return normalizedPayload;
    }

    const rawCardId = normalizedPayload.id;
    const cardId = rawCardId === undefined || rawCardId === null ? "" : String(rawCardId).trim();
    if (!cardId)
    {
        throw new Error("cards/update requires an 'id' value.");
    }

    const rawSessionId = normalizedPayload.sessionId;
    if (rawSessionId === undefined || rawSessionId === null || String(rawSessionId).trim().length === 0)
    {
        normalizedPayload.sessionId = generateSessionId();
        return normalizedPayload;
    }

    const sessionId = String(rawSessionId).trim();
    if (!UUID_PATTERN.test(sessionId))
    {
        throw new Error("cards/update requires a UUID sessionId. Omit sessionId to auto-generate one.");
    }

    normalizedPayload.sessionId = sessionId;
    return normalizedPayload;
};

// Bulk-create recovery accepts no more than three server-directed waits. Fifteen
// seconds is therefore the smallest bounded budget derived from the existing
// five-second pacing window, rather than a guessed mutation quota.
export const computeRetryDelayMs = (attempt: number, response: Response): number =>
{
    const retryAfter = parseRetryAfterMs(response.headers.get("Retry-After"), "seconds");
    if (retryAfter.value !== null) return retryAfter.value;

    const exponential = RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt));
    const jitter = Math.floor(Math.random() * RETRY_JITTER_MS);
    return exponential + jitter;
};

export const getRootSemanticErrors = (payload: unknown): unknown[] | undefined =>
{
    if (!isRecord(payload) || !Array.isArray(payload.errors) || payload.errors.length === 0)
    {
        return undefined;
    }

    return payload.errors;
};

export const formatRootSemanticError = (errors: unknown[]): string =>
{
    const messages = errors
        .map((entry) => isRecord(entry) && entry.message !== undefined ? entry.message : entry)
        .map((entry) => sanitizeErrorPayload(entry))
        .filter((entry) => entry.length > 0);
    return `Codecks API semantic error: ${messages.join("; ") || "Codecks returned a nonempty root errors array."}`;
};

export type CodecksRequestRetryPolicy = "read-only" | "exact-read" | "non-idempotent-mutation";
export const MAX_BATCH_CARD_RESPONSE_BYTES = 2 * 1024 * 1024;

export const readResponseTextBounded = async (response: Response, maxBytes?: number): Promise<string> =>
{
    if (!maxBytes) return response.text();
    try
    {
        return await readBoundedResponse(response, maxBytes, { signal: getActiveAbortSignal(), timeoutMs: REQUEST_TIMEOUT_MS });
    }
    catch (error)
    {
        if (error instanceof BoundedResponseError)
        {
            throw new CodecksOperationError(error.category, error.message, { recoveryHint: "Do not automatically retry. Narrow the batch or diagnose the response failure." });
        }
        throw error;
    }
};

export const requestJson = async (
    path: string,
    init: RequestInit,
    config: CodecksConfig,
    retryPolicy: CodecksRequestRetryPolicy,
    fetchImplementation: CodecksFetch = fetch,
    maxResponseBytes?: number,
): Promise<unknown> =>
{
    const externalSignal = getActiveAbortSignal();

    for (let attempt = 0; ; attempt += 1)
    {
        try
        {
            const gateWait = await enforceRateLimit();
            noteOperationRequest(gateWait);
        }
        catch (error)
        {
            if (error instanceof CodecksOperationError)
            {
                throw new CodecksOperationError(error.category, error.message, {
                    ...error.details,
                    requestsAttempted: attempt,
                });
            }
            throw error;
        }

        const controller = new AbortController();
        const onAbort = () => controller.abort(externalSignal?.reason);
        if (externalSignal?.aborted)
        {
            controller.abort(externalSignal.reason);
        }
        else if (externalSignal)
        {
            externalSignal.addEventListener("abort", onAbort, { once: true });
        }

        const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        let response: Response;
        try
        {
            const context = getOperationContext();
            if (context) context.requestsDispatched++;
            response = await fetchImplementation(`${config.baseUrl}${path}`, {
                ...init,
                headers: {
                    "Content-Type": "application/json",
                    ...codecksAuthHeaders(config),
                    ...(init.headers ?? {}),
                },
                signal: controller.signal,
            });
        }
        catch (error)
        {
            clearTimeout(timeoutHandle);
            externalSignal?.removeEventListener("abort", onAbort);
            if (externalSignal?.aborted)
            {
                throw new CodecksOperationError("caller_aborted", "Codecks API request cancelled by caller.", {
                    requestsAttempted: attempt + 1,
                    ...(retryPolicy === "non-idempotent-mutation" ? { path, dispatchAttempt: "outcome_unknown", mutationCertainty: "indeterminate" } : {}),
                    recoveryHint: retryPolicy === "non-idempotent-mutation" ? "Inspect the exact target before any further write; do not replay." : "Retry the narrow operation sequentially if it is still needed.",
                });
            }
            const message = toErrorMessage(error);
            const timedOut = message.toLowerCase().includes("abort") || message.toLowerCase().includes("timeout");
            const shouldRetryTimeout = retryPolicy === "read-only" && timedOut && attempt < MAX_RETRY_ATTEMPTS;
            if (shouldRetryTimeout)
            {
                await sleep(RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS), externalSignal);
                continue;
            }

            if (timedOut)
            {
                throw new CodecksOperationError("request_timeout", `Codecks API request timed out after ${REQUEST_TIMEOUT_MS}ms.`, {
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    requestsAttempted: attempt + 1,
                    ...(retryPolicy === "non-idempotent-mutation" ? { path, dispatchAttempt: "outcome_unknown", mutationCertainty: "indeterminate" } : {}),
                    recoveryHint: retryPolicy === "non-idempotent-mutation" ? "Inspect the exact target before any further write; do not replay." : "Narrow the scope or lower scanLimit before retrying sequentially.",
                });
            }

            if (retryPolicy === "non-idempotent-mutation") throw new CodecksOperationError("api_error", "Codecks mutation request outcome is uncertain; do not replay.", {
                path, requestsAttempted: attempt + 1, dispatchAttempt: "outcome_unknown", mutationCertainty: "indeterminate",
            });
            throw error;
        }
        finally
        {
            clearTimeout(timeoutHandle);
            externalSignal?.removeEventListener("abort", onAbort);
        }

        const retryAfter = observeServerCooldown(response);
        if (response.status === 429 && retryAfter.status !== "valid") throw new CodecksOperationError("rate_limited", "Codecks rejected the request with HTTP 429.", {
            httpStatus: 429, retryAfterParseStatus: retryAfter.status, retryAfterReason: retryAfter.reason,
            ...(retryPolicy === "non-idempotent-mutation" ? { path, requestsAttempted: attempt + 1, dispatchAttempt: "http_response", mutationCertainty: "definitely_rejected" } : {}),
            ...(retryAfter.requestedMs !== undefined ? { retryAfterMs: retryAfter.requestedMs, retryAfterFormat: retryAfter.format } : {}),
            recoveryHint: "Retry after the bounded fifteen-second recovery window.",
        });
        // Only a definite HTTP 401 rejects authentication. A 403 can be a
        // permission decision, so it must not evict a reusable credential.
        if (response.status === 401 && config.credentialProviderId === "onepassword")
        {
            evictOnePasswordCredentialGeneration(config.credentialGeneration);
        }

        let text: string;
        try { text = await readResponseTextBounded(response, maxResponseBytes); }
        catch (error) {
            if (retryPolicy !== "non-idempotent-mutation") throw error;
            throw new CodecksOperationError(error instanceof CodecksOperationError ? error.category : "invalid_response_stream", "Codecks mutation response could not be read; do not replay.", {
                path, httpStatus: response.status, requestsAttempted: attempt + 1, dispatchAttempt: "http_response", mutationCertainty: "indeterminate",
            });
        }
        let payload: unknown = text;

        if (text)
        {
            try
            {
                payload = JSON.parse(text) as unknown;
            }
            catch
            {
                payload = text;
            }
        }

        if (response.ok)
        {
            const rootErrors = getRootSemanticErrors(payload);
            if (rootErrors)
            {
                if (retryPolicy === "non-idempotent-mutation") throw new CodecksOperationError("api_error", "Codecks mutation returned semantic errors; do not replay.", {
                    path, httpStatus: response.status, requestsAttempted: attempt + 1, dispatchAttempt: "http_response", mutationCertainty: "indeterminate",
                });
                throw new Error(formatRootSemanticError(rootErrors));
            }
            return payload;
        }

        const shouldRetry = retryPolicy === "read-only"
            && RETRY_STATUS_CODES.has(response.status)
            && attempt < MAX_RETRY_ATTEMPTS;
        if (shouldRetry)
        {
            // Retry-After is enforced by the shared gate on the next attempt. This
            // records actual queue time and avoids sleeping once here and again there.
            if (retryAfter.value !== null) continue;
            await sleep(computeRetryDelayMs(attempt, response), externalSignal);
            continue;
        }

        if (response.status === 429)
        {
            throw new CodecksOperationError("rate_limited", "Codecks rejected the request with HTTP 429.", {
                httpStatus: 429,
                requestsAttempted: attempt + 1,
                ...(retryPolicy === "non-idempotent-mutation" ? { path, dispatchAttempt: "http_response", mutationCertainty: "definitely_rejected" } : {}),
                retryAfterParseStatus: retryAfter.status,
                ...(retryAfter.requestedMs !== undefined ? { retryAfterMs: retryAfter.requestedMs, retryAfterFormat: retryAfter.format } : {}),
                ...(retryAfter.reason ? { retryAfterReason: retryAfter.reason } : {}),
                ...(retryAfter.value !== null ? { cooldownUntil: serverCooldownUntil } : {}),
                recoveryHint: "Wait for the server rate-limit window, then retry sequentially.",
            });
        }
        throw apiFailure(response, payload, path, retryPolicy, attempt + 1, config.token);
    }
};

export const runQuery = async (query: Record<string, unknown>, maxResponseBytes?: number): Promise<unknown> =>
{
    const config = await getAuthenticatedConfig();
    return requestJson("/", {
        method: "POST",
        body: JSON.stringify({ query }),
    }, config, "read-only", fetch, maxResponseBytes);
};

// Identity verification is diagnostic, so it must make one physical request rather
// than inheriting normal read retries.
export const runExactReadQuery = async (
    query: Record<string, unknown>,
    fetchImplementation: CodecksFetch = fetch,
): Promise<unknown> =>
{
    const config = await getAuthenticatedConfig();
    return requestJson("/", {
        method: "POST",
        body: JSON.stringify({ query }),
    }, config, "exact-read", fetchImplementation);
};

export const runDispatch = async (
    path: string,
    payload: Record<string, unknown>,
    verifiedOrgActorId?: string,
    verifiedNamedHandTargetId?: string,
): Promise<unknown> =>
{
    const config = await getAuthenticatedConfig();
    const verifiedOrgThread = config.kind === "ORG" && path === "resolvables/create"
        && typeof verifiedOrgActorId === "string" && verifiedOrgActorId.length > 0
        && payload.userId === verifiedOrgActorId && ["comment", "review", "block"].includes(String(payload.context ?? ""))
        && typeof payload.cardId === "string" && typeof payload.content === "string" && payload.content.length > 0
        && typeof payload.sessionId === "string" && /^[a-f0-9-]{36}$/i.test(payload.sessionId)
        && Object.keys(payload).length === 5;
    const fileData = isRecord(payload.fileData) ? payload.fileData : undefined;
    const verifiedOrgAttachment = config.kind === "ORG" && path === "cards/addFile"
        && typeof verifiedOrgActorId === "string" && verifiedOrgActorId.length > 0
        && payload.userId === verifiedOrgActorId && typeof payload.cardId === "string"
        && fileData && typeof fileData.fileName === "string" && typeof fileData.url === "string"
        && typeof fileData.size === "number" && typeof fileData.type === "string"
        && Object.keys(payload).length === 3;
    const verifiedOrgReply = config.kind === "ORG" && path === "resolvables/comment"
        && typeof verifiedOrgActorId === "string" && payload.authorId === verifiedOrgActorId
        && typeof payload.resolvableId === "string" && typeof payload.content === "string" && payload.content.length > 0
        && Object.keys(payload).length === 3;
    const verifiedOrgEdit = config.kind === "ORG" && path === "resolvables/updateComment"
        && typeof verifiedOrgActorId === "string" && payload.authorId === verifiedOrgActorId
        && typeof payload.entryId === "string" && typeof payload.content === "string" && payload.content.length > 0
        && Object.keys(payload).length === 3;
    const verifiedOrgClose = config.kind === "ORG" && path === "resolvables/close"
        && typeof verifiedOrgActorId === "string" && payload.closedBy === verifiedOrgActorId
        && typeof payload.id === "string" && Object.keys(payload).length === 2;
    const verifiedOrgReopen = config.kind === "ORG" && path === "resolvables/reopen"
        && typeof verifiedOrgActorId === "string" && verifiedOrgActorId.length > 0
        && typeof payload.id === "string" && Object.keys(payload).length === 1;
    const handCardIds = payload.cardIds;
    const verifiedNamedHand = typeof verifiedNamedHandTargetId === "string" && verifiedNamedHandTargetId.length > 0
        && payload.userId === verifiedNamedHandTargetId
        && (config.kind !== "ORG" || typeof verifiedOrgActorId === "string" && verifiedOrgActorId.length > 0)
        && typeof payload.sessionId === "string" && /^[a-f0-9-]{36}$/i.test(payload.sessionId)
        && Array.isArray(handCardIds) && handCardIds.length > 0 && handCardIds.length <= 500
        && handCardIds.every((id) => typeof id === "string" && id.length > 0)
        && new Set(handCardIds).size === handCardIds.length
        && (path === "handQueue/setCardOrders"
            ? Array.isArray(payload.draggedCardIds) && payload.draggedCardIds.length === 1
                && payload.draggedCardIds[0] === handCardIds.at(-1) && Object.keys(payload).length === 4
            : path === "handQueue/removeCards" && handCardIds.length === 1 && Object.keys(payload).length === 3);
    if (path.startsWith("handQueue/") && !verifiedNamedHand)
        throw new CodecksOperationError("org_actor_unverified", "Named-hand writes require a validated target and complete, fresh hand order; no mutation was sent.", { path });
    if (config.kind === "ORG" && !verifiedOrgThread && !verifiedOrgAttachment && !verifiedOrgReply && !verifiedOrgEdit && !verifiedOrgClose && !verifiedOrgReopen && !verifiedNamedHand
        && (payload.userId !== undefined || /^(?:resolvables|comments|reviews|blocks|attachments)(?:\/|$)|^cards\/addFile$/i.test(path))) throw new CodecksOperationError("org_actor_unverified", "Organization-token actor behavior is unverified for this write; no mutation was sent.", { path });
    if (config.kind === "ORG" && path === "cards/create" && (payload.userId !== undefined || payload.putOnHand === true)) throw new CodecksOperationError("org_actor_unverified", "Organization-token creation cannot infer its author or own hand; no mutation was sent.", { path });
    if (path === "cards/create" && !payload.deckId && !payload.assigneeId) throw new CodecksOperationError("api_error", "A card cannot be both unassigned and deckless; no mutation was sent.", { path, requestsAttempted: 0 });
    return requestJson(`/dispatch/${path}`, {
        method: "POST",
        body: JSON.stringify(payload),
    }, config, "non-idempotent-mutation");
};
