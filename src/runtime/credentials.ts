import { getActiveAbortSignal, getOperationContext } from "./operation-context";
import { CodecksOperationError } from "./operation-error";
import { type CodecksConfig, type CodecksCredential, type CodecksCredentialProvider } from "./types";
import { resolveExternalHelperCredential } from "../codecks-external-helper";
import { resolveOnePasswordCredential } from "../codecks-onepassword";

export const DEFAULT_BASE_URL = "https://api.codecks.io";
export const normalizeProfileKey = (value: string | undefined): string | undefined =>
{
    if (!value)
    {
        return undefined;
    }

    const trimmed = value.trim();
    if (!trimmed)
    {
        return undefined;
    }

    if (!/^[a-z0-9_-]+$/i.test(trimmed))
    {
        throw new Error("Invalid CODECKS_PROFILE value. Use letters, numbers, '-', or '_'.");
    }

    return trimmed;
};

export const toProfileSegment = (profileKey: string): string => profileKey.replace(/[^a-z0-9]/gi, "_").toUpperCase();

export const getProfileEnv = (profileKey: string, suffix: string): string | undefined =>
{
    const key = `CODECKS_PROFILE_${toProfileSegment(profileKey)}_${suffix}`;
    return process.env[key];
};

export const firstNonEmpty = (...values: Array<string | undefined | null>): string | undefined =>
{
    for (const value of values)
    {
        const trimmed = value?.trim();
        if (trimmed)
        {
            return trimmed;
        }
    }
    return undefined;
};

export const throwUnsupportedTokenRef = (profileKey: string): never =>
{
    throw new Error(
        `Codecks profile '${profileKey}' uses a TOKEN_REF/TOKEN_OP_REF value, which is not supported by the environment provider. `
        + "Select CODECKS_CREDENTIAL_PROVIDER=onepassword or set CODECKS_TOKEN / CODECKS_PROFILE_<PROFILE>_TOKEN.",
    );
};

export type CodecksBaseConfig = {
    account: string;
    baseUrl: string;
    profileKey?: string;
};

export const getBaseConfig = (): CodecksBaseConfig =>
{
    const profileKey = normalizeProfileKey(getOperationContext()?.profileKey ?? process.env.CODECKS_PROFILE ?? "ORG")?.toUpperCase();
    if (profileKey !== "ORG" && profileKey !== "PERSONAL") throw new Error("Codecks profile must be ORG or PERSONAL.");
    const profileAccount = profileKey
        ? firstNonEmpty(getProfileEnv(profileKey, "ACCOUNT"), getProfileEnv(profileKey, "SUBDOMAIN"))
        : undefined;
    const account = firstNonEmpty(profileAccount, process.env.CODECKS_ACCOUNT, process.env.CODECKS_SUBDOMAIN);
    const profileBaseUrl = profileKey ? firstNonEmpty(getProfileEnv(profileKey, "API_BASE")) : undefined;
    const baseUrl = firstNonEmpty(profileBaseUrl, process.env.CODECKS_API_BASE, DEFAULT_BASE_URL) ?? DEFAULT_BASE_URL;

    if (!account)
    {
        if (profileKey && profileKey !== "ORG")
        {
            throw new Error(`Missing Codecks account for profile '${profileKey}'. Set CODECKS_PROFILE_${toProfileSegment(profileKey)}_ACCOUNT.`);
        }
        throw new Error("Missing Codecks account. Set CODECKS_ACCOUNT (or CODECKS_SUBDOMAIN), or configure CODECKS_PROFILE.");
    }

    return { account, baseUrl, profileKey };
};

export const environmentCredentialProvider: CodecksCredentialProvider = {
    id: "environment",
    async resolve({ profileKey }): Promise<CodecksCredential>
    {
        const profileTokenOpRef = profileKey ? firstNonEmpty(getProfileEnv(profileKey, "TOKEN_OP_REF"), getProfileEnv(profileKey, "TOKEN_REF")) : undefined;
        const profileTokenDirect = profileKey ? firstNonEmpty(getProfileEnv(profileKey, "TOKEN"), getProfileEnv(profileKey, "API_TOKEN")) : undefined;
        const globalToken = firstNonEmpty(process.env.CODECKS_TOKEN, process.env.CODECKS_API_TOKEN);
        if (profileTokenOpRef)
        {
            throwUnsupportedTokenRef(profileKey ?? "default");
        }

        const token = firstNonEmpty(profileTokenDirect, profileKey === "PERSONAL" ? undefined : globalToken);
        if (!token)
        {
            if (profileKey && profileKey !== "ORG")
            {
                throw new Error(`Missing Codecks token for profile '${profileKey}'. Set CODECKS_PROFILE_${toProfileSegment(profileKey)}_TOKEN.`);
            }
            throw new Error("Missing Codecks credentials. Set CODECKS_TOKEN (or CODECKS_API_TOKEN) and CODECKS_ACCOUNT (subdomain), or configure CODECKS_PROFILE.");
        }

        return { token, providerId: "environment" };
    },
};

export const getCredentialProvider = (): CodecksCredentialProvider =>
{
    const selector = firstNonEmpty(process.env.CODECKS_CREDENTIAL_PROVIDER);
    if (!selector || selector === "environment")
    {
        return environmentCredentialProvider;
    }

    if (selector === "onepassword")
    {
        return {
            id: "onepassword",
            async resolve(request): Promise<CodecksCredential>
            {
                return resolveOnePasswordCredential(request);
            },
        };
    }

    if (selector === "external-helper")
    {
        return {
            id: "external-helper",
            async resolve(request): Promise<CodecksCredential>
            {
                const credential = await resolveExternalHelperCredential(request);
                return { token: credential.token, providerId: credential.providerId };
            },
        };
    }

    throw new Error("Unsupported Codecks credential provider. Set CODECKS_CREDENTIAL_PROVIDER=environment, onepassword, or external-helper.");
};

let testCredentialProvider: CodecksCredentialProvider | undefined;

export const resolveAuthenticatedConfig = async (): Promise<CodecksConfig> =>
{
    const provider = testCredentialProvider ?? getCredentialProvider();
    const base = getBaseConfig();
    const signal = getActiveAbortSignal() ?? new AbortController().signal;
    const credential = await provider.resolve({
        account: base.account,
        profileKey: base.profileKey,
        baseUrl: base.baseUrl,
        signal,
    });
    const kind = credential.token.startsWith("cdxat_") ? "ORG" : credential.token.startsWith("cdxut_") ? "PERSONAL" : undefined;
    if (!kind) throw new CodecksOperationError("unsupported_token", "Unsupported Codecks token format. Configure a cdxat_ organization or cdxut_ personal API token.");
    if (kind !== base.profileKey) throw new CodecksOperationError("credential_profile_mismatch", "Codecks token kind does not match the selected profile.", { profile: base.profileKey, tokenKind: kind });
    return {
        account: base.account,
        baseUrl: base.baseUrl,
        token: credential.token,
        kind,
        profileKey: base.profileKey!,

        ...(credential.providerId === "onepassword" ? { credentialProviderId: credential.providerId } : {}),
        ...(credential.credentialGeneration !== undefined ? { credentialGeneration: credential.credentialGeneration } : {}),
    };
};

export const getAuthenticatedConfig = (): Promise<CodecksConfig> =>
{
    const context = getOperationContext();
    if (!context)
    {
        return resolveAuthenticatedConfig();
    }
    context.credentialConfigPromise ??= resolveAuthenticatedConfig();
    return context.credentialConfigPromise;
};

export const setCredentialProviderForTests = (provider?: CodecksCredentialProvider) => { testCredentialProvider = provider; };
