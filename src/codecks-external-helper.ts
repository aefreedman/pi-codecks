import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

export const EXTERNAL_HELPER_PROTOCOL_VERSION = 1;
export const EXTERNAL_HELPER_SERVICE = "codecks";
export const EXTERNAL_HELPER_TIMEOUT_MS = 15_000;
export const EXTERNAL_HELPER_MAX_REQUEST_BYTES = 4 * 1024;
export const EXTERNAL_HELPER_MAX_STDOUT_BYTES = 16 * 1024;
export const EXTERNAL_HELPER_MAX_STDERR_BYTES = 16 * 1024;

type HelperRequest = Readonly<{
    account: string;
    profileKey?: string;
    signal: AbortSignal;
}>;

type HelperCredential = Readonly<{
    token: string;
    providerId: "external-helper" | "onepassword";
}>;

type SpawnProcess = (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
) => ChildProcessWithoutNullStreams;

type ScheduledTimer = { unref?: () => void };
type TerminationOptions = Readonly<{
    platform?: NodeJS.Platform;
    killProcess?: (pid: number, signal: NodeJS.Signals) => boolean;
    spawnTaskkill?: SpawnProcess;
    schedule?: (callback: () => void, delayMs: number) => ScheduledTimer;
    cancelSchedule?: (timer: ScheduledTimer) => void;
    escalationMs?: number;
}>;

type ExternalHelperOptions = Readonly<{
    modulePath?: string | undefined;
    timeoutMs?: number;
    maxRequestBytes?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    spawnProcess?: SpawnProcess;
    validateModule?: (modulePath: string) => Promise<void>;
    termination?: TerminationOptions;
    /** Private built-in providers may supply a sanitized trusted environment. */
    environment?: NodeJS.ProcessEnv;
    providerId?: "external-helper" | "onepassword";
}>;

const FAILURE = Object.freeze({
    configuration: "External Codecks credential helper configuration is invalid.",
    unavailable: "External Codecks credential helper is unavailable.",
    protocol: "External Codecks credential helper returned an invalid response.",
    timedOut: "External Codecks credential helper timed out.",
    cancelled: "External Codecks credential helper cancelled.",
});

type FailureKind = keyof typeof FAILURE;

class ExternalHelperError extends Error
{
    constructor(readonly kind: FailureKind)
    {
        super(FAILURE[kind]);
        this.name = "ExternalHelperError";
    }
}

const fail = (kind: FailureKind): never => { throw new ExternalHelperError(kind); };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isCodecksCredentialEnvironmentKey = (key: string): boolean =>
{
    const normalized = key.toUpperCase();
    return /^CODECKS_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF)$/.test(normalized)
        || /^CODECKS_PROFILE_[A-Z0-9_]+_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF)$/.test(normalized)
        || ["CODECKS_PROFILE", "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_CREDENTIAL_HELPER_MODULE"].includes(normalized);
};

const sanitizeHelperEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
{
    const sanitized: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(environment))
    {
        if (!isCodecksCredentialEnvironmentKey(key)) sanitized[key] = value;
    }
    return sanitized;
};

const validateHelperModule = async (modulePath: string): Promise<void> =>
{
    if (!isAbsolute(modulePath) || ![".js", ".mjs"].includes(extname(modulePath).toLowerCase()))
    {
        fail("configuration");
    }

    try
    {
        if (!(await stat(modulePath)).isFile())
        {
            fail("configuration");
        }
    }
    catch (error)
    {
        if (error instanceof ExternalHelperError) throw error;
        fail("configuration");
    }
};

const makeRequest = (request: HelperRequest, maxRequestBytes: number): string =>
{
    const payload: Record<string, unknown> = {
        version: EXTERNAL_HELPER_PROTOCOL_VERSION,
        service: EXTERNAL_HELPER_SERVICE,
        account: request.account,
    };
    if (request.profileKey) payload.profile = request.profileKey;

    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > maxRequestBytes) fail("configuration");
    return encoded;
};

