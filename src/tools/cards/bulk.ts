import { getBaseConfig } from "../../runtime/credentials";
import { fetchLoggedInUser } from "../../runtime/identity";
import { emitBulkMutationProgress, getOperationContext, withOperationContextIfMissing } from "../../runtime/operation-context";
import { CodecksOperationError } from "../../runtime/operation-error";
import { BULK_CREATE_MAX_CONSECUTIVE_429, MAX_SERVER_COOLDOWN_MS, type RetryAfterParseStatus } from "../../runtime/pacing";
import { runDispatch } from "../../runtime/transport";
import { blankToUndefined, isRecord, unwrapData } from "../../shared/query";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult, truncateStructuredValue } from "../../shared/results";
import { outputFormatArg } from "../../pi-tool-compat";
import { type CodecksUser } from "../../shared/types";
import { tool } from "../../pi-tool-compat";
import { join } from "path";
import { type BulkCreateRecord, type BulkUpdateRecord, type NormalizedBulkCreateRecord, type NormalizedBulkUpdateRecord, validateStrictBulkRecords, type BulkCreateNormalizationContext, normalizeBulkCreateRecord, normalizedMutationFingerprint, bulkPreviewFingerprint, actionKeyFor, extractDispatchCardIdentity, publicCardIdentity, publicBulkCreateRecord, preflightOutcomeRecords, markDefinitelyUnsent, isOperationalError, classifyMutationOutcome, markBulkCreateDefinitelyUnsent, writeBulkArtifact, type BulkUpdateNormalizationContext, normalizeBulkUpdateRecord } from "./helpers";

