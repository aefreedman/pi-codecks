import { getEntityMap, resolveFromMap } from "../shared/entity-maps";
import { getRoot, isRecord, normalizeEntity, unwrapData } from "../shared/query";
import { toErrorMessage } from "../shared/results";
import { type CodecksUser } from "../shared/types";
import { getAuthenticatedConfig } from "./credentials";
import { CodecksOperationError } from "./operation-error";
import { runExactReadQuery, runQuery } from "./transport";
import { type CodecksExternalProviderCheckCategory, type CodecksExternalProviderCheckResult, type CodecksFetch } from "./types";

export const ACCOUNT_IDENTITY_QUERY = Object.freeze({ _root: [{ account: ["id"] }] });

export const LOGGED_IN_USER_IDENTITY_QUERY = Object.freeze({
    _root: [
        {
            loggedInUser: ["id", "name", "fullName"],
        },
    ],
});

export const getLoggedInUserFromPayload = (payload: unknown): CodecksUser | undefined =>
{
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const root = getRoot(payload);
    const userMap = getEntityMap(data, "user");
    const resolved = resolveFromMap(root?.loggedInUser, userMap);
    return normalizeEntity((resolved ?? root?.loggedInUser) as CodecksUser | CodecksUser[] | undefined);
};

export const isExplicitlyEmptyIdentity = (value: unknown): boolean =>
    value === null || value === undefined || value === "";

/**
 * The account identity query accepts inline account objects or normalized
 * relation IDs resolved through the account entity map. An explicitly present
 * null or literal empty relation is rejection; a missing or unresolvable
 * relation remains malformed rather than masking an incompatible response.
 */
export const classifyExternalProviderIdentityPayload = (payload: unknown): CodecksExternalProviderCheckCategory =>
{
    const data = unwrapData(payload);
    if (!isRecord(data) || !isRecord(data._root)) return "malformed_response";
    const root = data._root;
    if (!Object.prototype.hasOwnProperty.call(root, "account")) return "malformed_response";
    if (isExplicitlyEmptyIdentity(root.account)) return "authentication_rejected";
    const reference = root.account;
    const accountMap = data.account;
    const normalizedRef = typeof reference === "string" ? reference.trim().toLowerCase() : "";
    const mapKey = normalizedRef && isRecord(accountMap)
        ? Object.keys(accountMap).find((key) => key.trim().toLowerCase() === normalizedRef)
        : undefined;
    const account = typeof reference === "string" ? (mapKey && isRecord(accountMap) ? accountMap[mapKey] : undefined) : reference;
    if (!isRecord(account) || typeof account.id !== "string" || !account.id.trim()) return "malformed_response";
    return typeof reference !== "string" || account.id.trim().toLowerCase() === normalizedRef ? "authenticated" : "malformed_response";
};

export const ORG_SHARED_ACTOR_QUERY = Object.freeze({ _root: [{ loggedInUser: ["id", "kind", "isIntegration"] }] });

export const fetchSharedActor = async (): Promise<{ id: string | number; verifiedOrg: boolean }> =>
{
    if ((await getAuthenticatedConfig()).kind !== "ORG") return { id: (await fetchLoggedInUser()).id!, verifiedOrg: false };
    const payload = await runQuery(ORG_SHARED_ACTOR_QUERY);
    const actor = getLoggedInUserFromPayload(payload) as (CodecksUser & { kind?: unknown; isIntegration?: unknown }) | undefined;
    if (typeof actor?.id !== "string" || !actor.id.trim() || actor.kind !== "api_token" || actor.isIntegration !== true)
        throw new CodecksOperationError("org_actor_unverified", "Authenticated organization-token actor could not be verified; no mutation was sent.");
    return { id: actor.id, verifiedOrg: true };
};

export const fetchLoggedInUser = async (): Promise<CodecksUser> =>
{
    if ((await getAuthenticatedConfig()).kind === "ORG") throw new CodecksOperationError("personal_token_required", "Personal API token is required for this user-specific operation.");
    const user = getLoggedInUserFromPayload(await runQuery(LOGGED_IN_USER_IDENTITY_QUERY));
    if (!user?.id)
    {
        throw new Error("Unable to resolve logged-in user from Codecks.");
    }
    return user;
};

/**
 * Repository-only live validation uses this fixed identity read to exercise the
 * production credential-provider and exact-read paths. `fetchImplementation`
 * is injectable only for deterministic no-network tests.
 */
export const runExternalProviderIdentityCheck = async (
    fetchImplementation: CodecksFetch = fetch,
): Promise<CodecksExternalProviderCheckResult> =>
{
    try
    {
        return { category: classifyExternalProviderIdentityPayload(await runExactReadQuery(ACCOUNT_IDENTITY_QUERY, fetchImplementation)) };
    }
    catch (error)
    {
        const message = toErrorMessage(error);
        if (error instanceof CodecksOperationError && (error.category === "authentication_rejected" || error.category === "account_mismatch"))
        {
            return { category: "authentication_rejected" };
        }
        if (/^(?:Missing Codecks|Invalid CODECKS_PROFILE|Unsupported Codecks credential provider|External Codecks credential helper configuration is invalid\.)/.test(message))
        {
            return { category: "invalid_configuration" };
        }
        return { category: "unavailable" };
    }
};
