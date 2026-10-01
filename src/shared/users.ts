import { firstNonEmpty, getBaseConfig, getProfileEnv } from "../runtime/credentials";
import { fetchLoggedInUser } from "../runtime/identity";
import { runQuery } from "../runtime/transport";
import { USER_ID_TAG_REGEX } from "./card-reference";
import { getEntityMap } from "./entity-maps";
import { formatIdForQuery, toIdValue, unwrapData } from "./query";
import { UUID_PATTERN } from "./session-id";
import { type CodecksEntity } from "./types";

export const normalizeUserId = (value: string): string => value.trim().toLowerCase();

export const getFallbackAssigneeId = (): string | number | undefined =>
{
    const profileKey = getBaseConfig().profileKey;
    const profileValue = profileKey ? firstNonEmpty(getProfileEnv(profileKey, "DEFAULT_ASSIGNEE_ID")) : undefined;
    const raw = firstNonEmpty(profileValue, process.env.CODECKS_DEFAULT_ASSIGNEE_ID);
    if (!raw || String(raw).trim().length === 0)
    {
        return undefined;
    }

    return toIdValue(String(raw).trim());
};

export const extractUserIdsFromText = (content?: unknown): string[] =>
{
    if (!content)
    {
        return [];
    }

    const text = String(content);
    const matches = text.matchAll(USER_ID_TAG_REGEX);
    const ids = new Set<string>();

    for (const match of matches)
    {
        const candidate = match[1];
        if (candidate)
        {
            ids.add(normalizeUserId(candidate));
        }
    }

    return Array.from(ids);
};

export const buildUserLookupMap = (...maps: Array<Record<string, CodecksEntity>>): Record<string, CodecksEntity> =>
{
    const merged: Record<string, CodecksEntity> = {};

    for (const map of maps)
    {
        for (const [key, value] of Object.entries(map))
        {
            if (!value)
            {
                continue;
            }

            const normalizedKey = normalizeUserId(key);
            merged[normalizedKey] = value;
            const valueId = value.id !== undefined ? normalizeUserId(String(value.id)) : "";
            if (valueId)
            {
                merged[valueId] = value;
            }
        }
    }

    return merged;
};

export const replaceUserIdMentions = (content: string, users: Record<string, CodecksEntity>): string =>
{
    if (!content)
    {
        return content;
    }

    return content.replace(USER_ID_TAG_REGEX, (match, id) =>
    {
        const normalized = normalizeUserId(String(id));
        const user = users[normalized];
        const name = user?.fullName ?? user?.name;
        return name ? `@${name}` : match;
    });
};

export const fetchUsersByIds = async (userIds: string[]): Promise<Record<string, CodecksEntity>> =>
{
    const ids = userIds
        .map((id) => normalizeUserId(id))
        .filter((id) => id.length > 0);

    if (ids.length === 0)
    {
        return {};
    }

    const query: Record<string, unknown> = {};

    for (const id of ids)
    {
        query[`user(${formatIdForQuery(id)})`] = ["id", "name", "fullName"];
    }

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const userMap = getEntityMap(data, "user");
    return buildUserLookupMap(userMap);
};

export const resolveAssigneeId = async (value: string | number | undefined | null): Promise<string | number> =>
{
    if (value !== undefined && value !== null)
    {
        const trimmed = String(value).trim();
        if (!trimmed)
        {
            throw new Error("assigneeId cannot be empty.");
        }

        const looksLikeNumericId = /^\d+$/.test(trimmed);
        const looksLikeUuid = UUID_PATTERN.test(trimmed);
        if (!looksLikeNumericId && !looksLikeUuid)
        {
            throw new Error(`No user matched assigneeId '${trimmed}'. Use codecks_user_lookup to find a valid user id.`);
        }

        const userMap = await fetchUsersByIds([trimmed]);
        const normalized = normalizeUserId(trimmed);
        const user = userMap[normalized];
        if (user?.id !== undefined)
        {
            return user.id as string | number;
        }

        throw new Error(`No user matched assigneeId '${trimmed}'. Use codecks_user_lookup to find a valid user id.`);
    }

    const loggedIn = await fetchLoggedInUser();
    if (loggedIn.id !== undefined)
    {
        return loggedIn.id;
    }

    const fallback = getFallbackAssigneeId();
    if (fallback !== undefined)
    {
        return fallback;
    }

    throw new Error("Unable to resolve default assignee. Provide assigneeId or set CODECKS_DEFAULT_ASSIGNEE_ID.");
};