export const card_bulk_create = tool({
    description: "Preview or create multiple Codecks cards. Compact results keep only exceptional records inline; complete sanitized per-record details are written to a temporary JSON artifact.",
    args: {
        cards: tool.schema.array(tool.schema.object({ correlationKey: tool.schema.string().min(1).max(200).optional(), title: tool.schema.string().optional(), content: tool.schema.string().optional(), cardType: tool.schema.string().optional(), deck: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), milestone: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), effort: tool.schema.number().optional(), priority: tool.schema.string().optional(), assigneeId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), putOnHand: tool.schema.boolean().optional().describe("PERSONAL own hand only; ORG target unverified."), parentCardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), tags: tool.schema.array(tool.schema.string()).optional() })).min(1).max(100).describe("Strict card-create records. Use assigneeId, not assignee."),
        deck: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), milestone: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), parentCardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), dryRun: tool.schema.boolean().optional().describe("Preview only. Defaults to true."), expectedPreviewFingerprint: tool.schema.string().optional().describe("Required for apply: the previewFingerprint returned by the matching dry run."), format: outputFormatArg,
    },
    async execute(args) {
        return withOperationContextIfMissing(async () => {
        const format = args.format ?? "text"; const dryRun = args.dryRun !== false; const rawRecords = Array.isArray(args.cards) ? args.cards as unknown[] : []; const startedAt = Date.now();
        emitBulkMutationProgress(startedAt, "validating", 0);
        const allowedArguments = new Set(["cards", "deck", "milestone", "parentCardId", "dryRun", "expectedPreviewFingerprint", "format"]);
        const topLevelErrors = Object.keys(args).filter((field) => !allowedArguments.has(field)).map((field) => `bulk create argument ${field} is unsupported.`);
        const structuralErrors = [...topLevelErrors, ...validateStrictBulkRecords(rawRecords, "create")];
        if (structuralErrors.length) return toStructuredErrorResult(format, "card-bulk-create", "validation_error", structuralErrors.join(" "), { indexedErrors: structuralErrors, results: preflightOutcomeRecords(rawRecords, structuralErrors.map(message => ({ index: Number(message.match(/\[(\d+)\]/)?.[1]), message }))), requestsAttempted: 0 });
        const defaults: BulkCreateRecord = { deck: blankToUndefined(args.deck), milestone: blankToUndefined(args.milestone), parentCardId: blankToUndefined(args.parentCardId) };
        let user: CodecksUser;
        try { user = getBaseConfig().profileKey === "ORG" ? {} : await fetchLoggedInUser(); } catch (error) { return toStructuredErrorResult(format, "card-bulk-create", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }
        const normalized: NormalizedBulkCreateRecord[] = []; const normalizationErrors: Array<{ index: number; message: string }> = [];
        const normalizationContext: BulkCreateNormalizationContext = { decks: new Map(), milestones: new Map(), assignees: new Map(), parents: new Map() };
        for (let index = 0; index < rawRecords.length; index++) {
            try {
                normalized.push(await normalizeBulkCreateRecord(rawRecords[index] as BulkCreateRecord, defaults, index, user, normalizationContext));
                emitBulkMutationProgress(startedAt, "normalizing", index + 1);
            }
            catch (error)
            {
                if (isOperationalError(error)) {
                    const category = error.category;
                    const results = preflightOutcomeRecords(rawRecords, [{ index, message: toErrorMessage(error) }]);
                    for (const entry of results) if (Number(entry.index) !== index && entry.status === "definitely_unsent") (entry as Record<string, unknown>).recovery = "No dispatch attempt was made; this record is safe to submit later.";
                    return toStructuredErrorResult(format, "card-bulk-create", category, toErrorMessage(error), { ...getOperationErrorData(error), results });
                }
                normalizationErrors.push({ index, message: toErrorMessage(error) });
            }
        }
        if (normalizationErrors.length) return toStructuredErrorResult(format, "card-bulk-create", "validation_error", normalizationErrors.map(x => x.message).join(" "), { indexedErrors: normalizationErrors, results: preflightOutcomeRecords(rawRecords, normalizationErrors), requestsAttempted: 0 });
        const previewFingerprint = await bulkPreviewFingerprint("card_bulk_create", normalized);
        if (!dryRun) {
            const expectedPreviewFingerprint = args.expectedPreviewFingerprint;
            const malformed = typeof expectedPreviewFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(expectedPreviewFingerprint);
            if (malformed || expectedPreviewFingerprint !== previewFingerprint) {
                const message = malformed
                    ? "expectedPreviewFingerprint is required for apply and must be a SHA-256 fingerprint returned by the matching dry run."
                    : "expectedPreviewFingerprint does not match the normalized bulk-create preview; no cards were dispatched.";
                const results = normalized.map(record => ({
                    index: record.index,
                    correlationKey: record.correlationKey,
                    status: "definitely_unsent",
                    certainty: "definitely_unsent",
                }));
                return toStructuredErrorResult(format, "card-bulk-create", "validation_error", message, {
                    actualPreviewFingerprint: previewFingerprint,
                    recordCount: normalized.length,
                    requestsAttempted: getOperationContext()?.requestsAttempted ?? 0,
                    dispatchRequests: 0,
                    results,
                });
            }
        }
        const results = normalized.map(record => ({ ...publicBulkCreateRecord(record), status: dryRun ? "preview" : "ready", certainty: "not_dispatched" } as Record<string, unknown>));
        const normalizationRequests = getOperationContext()?.requestsAttempted ?? 0;
        const retryEvents: Array<{ index: number; retryAttempt: number; retryAfterMs: number; retryAfterFormat?: "codecks_milliseconds" | "http_date" }> = [];
        const rateLimitEvents: Array<{ index: number; retryAttempt: number; retryAttempted: boolean; retryAfterMs?: number; retryAfterFormat?: "codecks_milliseconds" | "http_date"; retryAfterParseStatus?: RetryAfterParseStatus; retryAfterReason?: string; reason: string }> = [];
        let uniqueRecordsAttempted = 0;
        let consecutive429 = 0;
        let plannedServerRecoveryWaitMs = 0;
        let safeContinuationStartIndex: number | null = null;
        if (!dryRun) for (const record of normalized) {
            uniqueRecordsAttempted += 1;
            let retryAttempt = 0;
            while (true) {
                emitBulkMutationProgress(startedAt, "dispatching", record.index, results, undefined, { recordIndex: record.index + 1, recordCount: normalized.length });
                try {
                    const identity = extractDispatchCardIdentity(unwrapData(await runDispatch("cards/create", record.payload)));
                    results[record.index].status = "created"; results[record.index].certainty = "dispatch_returned"; results[record.index].card = publicCardIdentity(identity);
                    consecutive429 = 0;
                    break;
                } catch (error) {
                    const category = error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error));
                    const errorData = getOperationErrorData(error);
                    const retryAfterMs = typeof errorData.retryAfterMs === "number" ? errorData.retryAfterMs : undefined;
                    const retryAfterFormat = errorData.retryAfterFormat === "codecks_milliseconds" || errorData.retryAfterFormat === "http_date" ? errorData.retryAfterFormat : undefined;
                    const retryAfterParseStatus = errorData.retryAfterParseStatus === "missing" || errorData.retryAfterParseStatus === "valid" || errorData.retryAfterParseStatus === "malformed" || errorData.retryAfterParseStatus === "negative" || errorData.retryAfterParseStatus === "non_finite" || errorData.retryAfterParseStatus === "over_budget" ? errorData.retryAfterParseStatus : undefined;
                    const retryAfterReason = typeof errorData.retryAfterReason === "string" ? errorData.retryAfterReason : undefined;
                    const nextConsecutive429 = category === "rate_limited" ? consecutive429 + 1 : consecutive429;
                    if (category === "rate_limited") consecutive429 = nextConsecutive429;
                    if (category === "rate_limited" && retryAfterMs !== undefined && nextConsecutive429 < BULK_CREATE_MAX_CONSECUTIVE_429 && plannedServerRecoveryWaitMs + retryAfterMs <= MAX_SERVER_COOLDOWN_MS) {
                        retryAttempt += 1;
                        plannedServerRecoveryWaitMs += retryAfterMs;
                        retryEvents.push({ index: record.index, retryAttempt, retryAfterMs, retryAfterFormat });
                        rateLimitEvents.push({ index: record.index, retryAttempt, retryAttempted: true, retryAfterMs, retryAfterFormat, retryAfterParseStatus, retryAfterReason, reason: "Retrying after valid bounded Retry-After." });
                        emitBulkMutationProgress(startedAt, "rate_limited_retrying", record.index, results, undefined, {
                            recordIndex: record.index + 1, recordCount: normalized.length, retryAttempt, retryMax: BULK_CREATE_MAX_CONSECUTIVE_429 - 1,
                            retryAfterMs, retryAfterFormat, retryAfterParseStatus, retryAfterReason, rateLimitError: "Codecks rejected the request with HTTP 429.", consecutive429,
                        });
                        // Only a 429 is explicitly rejected; the shared gate observes Retry-After before retrying.
                        continue;
                    }
                    if (category === "rate_limited") rateLimitEvents.push({
                        index: record.index, retryAttempt, retryAttempted: false, retryAfterMs, retryAfterFormat, retryAfterParseStatus, retryAfterReason,
                        reason: retryAfterParseStatus === "over_budget" ? "Retry-After exceeds the operation recovery budget." : retryAfterParseStatus && retryAfterParseStatus !== "valid" ? "Retry-After could not be used for automatic recovery." : nextConsecutive429 >= BULK_CREATE_MAX_CONSECUTIVE_429 ? "Maximum consecutive HTTP 429 responses reached." : "Retry was not attempted.",
                    });
                    if (category === "rate_limit_queue_aborted") { results[record.index].status = "definitely_unsent"; results[record.index].certainty = "definitely_unsent"; }
                    else { const outcome = classifyMutationOutcome(error); results[record.index].status = outcome; results[record.index].certainty = outcome === "indeterminate" ? "possibly_applied" : "definitely_rejected"; }
                    results[record.index].error = { category, message: toErrorMessage(error), ...errorData };
                    safeContinuationStartIndex = record.index + 1 < rawRecords.length ? record.index + 1 : null;
                    markBulkCreateDefinitelyUnsent(results, record.index);
                    emitBulkMutationProgress(startedAt, `stopped_${category}`, record.index, results, undefined, category === "rate_limited" ? {
                        recordIndex: record.index + 1, recordCount: normalized.length, retryAttempt, retryMax: BULK_CREATE_MAX_CONSECUTIVE_429 - 1,
                        retryAfterMs, retryAfterFormat, retryAfterParseStatus, retryAfterReason, rateLimitError: toErrorMessage(error), consecutive429,
                    } : undefined);
                    break;
                }
            }
            if (results[record.index].status !== "created") break;
            emitBulkMutationProgress(startedAt, "applying", record.index + 1, results);
        }
        const count = (status: string) => results.filter(x => x.status === status).length;
        const operation = getOperationContext();
        const metrics = {
            elapsedMs: Math.max(0, Date.now() - startedAt),
            physicalRequests: operation?.requestsAttempted ?? 0,
            normalizationRequests,
            dispatchRequests: Math.max(0, (operation?.requestsAttempted ?? 0) - normalizationRequests),
            uniqueRecordsAttempted,
            localGateWaitMs: operation?.localGateWaitMs ?? 0,
            serverCooldownWaitMs: operation?.serverCooldownWaitMs ?? 0,
            consecutive429,
            maxConsecutive429: BULK_CREATE_MAX_CONSECUTIVE_429,
            serverRecoveryWaitBudgetMs: MAX_SERVER_COOLDOWN_MS,
            retryEvents,
            rateLimitEvents,
            safeContinuationRange: safeContinuationStartIndex === null ? null : { startIndex: safeContinuationStartIndex, endIndex: rawRecords.length - 1 },
        };
        const totals = { dryRun, count: rawRecords.length, created: count("created"), failed: count("failed"), indeterminate: count("indeterminate"), definitelyUnsent: count("definitely_unsent") };
        const artifact = await writeBulkArtifact("create", { action: "card-bulk-create", createdAt: new Date().toISOString(), ...totals, metrics, ...(dryRun ? { previewFingerprint } : {}), results });
        const exceptionalResults = results.filter(result => result.status !== "created" && result.status !== "preview");
        const data = { ...totals, metrics, ...(dryRun ? { previewFingerprint } : {}), results: exceptionalResults, artifact };
        const lines = ["## Bulk Card Create", "", `Mode: ${dryRun ? "dry-run" : "apply"}`, ...(dryRun ? [`Preview Fingerprint: ${previewFingerprint}`] : []), `Records: ${rawRecords.length}`, `Created: ${data.created}`, `Failed: ${data.failed}`, `Indeterminate: ${data.indeterminate}`, `Definitely Unsent: ${data.definitelyUnsent}`, `Physical Requests: ${metrics.physicalRequests}`, `Local Gate Wait: ${metrics.localGateWaitMs}ms`, `Server Cooldown Wait: ${metrics.serverCooldownWaitMs}ms`, `429 Recovery: ${metrics.retryEvents.length} retry event(s), ${metrics.consecutive429}/${metrics.maxConsecutive429} final consecutive`, `Detailed Results: ${"path" in artifact ? artifact.path : "unavailable"}`, ...(exceptionalResults.length ? ["", ...exceptionalResults.map(x => `- #${Number(x.index) + 1}${x.correlationKey ? ` [${x.correlationKey}]` : ""} ${x.status}/${x.certainty}${x.error && isRecord(x.error) ? ` — ${String(x.error.message)}` : ""}`)] : [])];
        emitBulkMutationProgress(startedAt, "completed", rawRecords.length, results);
        return toStructuredResult(format, "card-bulk-create", lines.join("\n"), data);
        });
    },
});

