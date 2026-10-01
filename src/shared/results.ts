import { getOperationContext } from "../runtime/operation-context";
import { CodecksOperationError } from "../runtime/operation-error";
import { CodecksCredentialError } from "../codecks-credential-error";

export const TOOL_VERSION = "v2.0.0";
export type OutputFormat = "text" | "json";
export const formatJsonMarkdown = (payload: unknown): string =>
{
    const json = JSON.stringify(payload, null, 2) ?? "";
    return `\`\`\`json\n${json}\n\`\`\``;
};

export const toStructuredResult = (
    format: OutputFormat,
    action: string,
    text: string,
    data: Record<string, unknown>,
    warnings?: string[],
    nextSuggestedAction?: string,
): string =>
{
    if (format !== "json")
    {
        return text;
    }

    const payload: Record<string, unknown> = {
        ok: true,
        action,
        toolVersion: TOOL_VERSION,
        data,
    };

    if (warnings && warnings.length > 0)
    {
        payload.warnings = warnings;
    }

    if (nextSuggestedAction)
    {
        payload.nextSuggestedAction = nextSuggestedAction;
    }

    return `## ${action}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
};

export type ErrorCategory =
    | "validation_error"
    | "not_found"
    | "ambiguous_match"
    | "incomplete_read"
    | "conflict"
    | "out_of_scope"
    | "forbidden"
    | "disabled_by_org"
    | "caller_aborted"
    | "rate_limit_queue_aborted"
    | "request_timeout"
    | "rate_limited"
    | "scan_queue_full"
    | "credential_rate_limited"
    | "response_too_large"
    | "invalid_response_stream"
    | "file_error"
    | "unsupported_token"
    | "credential_profile_mismatch"
    | "personal_token_required"
    | "org_actor_unverified"
    | "authentication_rejected"
    | "account_mismatch"
    | "missing_scope"
    | "api_error";

export const toStructuredErrorResult = (
    format: OutputFormat,
    action: string,
    category: ErrorCategory,
    message: string,
    data?: Record<string, unknown>,
): string =>
{
    const sanitizedMessage = sanitizeValue(message) + (data?.provider === "onepassword" && data?.requestSent === false ? " No request was sent to Codecks." : "");
    if (format !== "json")
    {
        return sanitizedMessage;
    }

    const sanitizedData = data
        ? truncateStructuredValue(data, 0, action === "card-get-batch" ? { maxDepth: 5, maxArrayItems: 25, maxObjectKeys: 30, maxStringLength: 4000 } : undefined).value as Record<string, unknown>
        : {};
    const payload: Record<string, unknown> = {
        ok: false,
        action,
        toolVersion: TOOL_VERSION,
        error: {
            category,
            message: sanitizedMessage,
            ...sanitizedData,
        },
    };

    return `## ${action}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
};

export const toErrorMessage = (error: unknown): string =>
{
    if (error instanceof Error)
    {
        return sanitizeValue(error.message);
    }

    return sanitizeValue(String(error ?? "Unknown error"));
};

