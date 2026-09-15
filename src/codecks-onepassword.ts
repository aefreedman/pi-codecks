import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExternalHelperCredential } from "./codecks-external-helper";

const FAILURE = "Codecks 1Password credential provider configuration is invalid.";
const CHILD_PATH = fileURLToPath(new URL("./integrations/codecks-onepassword-credential-helper.mjs", import.meta.url));
const startupPath = process.env.PATH ?? "";
let resolvedExecutable: string | undefined;
const MAX_PROCESS_LOCAL_ENTRIES = 64;
const UNKNOWN_RATE_LIMIT_BACKOFF_MS = 60_000;

type CachedCredential = { token: string; expiresAt: number; generation: string };
type Cooldown = { until: number };
const credentialCache = new Map<string, CachedCredential>();
let nextCredentialGeneration = 0;
const resolvingCredentials = new Map<string, Promise<{ token: string; providerId: "onepassword" }>>();
const cooldowns = new Map<string, Cooldown>();
let testNow: (() => number) | undefined;
let testResolver: ((request: Request) => Promise<{ token: string; providerId: "onepassword" }>) | undefined;

type Request = Readonly<{ account: string; profileKey?: string; signal: AbortSignal }>;

const fail = (): never => { throw new Error(FAILURE); };

const canonicalExecutable = (candidate: string): string | undefined =>
{
    try
    {
        if (!isAbsolute(candidate) || !statSync(candidate).isFile()) return undefined;
        accessSync(candidate, constants.X_OK);
        return realpathSync(candidate);
    }
    catch { return undefined; }
};

const candidatesForEntry = (entry: string): string[] =>
{
    if (!entry) return [];
    if (process.platform !== "win32") return [join(entry, "op")];
    const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
        .split(";").filter(Boolean);
    return extensions.map((extension) => join(entry, `op${extension.toLowerCase()}`));
};

/** Resolves only explicit startup PATH entries; empty entries never mean cwd. */
export const resolveOnePasswordExecutable = (): string =>
{
    if (resolvedExecutable) return resolvedExecutable;
    const override = process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE?.trim();
    if (override)
    {
        resolvedExecutable = canonicalExecutable(override) ?? fail();
        return resolvedExecutable;
    }

    const matches = new Set<string>();
    for (const entry of startupPath.split(process.platform === "win32" ? ";" : ":"))
    {
        for (const candidate of candidatesForEntry(entry.trim()))
        {
            const resolved = canonicalExecutable(candidate);
            if (resolved) matches.add(resolved);
        }
    }
    if (matches.size !== 1) fail();
    resolvedExecutable = [...matches][0];
    return resolvedExecutable;
};

class OnePasswordCredentialError extends Error
{
    constructor(readonly credentialCategory: "credential_rate_limited", readonly retryable = true)
    {
        super("1Password rate-limited credential retrieval. Wait before retrying.");
        this.name = "OnePasswordCredentialError";
    }
}

const reuseTtlMs = (): number =>
{
    const raw = process.env.CODECKS_ONEPASSWORD_REUSE_TTL_MS;
    if (raw === undefined || raw.trim() === "") return 0;
    if (!/^\d+$/.test(raw.trim())) fail();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 0 || value > 300_000) fail();
    return value;
};

const privateConfigurationKey = (request: Request, executable: string, secretReference: string): string =>
    createHash("sha256").update(JSON.stringify({
        account: request.account,
        profileKey: request.profileKey ?? null,
        baseUrl: process.env.CODECKS_API_BASE ?? null,
        executable,
        secretReference,
        serviceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? null,
    })).digest("hex");

const evictOldest = <T>(entries: Map<string, T>): void =>
{
    while (entries.size >= MAX_PROCESS_LOCAL_ENTRIES) entries.delete(entries.keys().next().value!);
};

const awaitForCaller = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> =>
{
    if (signal.aborted) return Promise.reject(new Error("Codecks credential helper cancelled."));
    return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(new Error("Codecks credential helper cancelled."));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
};