export const card_bulk_update = tool({
    description: "Preview or apply strict bounded updates including milestone, deck, assignee, effort, priority, tags, Run, and parent changes. Use clearMilestone, clearAssignee, clearEffort, clearRun, or clearParent to remove values. Deck removal (clearDeck) is unavailable and rejected before requests.",
    args: {
        updates: tool.schema.array(tool.schema.object({
            correlationKey: tool.schema.string().min(1).max(200).optional(), cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]),
            title: tool.schema.string().optional(), content: tool.schema.string().optional(), cardType: tool.schema.string().optional(),
            deck: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), milestone: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(),
            assigneeId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), effort: tool.schema.number().optional(), priority: tool.schema.string().optional(),
            clearDeck: tool.schema.boolean().optional().describe("Unavailable: true rejects the entire batch before requests. Codecks returned HTTP 500 for deck removal; use the Codecks UI until the API contract is verified."),
            clearMilestone: tool.schema.boolean().optional().describe("Remove the milestone assignment."),
            clearAssignee: tool.schema.boolean().optional().describe("Remove the assignee only when the card has or is given a deck; unassigned and deckless is not allowed."),
            clearEffort: tool.schema.boolean().optional().describe("Clear the effort estimate."),
            tags: tool.schema.array(tool.schema.string()).optional(), runId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), clearRun: tool.schema.boolean().optional(),
            parentCardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional(), clearParent: tool.schema.boolean().optional(), mode: tool.schema.enum(["replace", "append", "prepend"]).optional(),
        })).min(1).max(100),
        dryRun: tool.schema.boolean().optional(),
        expectedPreviewFingerprint: tool.schema.string().optional().describe("Required for apply: the previewFingerprint returned by the matching dry run."),
        continueOnError: tool.schema.boolean().optional(),
        format: outputFormatArg,
    },
    async execute(args)
    {
        return withOperationContextIfMissing(async () => {
        const format = args.format ?? "text";
        const dryRun = args.dryRun !== false;
        const continueOnError = args.continueOnError !== false;
        const rawRecords = Array.isArray(args.updates) ? args.updates as unknown[] : [];
        const startedAt = Date.now();
        emitBulkMutationProgress(startedAt, "validating", 0);
        const structuralErrors = validateStrictBulkRecords(rawRecords, "update");
        if (structuralErrors.length > 0)
        {
            const indexedErrors = structuralErrors.map((message) => ({ index: Number(message.match(/\[(\d+)\]/)?.[1]), message }));
            return toStructuredErrorResult(format, "card-bulk-update", "validation_error", structuralErrors.join(" "), {
                indexedErrors: structuralErrors,
                invalidRecordCount: new Set(structuralErrors.map((error) => error.match(/\[(\d+)\]/)?.[1])).size,
                requestsAttempted: 0,
                results: preflightOutcomeRecords(rawRecords, "update", indexedErrors),
            });
        }

        const normalized: NormalizedBulkUpdateRecord[] = [];
        const results: Record<string, unknown>[] = [];
        const normalizationContext: BulkUpdateNormalizationContext = { cards: new Map(), runs: new Map() };
        for (let index = 0; index < rawRecords.length; index += 1)
        {
            try
            {
                const value = await normalizeBulkUpdateRecord(rawRecords[index] as BulkUpdateRecord, index, normalizationContext);
                normalized.push(value);
                const normalizedRequested = { target: value.target, updatedFields: value.updatedFields, contentMode: value.mode, ...value.proposed } as Record<string, unknown>;
                results[index] = {
                    index,
                    operation: "update",
                    correlationKey: value.correlationKey,
                    actionKey: actionKeyFor("update", index, value.payload),
                    normalizedRequested,
                    normalizedRequestedFingerprint: normalizedMutationFingerprint(normalizedRequested),
                    dispatchReturned: null,
                    persistedVerified: null,
                    verificationState: dryRun ? "not_applicable" : "not_performed",
                    target: value.target,
                    updatedFields: value.updatedFields,
                    contentMode: value.mode,
                    current: value.current,
                    proposed: value.proposed,
                    status: dryRun ? "preview" : "ready",
                    certainty: "not_dispatched",
                };
                emitBulkMutationProgress(startedAt, "normalizing", index + 1, results);
            }
            catch (error)
            {
                results[index] = {
                    index,
                    cardId: (rawRecords[index] as BulkUpdateRecord).cardId ?? null,
                    status: "invalid",
                    error: { category: classifyApiErrorCategory(toErrorMessage(error)), message: toErrorMessage(error) },
                };
            }
        }

        const invalidRecordCount = results.filter((entry) => entry.status === "invalid").length;
        if (!dryRun && invalidRecordCount > 0)
        {
            for (const entry of results)
            {
                if (entry.status === "ready")
                {
                    entry.status = "definitely_unsent";
                    entry.certainty = "definitely_unsent";
                }
                else if (entry.status === "invalid")
                {
                    entry.status = "failed";
                    entry.certainty = "definitely_rejected";
                }
            }
            return toStructuredErrorResult(format, "card-bulk-update", "validation_error", "Batch normalization failed; no mutations were dispatched.", {
                invalidRecordCount,
                applied: 0,
                failed: invalidRecordCount,
                requestsAttempted: 0,
                results,
            });
        }

        const previewFingerprint = await bulkPreviewFingerprint("card_bulk_update", normalized);
        const normalizationRequests = getOperationContext()?.requestsAttempted ?? 0;
        if (!dryRun)
        {
            const expected = args.expectedPreviewFingerprint;
            const malformed = typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected);
            if (malformed || expected !== previewFingerprint)
            {
                return toStructuredErrorResult(format, "card-bulk-update", "validation_error", malformed
                    ? "expectedPreviewFingerprint is required for apply and must be a SHA-256 fingerprint returned by the matching dry run."
                    : "expectedPreviewFingerprint does not match the normalized bulk-update preview; no cards were dispatched.", {
                    actualPreviewFingerprint: previewFingerprint, recordCount: normalized.length, requestsAttempted: normalizationRequests, dispatchRequests: 0,
                    results: normalized.map(value => ({ index: value.index, correlationKey: value.correlationKey, status: "definitely_unsent", certainty: "definitely_unsent" })),
                });
            }
        }
        const retryEvents: Array<{ index: number; retryAttempt: number; retryAfterMs: number; retryAfterFormat?: "codecks_milliseconds" | "http_date" }> = [];
        const rateLimitEvents: Array<Record<string, unknown>> = [];
        let consecutive429 = 0; let plannedServerRecoveryWaitMs = 0; let uniqueRecordsAttempted = 0; let safeContinuationStartIndex: number | null = null;
        if (!dryRun) for (const value of normalized)
        {
            uniqueRecordsAttempted += 1;
            let retryAttempt = 0;
            while (true) try
            {
                emitBulkMutationProgress(startedAt, "dispatching", value.index, results, undefined, { recordIndex: value.index + 1, recordCount: normalized.length });
                const response = unwrapData(await runDispatch("cards/update", value.payload));
                results[value.index].status = "updated"; results[value.index].certainty = "dispatch_returned"; results[value.index].dispatchReturned = truncateStructuredValue(response).value; consecutive429 = 0;
                break;
            }
            catch (error)
            {
                const category = error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error));
                const errorData = getOperationErrorData(error); const retryAfterMs = typeof errorData.retryAfterMs === "number" ? errorData.retryAfterMs : undefined;
                const retryAfterFormat = errorData.retryAfterFormat === "codecks_milliseconds" || errorData.retryAfterFormat === "http_date" ? errorData.retryAfterFormat : undefined;
                if (category === "rate_limited") consecutive429 += 1;
                else consecutive429 = 0;
                if (category === "rate_limited" && retryAfterMs !== undefined && consecutive429 < BULK_CREATE_MAX_CONSECUTIVE_429 && plannedServerRecoveryWaitMs + retryAfterMs <= MAX_SERVER_COOLDOWN_MS)
                {
                    retryAttempt += 1; plannedServerRecoveryWaitMs += retryAfterMs; retryEvents.push({ index: value.index, retryAttempt, retryAfterMs, retryAfterFormat });
                    rateLimitEvents.push({ index: value.index, retryAttempt, retryAttempted: true, retryAfterMs, retryAfterFormat, reason: "Retrying after valid bounded Retry-After." });
                    emitBulkMutationProgress(startedAt, "rate_limited_retrying", value.index, results, undefined, { recordIndex: value.index + 1, recordCount: normalized.length, retryAttempt, retryMax: BULK_CREATE_MAX_CONSECUTIVE_429 - 1, retryAfterMs, retryAfterFormat, consecutive429 });
                    continue;
                }
                if (category === "rate_limited") rateLimitEvents.push({ index: value.index, retryAttempt, retryAttempted: false, retryAfterMs, retryAfterFormat, reason: "Retry was not attempted." });
                const outcome = category === "rate_limit_queue_aborted" ? "definitely_unsent" : classifyMutationOutcome(error);
                results[value.index].status = outcome; results[value.index].certainty = outcome === "indeterminate" ? "possibly_applied" : outcome === "definitely_unsent" ? "definitely_unsent" : "definitely_rejected";
                results[value.index].error = { category, message: toErrorMessage(error), ...errorData, retried: retryAttempt > 0 };
                const canContinue = outcome === "failed" && category !== "rate_limited" && continueOnError;
                if (canContinue) break;
                if (outcome === "indeterminate") results[value.index].reconciliation = { actionKey: results[value.index].actionKey, retry: "do_not_retry", reason: "The request may have reached Codecks; reconcile before any new write." };
                markDefinitelyUnsent(results, value.index); safeContinuationStartIndex = value.index + 1 < rawRecords.length ? value.index + 1 : null;
                emitBulkMutationProgress(startedAt, `stopped_${category}`, value.index, results); break;
            }
            if (results[value.index].status !== "updated" && !(results[value.index].status === "failed" && continueOnError)) break;
            emitBulkMutationProgress(startedAt, "applying", value.index + 1, results);
        }

        const updated = results.filter((entry) => entry.status === "updated").length;
        const failed = results.filter((entry) => entry.status === "failed" || entry.status === "invalid").length;
        const indeterminate = results.filter((entry) => entry.status === "indeterminate").length;
        const definitelyUnsent = results.filter((entry) => entry.status === "definitely_unsent").length;
        const pending = results.filter((entry) => entry.status === "ready").length;
        const operation = getOperationContext();
        const metrics = { elapsedMs: Math.max(0, Date.now() - startedAt), physicalRequests: operation?.requestsAttempted ?? 0, normalizationRequests, dispatchRequests: Math.max(0, (operation?.requestsAttempted ?? 0) - normalizationRequests), uniqueRecordsAttempted, localGateWaitMs: operation?.localGateWaitMs ?? 0, serverCooldownWaitMs: operation?.serverCooldownWaitMs ?? 0, consecutive429, maxConsecutive429: BULK_CREATE_MAX_CONSECUTIVE_429, serverRecoveryWaitBudgetMs: MAX_SERVER_COOLDOWN_MS, retryEvents, rateLimitEvents, safeContinuationRange: safeContinuationStartIndex === null ? null : { startIndex: safeContinuationStartIndex, endIndex: rawRecords.length - 1 } };
        const artifact = await writeBulkArtifact("update", { action: "card-bulk-update", createdAt: new Date().toISOString(), dryRun, count: rawRecords.length, updated, failed, indeterminate, definitelyUnsent, metrics, ...(dryRun ? { previewFingerprint } : {}), results });
        const exceptionalResults = results.filter(entry => entry.status !== "updated" && entry.status !== "preview");
        const lines = ["## Bulk Card Update", "", `Mode: ${dryRun ? "dry-run" : "apply"}`, ...(dryRun ? [`Preview Fingerprint: ${previewFingerprint}`] : []), `Records: ${rawRecords.length}`, `Updated: ${updated}`, `Failed/Invalid: ${failed}`, `Indeterminate: ${indeterminate}`, `Definitely Unsent: ${definitelyUnsent}`, `Physical Requests: ${metrics.physicalRequests}`, `Local Gate Wait: ${metrics.localGateWaitMs}ms`, `Server Cooldown Wait: ${metrics.serverCooldownWaitMs}ms`, `429 Recovery: ${metrics.retryEvents.length} retry event(s), ${metrics.consecutive429}/${metrics.maxConsecutive429} final consecutive`, `Detailed Results: ${"path" in artifact ? artifact.path : "unavailable"}`, ...exceptionalResults.map(entry => `- #${Number(entry.index) + 1} ${entry.status}/${entry.certainty}`)];
        emitBulkMutationProgress(startedAt, "completed", rawRecords.length, results);
        return toStructuredResult(format, "card-bulk-update", lines.join("\n"), {
            responseSchemaVersion: 1,
            dryRun,
            count: rawRecords.length,
            complete: dryRun ? results.length === rawRecords.length : pending === 0,
            normalizationComplete: results.length === rawRecords.length,
            applyComplete: dryRun ? null : pending === 0,
            invalidRecordCount,
            updated,
            applied: updated,
            failed,
            indeterminate,
            definitelyUnsent,
            pending,
            continueOnError,
            ambiguousMutationsRetried: false,
            metrics,
            ...(dryRun ? { previewFingerprint } : {}),
            results: exceptionalResults,
            artifact,
        });
        });
    },
});
