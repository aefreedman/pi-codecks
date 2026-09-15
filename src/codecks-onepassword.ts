import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalHelperError, resolveExternalHelperCredential } from "./codecks-external-helper";
import { OnePasswordState, OnePasswordStateError } from "./codecks-onepassword-state";
import { CodecksCredentialError } from "./codecks-credential-error";

const FAILURE = "Codecks 1Password credential provider configuration is invalid.";
const CHILD_PATH = fileURLToPath(new URL("./integrations/codecks-onepassword-credential-helper.mjs", import.meta.url));
const startupPath = process.env.PATH ?? "";
let resolvedExecutable: string | undefined;
let resolvedOverride: string | undefined;
let state = new OnePasswordState();
let testNow: (() => number) | undefined;
let testResolver: ((request: Request) => Promise<{ token: string; providerId: "onepassword" }>) | undefined;

type Request = Readonly<{ account: string; profileKey?: string; baseUrl?: string; signal: AbortSignal }>;

const fail = (): never => { throw new CodecksCredentialError("credential_configuration_invalid"); };

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
    const override = process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE?.trim();
    if (resolvedExecutable && resolvedOverride === override) return resolvedExecutable;
    resolvedExecutable = undefined;
    resolvedOverride = override;
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
        baseUrl: request.baseUrl ?? process.env.CODECKS_API_BASE ?? null,
        executable,
        secretReference,
        serviceAccountToken: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? null,
    })).digest("hex");

const reference = (): string =>
{
    const value = process.env.PI_CODECKS_ONEPASSWORD_REFERENCE?.trim();
    if (!value) fail();
    return value;
};

export const evictOnePasswordCredentialGeneration = (generation: unknown): void => state.evict(generation);

export const resolveOnePasswordCredential = async (request: Request): Promise<{ token: string; providerId: "onepassword"; credentialGeneration?: string }> =>
{
    const executable = resolveOnePasswordExecutable();
    const secretReference = reference();
    const key = privateConfigurationKey(request, executable, secretReference);
    const ttlMs = reuseTtlMs();
    const scope = createHash("sha256").update(JSON.stringify([request.account, request.profileKey ?? null])).digest("hex");
    // Capture effective environment now; asynchronous work must never adopt a later configuration.
    const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE: executable, PI_CODECKS_ONEPASSWORD_REFERENCE: secretReference };
    const resolver = testResolver;
    try
    {
        return await state.resolve(key, scope, ttlMs, request.signal, signal => resolver
            ? resolver({ ...request, signal })
            : resolveExternalHelperCredential({ ...request, signal }, {
                modulePath: CHILD_PATH, environment, providerId: "onepassword", trustedBuiltInErrorEnvelope: true,
            }));
    }
    catch (error)
    {
        if (error instanceof CodecksCredentialError) throw error;
        if (error instanceof OnePasswordStateError)
        {
            switch (error.credentialCategory)
            {
                case "credential_rate_limited": case "credential_helper_timeout": case "credential_cancelled": case "credential_capacity":
                    throw new CodecksCredentialError(error.credentialCategory);
            }
        }
        if (error instanceof ExternalHelperError)
        {
            if (error.credentialCategory === "credential_rate_limited") throw new CodecksCredentialError("credential_rate_limited");
            const categories = { configuration: "credential_configuration_invalid", unavailable: "credential_helper_unavailable",
                protocol: "credential_helper_protocol_error", timedOut: "credential_helper_timeout", cancelled: "credential_cancelled" } as const;
            throw new CodecksCredentialError(categories[error.kind]);
        }
        // Never transport an unknown helper diagnostic or infer authentication/permission from exit status.
        throw new CodecksCredentialError("credential_helper_unavailable");
    }
};

export const __onepasswordTest = {
    canonicalExecutable,
    resolveOnePasswordExecutable,
    resetExecutable: (): void => { resolvedExecutable = undefined; },
    childPath: CHILD_PATH,
    failure: FAILURE,
    resetProcessLocalState: (): void => state.clear(),
    evictOnePasswordCredentialGeneration,
    getProcessLocalState: () => state.counts(),
    setLifecycleDependenciesForTests: (input?: { now?: () => number; resolve?: (request: Request) => Promise<{ token: string; providerId: "onepassword" }> }) => {
        state.clear(); testNow = input?.now; testResolver = input?.resolve;
        state = new OnePasswordState({ now: () => (testNow ?? Date.now)() });
    },
    resetLifecycleDependenciesForTests: () => { state.clear(); testNow = undefined; testResolver = undefined; state = new OnePasswordState(); },

};
