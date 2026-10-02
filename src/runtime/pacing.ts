import { type RateGateWait, emitBulkMutationProgress, getActiveAbortSignal, noteOperationQueueWait } from "./operation-context";
import { CodecksOperationError } from "./operation-error";

export const RATE_LIMIT = (() =>
{
    const value = Number.parseInt(process.env.CODECKS_RATE_LIMIT ?? "40", 10);
    if (!Number.isFinite(value))
    {
        return 40;
    }
    return Math.max(1, Math.min(40, value));
})();
// Codecks permits 40 physical requests in five seconds. This transport bound is
// deliberately fixed: callers must not configure a longer invisible wait.
export const RATE_WINDOW_MS = 5000;
const requestTimestamps: number[] = [];
// A server-issued Retry-After applies to every request made by this extension
// process, not merely the request that observed the 429.
export let serverCooldownUntil = 0;
const ACCOUNT_SCAN_CONCURRENCY = 2;
const ACCOUNT_SCAN_MAX_QUEUE = 8;
let activeAccountScans = 0;
const accountScanWaiters: Array<{ resolve: (queueWaitMs: number) => void; reject: (error: Error) => void; queuedAt: number; signal?: AbortSignal; onAbort?: () => void }> = [];

export const acquireAccountScanSlot = async (): Promise<number> =>
{
    const signal = getActiveAbortSignal();
    if (signal?.aborted)
    {
        throw new CodecksOperationError("caller_aborted", "Account scan cancelled by caller before it started.", {
            queueWaitMs: 0,
            requestsAttempted: 0,
            recoveryHint: "Retry the narrow search sequentially if it is still needed.",
        });
    }
    if (activeAccountScans < ACCOUNT_SCAN_CONCURRENCY)
    {
        activeAccountScans += 1;
        return 0;
    }
    if (accountScanWaiters.length >= ACCOUNT_SCAN_MAX_QUEUE)
    {
        throw new CodecksOperationError("scan_queue_full", "Account scan queue is full; broad parallel search fan-out was rejected.", {
            queueDepth: accountScanWaiters.length,
            concurrencyLimit: ACCOUNT_SCAN_CONCURRENCY,
            requestsAttempted: 0,
            recoveryHint: "Use one shared-scope bulk preview or run narrow searches sequentially.",
        });
    }

    return new Promise<number>((resolve, reject) =>
    {
        const waiter = { resolve, reject, queuedAt: Date.now(), signal } as typeof accountScanWaiters[number];
        waiter.onAbort = () =>
        {
            const index = accountScanWaiters.indexOf(waiter);
            if (index >= 0) accountScanWaiters.splice(index, 1);
            reject(new CodecksOperationError("caller_aborted", "Account scan cancelled by caller while waiting in the scan queue.", {
                queueWaitMs: Date.now() - waiter.queuedAt,
                requestsAttempted: 0,
                recoveryHint: "Retry the narrow search sequentially if it is still needed.",
            }));
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        accountScanWaiters.push(waiter);
    });
};

export const releaseAccountScanSlot = (): void =>
{
    const waiter = accountScanWaiters.shift();
    if (!waiter)
    {
        activeAccountScans = Math.max(0, activeAccountScans - 1);
        return;
    }
    waiter.signal?.removeEventListener("abort", waiter.onAbort!);
    waiter.resolve(Date.now() - waiter.queuedAt);
};

export const withAccountScanSlot = async <T>(fn: (queueWaitMs: number) => Promise<T>): Promise<T> =>
{
    const queueWaitMs = await acquireAccountScanSlot();
    noteOperationQueueWait(queueWaitMs);
    try
    {
        return await fn(queueWaitMs);
    }
    finally
    {
        releaseAccountScanSlot();
    }
};

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) =>
{
    if (signal?.aborted)
    {
        reject(new CodecksOperationError("caller_aborted", "Operation cancelled by caller."));
        return;
    }

    const timeout = setTimeout(() =>
    {
        signal?.removeEventListener("abort", onAbort);
        resolve();
    }, ms);

    const onAbort = () =>
    {
        clearTimeout(timeout);
        reject(new CodecksOperationError("caller_aborted", "Operation cancelled by caller."));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
});