const parseResponse = (stdout: Buffer): string =>
{
    const text = stdout.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(stdout)) fail("protocol");

    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { fail("protocol"); }

    if (!isRecord(parsed)
        || Object.keys(parsed).length !== 2
        || parsed.version !== EXTERNAL_HELPER_PROTOCOL_VERSION
        || typeof parsed.credential !== "string"
        || !parsed.credential.trim())
    {
        fail("protocol");
    }

    return (parsed as Record<string, unknown>).credential as string;
};

/**
 * Starts best-effort termination and returns a cleanup function. It never
 * waits for a child or taskkill process: callers always retain a bounded path
 * to settlement even when a hostile process implementation throws or stalls.
 */
const terminateProcessTree = (
    child: ChildProcessWithoutNullStreams,
    options: TerminationOptions = {},
): (() => void) =>
{
    const directFallback = (): void => { try { child.kill("SIGTERM"); } catch { /* already gone or hostile fake */ } };
    const platform = options.platform ?? process.platform;
    const killProcess = options.killProcess ?? process.kill;
    const spawnTaskkill = options.spawnTaskkill ?? spawn as unknown as SpawnProcess;
    const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
    let forceTimer: ScheduledTimer | undefined;
    let cleaned = false;
    const cleanup = (): void =>
    {
        if (cleaned) return;
        cleaned = true;
        if (forceTimer) cancelSchedule(forceTimer);
        forceTimer = undefined;
    };

    // Always clear an escalation timer when the primary child closes, even if
    // close races synchronously with kill(). This listener is intentionally retained.
    try { child.on("close", cleanup); } catch { /* hostile fake cannot block caller settlement */ }

    const pid = child.pid;
    if (platform === "win32" && pid && pid > 0)
    {
        try
        {
            const killer = spawnTaskkill("taskkill", ["/pid", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
                shell: false,
            });
            // Keep an error sink attached: taskkill can emit after the caller settled.
            killer.on("error", directFallback);
            killer.on("close", (code: number | null) => { if (code !== 0) directFallback(); });
            try { killer.unref(); } catch { /* hostile fake */ }
            return cleanup;
        }
        catch
        {
            directFallback();
            return cleanup;
        }
    }

    if (pid && pid > 0)
    {
        try
        {
            if (killProcess(-pid, "SIGTERM") !== false)
            {
                // killProcess() may synchronously emit close through a hostile
                // fake. Do not arm an escalation after that close was observed.
                if (!cleaned)
                {
                    forceTimer = schedule(() =>
                    {
                        try { killProcess(-pid, "SIGKILL"); } catch { /* process already exited */ }
                    }, options.escalationMs ?? 250);
                    try { forceTimer.unref?.(); } catch { /* hostile timer fake */ }
                }
                return cleanup;
            }
        }
        catch
        {
            // Fall through to direct termination when process-group termination is unavailable.
        }
    }

    directFallback();
    return cleanup;
};

/**
 * Runs a trusted local Node helper. Every externally observable error is a
 * fixed category: helper configuration, paths, child output, and stderr stay
 * out of model-visible failures.
 */
