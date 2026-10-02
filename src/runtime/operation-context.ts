import { type CodecksConfig } from "./types";
import { AsyncLocalStorage } from "node:async_hooks";

export type BulkMutationProgress = {
    stage: string;
    elapsedMs: number;
    recordsProcessed: number;
    requestsAttempted: number;
    queueWaitMs: number;
    localGateWaitMs: number;
    serverCooldownWaitMs: number;
    created: number;
    updated: number;
    succeeded: number;
    failed: number;
    definitelyUnsent: number;
    pacingReason?: "local_window" | "server_cooldown";
    pacingElapsedMs?: number;
    pacingRemainingMs?: number;
    recordIndex?: number;
    recordCount?: number;
    retryAttempt?: number;
    retryMax?: number;
    retryAfterMs?: number;
    retryAfterFormat?: "codecks_milliseconds" | "http_date";
    retryAfterParseStatus?: "missing" | "valid" | "malformed" | "negative" | "non_finite" | "over_budget";
    retryAfterReason?: string;
    rateLimitError?: string;
    consecutive429?: number;
};

export type OperationContext = {
    onBulkMutationProgress?: (progress: BulkMutationProgress) => void;
    requestsAttempted: number;
    requestsDispatched: number;
    queueWaitMs: number;
    localGateWaitMs: number;
    serverCooldownWaitMs: number;
    credentialConfigPromise?: Promise<CodecksConfig>;
    profileKey?: string;
    progressSnapshot?: { startedAt: number; stage: string; recordsProcessed: number; results: Record<string, unknown>[]; rateLimit?: Pick<BulkMutationProgress, "recordIndex" | "recordCount" | "retryAttempt" | "retryMax" | "retryAfterMs" | "retryAfterFormat" | "retryAfterParseStatus" | "retryAfterReason" | "rateLimitError" | "consecutive429"> };
};

const abortSignalStorage = new AsyncLocalStorage<AbortSignal | undefined>();
const workspaceRootStorage = new AsyncLocalStorage<string | undefined>();
const operationContextStorage = new AsyncLocalStorage<OperationContext | undefined>();

export const getActiveAbortSignal = (): AbortSignal | undefined => abortSignalStorage.getStore();
export const getActiveWorkspaceRoot = (): string => workspaceRootStorage.getStore() ?? process.cwd();
export const getOperationContext = (): OperationContext | undefined => operationContextStorage.getStore();

const createOperationContext = (onBulkMutationProgress?: (progress: BulkMutationProgress) => void, profileKey?: string): OperationContext => ({ onBulkMutationProgress, profileKey, requestsAttempted: 0, requestsDispatched: 0, queueWaitMs: 0, localGateWaitMs: 0, serverCooldownWaitMs: 0 });

export const runWithAbortSignal = async <T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
    workspaceRoot?: string,
    onBulkMutationProgress?: (progress: BulkMutationProgress) => void,
    profileKey?: string,
): Promise<T> => abortSignalStorage.run(signal, () => workspaceRootStorage.run(workspaceRoot, () => operationContextStorage.run(createOperationContext(onBulkMutationProgress, profileKey), fn)));

export const withOperationContextIfMissing = <T>(fn: () => Promise<T>): Promise<T> =>
    getOperationContext() ? fn() : operationContextStorage.run(createOperationContext(), fn);

export const noteOperationQueueWait = (queueWaitMs: number): void =>
{
    const context = getOperationContext();
    if (!context) return;
    context.queueWaitMs += queueWaitMs;
};

export type RateGateWait = { queueWaitMs: number; localWaitMs: number; serverWaitMs: number };
export const noteOperationRequest = (wait: RateGateWait): void =>
{
    const context = getOperationContext();
    if (!context) return;
    context.requestsAttempted += 1;
    context.queueWaitMs += wait.queueWaitMs;
    context.localGateWaitMs += wait.localWaitMs;
    context.serverCooldownWaitMs += wait.serverWaitMs;
};

export const emitBulkMutationProgress = (
    startedAt: number,
    stage: string,
    recordsProcessed: number,
    results: Record<string, unknown>[] = [],
    pacing?: Pick<BulkMutationProgress, "pacingReason" | "pacingElapsedMs" | "pacingRemainingMs">,
    rateLimit?: NonNullable<OperationContext["progressSnapshot"]>["rateLimit"],
): void =>
{
    const context = getOperationContext();
    if (!context?.onBulkMutationProgress) return;
    if (!pacing) context.progressSnapshot = { startedAt, stage, recordsProcessed, results, rateLimit };
    const snapshot = pacing ? context.progressSnapshot : undefined;
    const effectiveStartedAt = snapshot?.startedAt ?? startedAt;
    const effectiveStage = pacing ? `${snapshot?.stage ?? stage}:${stage}` : stage;
    const effectiveRecordsProcessed = snapshot?.recordsProcessed ?? recordsProcessed;
    const effectiveResults = snapshot?.results ?? results;
    try
    {
        context.onBulkMutationProgress({
            stage: effectiveStage,
            elapsedMs: Math.max(0, Date.now() - effectiveStartedAt),
            recordsProcessed: effectiveRecordsProcessed,
            requestsAttempted: context.requestsAttempted,
            queueWaitMs: context.queueWaitMs,
            localGateWaitMs: context.localGateWaitMs,
            serverCooldownWaitMs: context.serverCooldownWaitMs,
            created: effectiveResults.filter((entry) => entry.status === "created").length,
            updated: effectiveResults.filter((entry) => entry.status === "updated").length,
            succeeded: effectiveResults.filter((entry) => entry.status === "created" || entry.status === "updated").length,
            failed: effectiveResults.filter((entry) => entry.status === "failed").length,
            definitelyUnsent: effectiveResults.filter((entry) => entry.status === "definitely_unsent").length,
            ...(snapshot?.rateLimit ?? rateLimit),
            ...pacing,
        });
    }
    catch
    {
        // UI updates are best-effort and must never alter the tool result.
    }
};