export const enforceRateLimit = async (): Promise<RateGateWait> =>
{
    const signal = getActiveAbortSignal();
    if (signal?.aborted)
    {
        throw new CodecksOperationError("caller_aborted", "Operation cancelled by caller before Codecks request pacing.", { requestsAttempted: 0 });
    }
    const waitStartedAt = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    let activeWaitDeadline = 0;
    let accumulatedLocalWaitMs = 0;
    let accumulatedServerWaitMs = 0;
    const publishWait = (reason: "local_window" | "server_cooldown") => emitBulkMutationProgress(waitStartedAt, `rate_gate_${reason}`, 0, [], { pacingReason: reason, pacingElapsedMs: Date.now() - waitStartedAt, pacingRemainingMs: Math.max(0, activeWaitDeadline - Date.now()) });
    try { while (true) {
        const now = Date.now();
        while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= RATE_WINDOW_MS) requestTimestamps.shift();
        if (serverCooldownUntil <= now) serverCooldownUntil = 0;
        const localWaitMs = requestTimestamps.length < RATE_LIMIT ? 0 : Math.max(0, RATE_WINDOW_MS - (now - requestTimestamps[0]));
        const cooldownWaitMs = Math.max(0, serverCooldownUntil - now);
        const waitMs = Math.max(localWaitMs, cooldownWaitMs);
        if (waitMs === 0) {
            if (signal?.aborted) throw new CodecksOperationError("caller_aborted", "Operation cancelled by caller before Codecks request dispatch.", { requestsAttempted: 0 });
            requestTimestamps.push(Date.now());
            return { queueWaitMs: Date.now() - waitStartedAt, localWaitMs: accumulatedLocalWaitMs, serverWaitMs: accumulatedServerWaitMs };
        }
        const reason = cooldownWaitMs >= localWaitMs ? "server_cooldown" : "local_window";
        if (reason === "server_cooldown") accumulatedServerWaitMs += waitMs;
        else accumulatedLocalWaitMs += waitMs;
        activeWaitDeadline = now + waitMs;
        publishWait(reason);
        timer = setInterval(() => publishWait(reason), 1000);
        try { await sleep(waitMs, signal); }
        catch (error) {
            if (error instanceof CodecksOperationError && error.category === "caller_aborted") throw new CodecksOperationError("rate_limit_queue_aborted", "Operation cancelled while waiting for Codecks request pacing.", { queueWaitMs: Date.now() - waitStartedAt, recoveryHint: "Retry the untouched operation after the short pacing window." });
            throw error;
        } finally { if (timer) { clearInterval(timer); timer = undefined; } }
    }} finally { if (timer) clearInterval(timer); }
};

export const MAX_SERVER_COOLDOWN_MS = 15_000;
export const BULK_CREATE_MAX_CONSECUTIVE_429 = 3;
export type RetryAfterParseStatus = "missing" | "valid" | "malformed" | "negative" | "non_finite" | "over_budget";
export type RetryAfterFormat = "codecks_milliseconds" | "http_date" | "seconds";
export type RetryAfterParse = { value: number | null; requestedMs?: number; format?: RetryAfterFormat; status: RetryAfterParseStatus; reason?: string; error?: string };
// Codecks returns numeric Retry-After values in milliseconds on genuine 429 responses,
// unlike generic HTTP delay-seconds. Callers for non-429 retry policy must opt into
// standard delay-seconds explicitly.
export const parseRetryAfterMs = (headerValue: string | null, numericFormat: "codecks_milliseconds" | "seconds" = "codecks_milliseconds"): RetryAfterParse =>
{
    if (!headerValue || !headerValue.trim()) return { value: null, status: "missing", reason: "Retry-After was not supplied." };
    const trimmed = headerValue.trim();
    if (/^-/.test(trimmed)) return { value: null, status: "negative", reason: "Retry-After must not be negative.", error: "Retry-After must not be negative." };
    let requestedMs: number;
    let format: RetryAfterFormat;
    // Numeric Codecks 429 values are milliseconds. Round fractional values up so
    // a retry cannot precede the requested instant.
    if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(trimmed)) {
        requestedMs = Math.ceil(Number(trimmed) * (numericFormat === "seconds" ? 1000 : 1));
        format = numericFormat;
    } else if (/^(?:nan|[+-]?(?:inf|infinity))$/i.test(trimmed)) {
        return { value: null, status: "non_finite", reason: "Retry-After is not finite.", error: "Retry-After is not finite." };
    } else {
        const parsed = Date.parse(trimmed);
        if (Number.isNaN(parsed)) return { value: null, status: "malformed", reason: "Retry-After is malformed.", error: "Retry-After is malformed." };
        requestedMs = Math.max(0, parsed - Date.now());
        format = "http_date";
    }
    if (!Number.isFinite(requestedMs)) return { value: null, format, status: "non_finite", reason: "Retry-After is not finite.", error: "Retry-After is not finite." };
    if (requestedMs > MAX_SERVER_COOLDOWN_MS) return { value: null, requestedMs, format, status: "over_budget", reason: "Retry-After exceeds the fifteen-second bounded bulk-create recovery window.", error: "Retry-After exceeds the fifteen-second bounded bulk-create recovery window." };
    return { value: requestedMs, requestedMs, format, status: "valid" };
};

// Only a genuine 429 may affect later calls. Successful and unrelated responses cannot wedge this process.
export const observeServerCooldown = (response: Response): RetryAfterParse =>
{
    const parsed = parseRetryAfterMs(response.headers.get("Retry-After"));
    if (response.status === 429 && parsed.value !== null) serverCooldownUntil = Math.max(serverCooldownUntil, Date.now() + parsed.value);
    return parsed;
};

export const resetRateGate = () => { requestTimestamps.length = 0; serverCooldownUntil = 0; };
export const seedRateGate = (timestamps: number[], cooldownUntil = 0) => { requestTimestamps.splice(0, requestTimestamps.length, ...timestamps); serverCooldownUntil = cooldownUntil; };
export const getRateGateState = () => ({ timestamps: [...requestTimestamps], cooldownUntil: serverCooldownUntil });