export const resolveExternalHelperCredential = async (
    request: HelperRequest,
    options: ExternalHelperOptions = {},
): Promise<HelperCredential> =>
{
    if (request.signal.aborted) fail("cancelled");

    const modulePath = options.modulePath ?? process.env.CODECKS_CREDENTIAL_HELPER_MODULE;
    if (!modulePath) fail("configuration");
    await (options.validateModule ?? validateHelperModule)(modulePath);
    if (request.signal.aborted) fail("cancelled");

    const timeoutMs = options.timeoutMs ?? EXTERNAL_HELPER_TIMEOUT_MS;
    const maxStdoutBytes = options.maxStdoutBytes ?? EXTERNAL_HELPER_MAX_STDOUT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? EXTERNAL_HELPER_MAX_STDERR_BYTES;
    const input = makeRequest(request, options.maxRequestBytes ?? EXTERNAL_HELPER_MAX_REQUEST_BYTES);
    const spawnProcess = options.spawnProcess ?? spawn as unknown as SpawnProcess;

    return new Promise<HelperCredential>((resolve, reject) =>
    {
        let child: ChildProcessWithoutNullStreams;
        let settled = false;
        let stopping = false;
        let stdinFinished = false;
        let stdoutBytes = 0;
        let stderrBytes = 0;
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timer: NodeJS.Timeout | undefined;
        let cleanupTermination: (() => void) | undefined;

        const settle = (error?: ExternalHelperError, credential?: HelperCredential): void =>
        {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            request.signal.removeEventListener("abort", onAbort);
            child?.removeListener("close", onClose);
            child?.stdout?.removeListener("data", onStdout);
            child?.stderr?.removeListener("data", onStderr);
            // Do not remove child/stdin/stdout/stderr error listeners. EventEmitter
            // treats a later unhandled "error" as a host crash; these sinks remain
            // intentionally after terminal settlement.
            stdout.length = 0;
            stderr.length = 0;
            if (error) reject(error);
            else resolve(credential!);
        };

        const stop = (kind: FailureKind): void =>
        {
            if (settled || stopping) return;
            // Latch first: kill() can synchronously re-enter close/error handlers.
            stopping = true;
            cleanupTermination = terminateProcessTree(child, options.termination);
            settle(new ExternalHelperError(kind));
        };
        const onAbort = (): void => stop("cancelled");
        const onChildError = (): void => { if (!settled && !stopping) stop("unavailable"); };
        const onStreamError = (): void => { if (!settled && !stopping) stop("unavailable"); };
        const onStdout = (chunk: Buffer | string): void =>
        {
            if (settled || stopping) return;
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            stdoutBytes += data.length;
            if (stdoutBytes > maxStdoutBytes) { stop("protocol"); return; }
            stdout.push(data);
        };
        const onStderr = (chunk: Buffer | string): void =>
        {
            if (settled || stopping) return;
            // Capture only a bounded prefix, then discard it at settlement; stderr is never public evidence.
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            const remaining = maxStderrBytes - stderrBytes;
            if (remaining > 0) stderr.push(data.subarray(0, remaining));
            stderrBytes += data.length;
            if (stderrBytes > maxStderrBytes) stop("unavailable");
        };
        const onClose = (code: number | null): void =>
        {
            cleanupTermination?.();
            if (settled || stopping) return;
            if (code !== 0 || !stdinFinished)
            {
                settle(new ExternalHelperError("unavailable"));
                return;
            }
            try
            {
                settle(undefined, { token: parseResponse(Buffer.concat(stdout)), providerId: options.providerId ?? "external-helper" });
            }
            catch (error)
            {
                settle(error instanceof ExternalHelperError ? error : new ExternalHelperError("protocol"));
            }
        };

        try
        {
            child = spawnProcess(process.execPath, [modulePath], {
                cwd: process.cwd(),
                env: sanitizeHelperEnvironment(options.environment ?? process.env),
                shell: false,
                detached: process.platform !== "win32",
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            });
        }
        catch
        {
            reject(new ExternalHelperError("unavailable"));
            return;
        }

        // Attach permanent error sinks before any write. A synchronous abort
        // during spawn is observed by the immediate recheck below.
        child.on("error", onChildError);
        child.on("close", onClose);
        child.stdout.on("data", onStdout);
        child.stderr.on("data", onStderr);
        child.stdin.on("error", onStreamError);
        child.stdout.on("error", onStreamError);
        child.stderr.on("error", onStreamError);
        request.signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => stop("timedOut"), timeoutMs);
        timer.unref();

        if (request.signal.aborted)
        {
            onAbort();
            return;
        }

        try
        {
            child.stdin.end(input, (error?: Error | null) =>
            {
                if (error) onStreamError();
                else if (!settled && !stopping) stdinFinished = true;
            });
        }
        catch
        {
            onStreamError();
        }
    });
};

export const __externalHelperTest = {
    FAILURE,
    sanitizeHelperEnvironment,
    parseResponse,
    terminateProcessTree,
};