export const sanitizeValue = (value: string): string =>
{
    return value
        .replace(/(OP_SERVICE_ACCOUNT_TOKEN\s*[=:]\s*)[^\s;]+/gi, "$1[REDACTED]")
        .replace(/(Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [REDACTED]")
        .replace(/\bcdx(?:at|ut)_[a-z0-9_-]+\b/gi, "[REDACTED]")
        .replace(/(X-Auth-Token|X-Api-Key|Api-Key)\s*[:=]\s*[^\s;]+/gi, "$1: [REDACTED]")
        .replace(/\bat=([^;\s]+)/gi, "at=[REDACTED]")
        .replace(/\b(access_token|refresh_token|token|credential|password|secret)\b\s*[:=]\s*['\"]?[^'\"\s,;}]+/gi, "$1: [REDACTED]")
        .replace(/("credential"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2")
        .replace(/op:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+/gi, "op://[REDACTED]/[REDACTED]/[REDACTED]");
};

export const sanitizeErrorPayload = (payload: unknown): string =>
{
    if (payload === null || payload === undefined)
    {
        return "";
    }

    if (typeof payload === "string")
    {
        return sanitizeValue(payload);
    }

    if (typeof payload === "object")
    {
        const replacer = (key: string, value: unknown): unknown =>
        {
            if (typeof key === "string" && /^(x-auth-token|x-api-key|api-key|apikey|authorization|cookie|set-cookie|token|access_token|refresh_token|credential|credentials|password|secret|client_secret)$/i.test(key))
            {
                return "[REDACTED]";
            }

            if (typeof value === "string")
            {
                return sanitizeValue(value);
            }

            return value;
        };

        try
        {
            return JSON.stringify(payload, replacer);
        }
        catch
        {
            return "[REDACTED]";
        }
    }

    return "";
};

export const isCredentialRateLimitedError = (error: unknown): boolean =>
    error instanceof CodecksCredentialError && error.credentialCategory === "credential_rate_limited";

export const credentialErrorData = (error: CodecksCredentialError): Record<string, unknown> => ({
    category: error.credentialCategory, provider: error.provider, stage: error.stage, retryable: error.retryable,
    ...(getOperationContext() ? { requestSent: getOperationContext()!.requestsDispatched > 0 } : {}),
});

export const classifyApiErrorCategory = (message: string): ErrorCategory =>
{
    if (/caller_aborted|cancelled by caller|request aborted/i.test(message))
    {
        return "caller_aborted";
    }

    if (/rate_limit_queue_aborted|request-rate queue/i.test(message))
    {
        return "rate_limit_queue_aborted";
    }

    if (/request_timeout|timed out/i.test(message))
    {
        return "request_timeout";
    }

    if (/scan_queue_full|scan queue is full/i.test(message))
    {
        return "scan_queue_full";
    }

    if (/\b429\b|rate limit/i.test(message))
    {
        return "rate_limited";
    }

    if (/personal_token_required|Personal API token is required/i.test(message)) return "personal_token_required";
    if (/org_actor_unverified|organization-token actor behavior is unverified/i.test(message)) return "org_actor_unverified";
    if (/credential_profile_mismatch|token kind does not match/i.test(message)) return "credential_profile_mismatch";
    if (/unsupported_token|Unsupported Codecks token format/i.test(message)) return "unsupported_token";
    if (/missing_scope/i.test(message)) return "missing_scope";
    if (/token_account_mismatch/i.test(message)) return "account_mismatch";
    if (/invalid_token|token_expired|not_a_member|user_api_tokens_disabled|\b401\b/i.test(message)) return "authentication_rejected";
    if (/\b403\b|forbidden/i.test(message))
    {
        return "forbidden";
    }

    if (/\b404\b|not found/i.test(message))
    {
        return "not_found";
    }

    if (/disabled|not enabled/i.test(message))
    {
        return "disabled_by_org";
    }

    return "api_error";
};

export const getOperationErrorData = (error: unknown): Record<string, unknown> => error instanceof CodecksCredentialError
    ? credentialErrorData(error)
    : error instanceof CodecksOperationError
        ? { ...error.details }
        : {};

export const truncateStructuredValue = (
    value: unknown,
    depth = 0,
    limits = { maxDepth: 5, maxArrayItems: 20, maxObjectKeys: 30, maxStringLength: 4000 },
): { value: unknown; truncated: boolean } =>
{
    if (value === null || value === undefined)
    {
        return { value, truncated: false };
    }

    if (typeof value === "string")
    {
        const sanitized = sanitizeValue(value);
        if (sanitized.length <= limits.maxStringLength)
        {
            return { value: sanitized, truncated: false };
        }

        return {
            value: `${sanitized.slice(0, limits.maxStringLength)}â€¦[truncated ${sanitized.length - limits.maxStringLength} chars]`,
            truncated: true,
        };
    }

    if (typeof value === "number" || typeof value === "boolean")
    {
        return { value, truncated: false };
    }

    if (depth >= limits.maxDepth)
    {
        return { value: "[TRUNCATED_DEPTH]", truncated: true };
    }

    if (Array.isArray(value))
    {
        const items = value.slice(0, limits.maxArrayItems).map((entry) => truncateStructuredValue(entry, depth + 1, limits));
        const truncated = items.some((entry) => entry.truncated) || value.length > limits.maxArrayItems;
        const normalized = items.map((entry) => entry.value);
        if (value.length > limits.maxArrayItems)
        {
            normalized.push(`[TRUNCATED_ITEMS:${value.length - limits.maxArrayItems}]`);
        }
        return { value: normalized, truncated };
    }

    if (typeof value === "object")
    {
        const entries = Object.entries(value as Record<string, unknown>);
        const result: Record<string, unknown> = {};
        let truncated = entries.length > limits.maxObjectKeys;

        for (const [key, entryValue] of entries.slice(0, limits.maxObjectKeys))
        {
            if (/^(x-auth-token|x-api-key|api-key|apikey|authorization|cookie|set-cookie|token|access_token|refresh_token|credential|credentials|password|secret|client_secret)$/i.test(key))
            {
                result[key] = "[REDACTED]";
                truncated = true;
                continue;
            }

            const normalized = truncateStructuredValue(entryValue, depth + 1, limits);
            result[key] = normalized.value;
            truncated = truncated || normalized.truncated;
        }

        if (entries.length > limits.maxObjectKeys)
        {
            result.__truncatedKeys = entries.length - limits.maxObjectKeys;
        }

        return { value: result, truncated };
    }

    return { value: String(value), truncated: false };
};