const reference = (): string =>
{
    const value = process.env.PI_CODECKS_ONEPASSWORD_REFERENCE?.trim();
    if (!value) fail();
    return value;
};

export const evictOnePasswordCredentialGeneration = (generation: unknown): void =>
{
    if (typeof generation !== "string") return;
    for (const [key, entry] of credentialCache)
    {
        if (entry.generation === generation) credentialCache.delete(key);
    }
};

export const resolveOnePasswordCredential = async (request: Request): Promise<{ token: string; providerId: "onepassword"; credentialGeneration?: string }> =>
{
    const executable = resolveOnePasswordExecutable();
    const secretReference = reference();
    const key = privateConfigurationKey(request, executable, secretReference);
    const now = (testNow ?? Date.now)();
    const cooldown = cooldowns.get(key);
    if (cooldown && cooldown.until > now) throw new OnePasswordCredentialError("credential_rate_limited");
    if (cooldown) cooldowns.delete(key);

    const ttlMs = reuseTtlMs();
    const cached = credentialCache.get(key);
    if (ttlMs > 0 && cached && cached.expiresAt > now) return { token: cached.token, providerId: "onepassword", credentialGeneration: cached.generation };
    if (cached) credentialCache.delete(key);

    const resolve = async (): Promise<{ token: string; providerId: "onepassword" }> => {
        const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE: executable, PI_CODECKS_ONEPASSWORD_REFERENCE: secretReference };
        try {
            const credential = testResolver
                ? await testResolver({ ...request, signal: ttlMs > 0 ? new AbortController().signal : request.signal })
                : await resolveExternalHelperCredential({ ...request, signal: ttlMs > 0 ? new AbortController().signal : request.signal }, {
                    modulePath: CHILD_PATH, environment, providerId: "onepassword", trustedBuiltInErrorEnvelope: true,
                });
            const result = { token: credential.token, providerId: "onepassword" as const, credentialGeneration: `${key}:${++nextCredentialGeneration}` };
            if (ttlMs > 0) { evictOldest(credentialCache); credentialCache.set(key, { token: result.token, expiresAt: (testNow ?? Date.now)() + ttlMs, generation: result.credentialGeneration }); }
            return result;
        } catch (error) {
            if (typeof error === "object" && error !== null && (error as { credentialCategory?: unknown }).credentialCategory === "credential_rate_limited") {
                evictOldest(cooldowns); cooldowns.set(key, { until: Date.now() + UNKNOWN_RATE_LIMIT_BACKOFF_MS });
            }
            throw error;
        } finally { resolvingCredentials.delete(key); }
    };
    if (ttlMs === 0) return resolve();
    const shared = resolvingCredentials.get(key) ?? (() => { const created = resolve(); resolvingCredentials.set(key, created); return created; })();
    return awaitForCaller(shared, request.signal);
};

export const __onepasswordTest = {
    canonicalExecutable,
    resolveOnePasswordExecutable,
    resetExecutable: (): void => { resolvedExecutable = undefined; },
    childPath: CHILD_PATH,
    failure: FAILURE,
    resetProcessLocalState: (): void => { credentialCache.clear(); resolvingCredentials.clear(); cooldowns.clear(); nextCredentialGeneration = 0; },
    evictOnePasswordCredentialGeneration,
    getProcessLocalState: () => ({ cacheEntries: credentialCache.size, cooldownEntries: cooldowns.size }),
    seedCachedCredentialForTests: (key: string, generation: string) => { credentialCache.set(key, { token: "inert-test-token", expiresAt: Number.MAX_SAFE_INTEGER, generation }); },
    cachedGenerationsForTests: () => [...credentialCache.values()].map((entry) => entry.generation),
    setLifecycleDependenciesForTests: (input?: { now?: () => number; resolve?: (request: Request) => Promise<{ token: string; providerId: "onepassword" }> }) => { testNow = input?.now; testResolver = input?.resolve; },
    resetLifecycleDependenciesForTests: () => { testNow = undefined; testResolver = undefined; },
};
