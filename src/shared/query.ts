import { cardCodeToAccountSeq } from "./card-reference";
import { type CodecksEntity } from "./types";

export const DEFAULT_QUERY_CARD_FIELDS = ["cardId", "accountSeq", "title", "status", "derivedStatus", "isDoc"];
export const DEFAULT_QUERY_DECK_FIELDS = ["id", "accountSeq", "title"];
export const DEFAULT_QUERY_MILESTONE_FIELDS = ["id", "accountSeq", "name"];
export const DEFAULT_QUERY_USER_FIELDS = ["id", "name", "fullName"];

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const isGraphQlLikeQuery = (value: string): boolean => /^(query|mutation)\b|^\{[\s\S]*\}$/.test(value.trim());

export const queryFieldSelectionFromObject = (
    value: unknown,
    fallback: string[],
): Array<string | Record<string, unknown>> =>
{
    if (!isRecord(value))
    {
        return fallback;
    }

    const selected = Object.entries(value)
        .filter(([, include]) => include === true)
        .map(([field]) => field);

    return selected.length > 0 ? selected : fallback;
};

export const toNativeQueryFromShorthand = (query: Record<string, unknown>): Record<string, unknown> | null =>
{
    if ("_root" in query)
    {
        return query;
    }

    if (Object.keys(query).some((key) => key.includes("(")))
    {
        return query;
    }

    if (query.collection !== undefined)
    {
        const collection = String(query.collection).trim().toLowerCase();
        const rawFilter = isRecord(query.filter) ? { ...query.filter } : {};
        const fields = queryFieldSelectionFromObject(query.fields, collection === "decks"
            ? DEFAULT_QUERY_DECK_FIELDS
            : (collection === "milestones" ? DEFAULT_QUERY_MILESTONE_FIELDS : DEFAULT_QUERY_CARD_FIELDS));

        if (collection === "cards")
        {
            if (rawFilter.cardCode !== undefined && rawFilter.accountSeq === undefined)
            {
                const seq = cardCodeToAccountSeq(String(rawFilter.cardCode));
                if (seq === null)
                {
                    throw new Error(`Invalid cardCode '${String(rawFilter.cardCode)}'.`);
                }
                rawFilter.accountSeq = [seq];
                delete rawFilter.cardCode;
            }

            return {
                _root: [
                    {
                        account: [
                            {
                                [relationQuery("cards", rawFilter)]: fields,
                            },
                        ],
                    },
                ],
            };
        }

        if (collection === "decks")
        {
            return {
                _root: [
                    {
                        account: [
                            {
                                [relationQuery("decks", rawFilter)]: fields,
                            },
                        ],
                    },
                ],
            };
        }

        if (collection === "milestones")
        {
            return {
                _root: [
                    {
                        account: [
                            {
                                [relationQuery("milestones", rawFilter)]: fields,
                            },
                        ],
                    },
                ],
            };
        }

        throw new Error("Unsupported query collection. Use one of: cards, decks, milestones.");
    }

    if (isRecord(query.card))
    {
        const cardQuery = { ...query.card };
        const fields = queryFieldSelectionFromObject(cardQuery, DEFAULT_QUERY_CARD_FIELDS);
        let identifier: string | number | undefined;
        if (cardQuery.id !== undefined)
        {
            identifier = String(cardQuery.id).trim();
            delete cardQuery.id;
        }
        else if (cardQuery.cardId !== undefined)
        {
            identifier = String(cardQuery.cardId).trim();
            delete cardQuery.cardId;
        }
        else if (cardQuery.cardCode !== undefined)
        {
            const seq = cardCodeToAccountSeq(String(cardQuery.cardCode));
            if (seq === null)
            {
                throw new Error(`Invalid cardCode '${String(cardQuery.cardCode)}'.`);
            }
            return {
                _root: [
                    {
                        account: [
                            {
                                [relationQuery("cards", { accountSeq: [seq] })]: fields,
                            },
                        ],
                    },
                ],
            };
        }

        if (identifier === undefined || identifier === "")
        {
            throw new Error("Card shorthand queries require id, cardId, or cardCode.");
        }

        return {
            [`card(${formatIdForQuery(identifier)})`]: fields,
        };
    }

    if (isRecord(query.me) || isRecord(query.loggedInUser))
    {
        return {
            _root: [
                {
                    loggedInUser: queryFieldSelectionFromObject(query.me ?? query.loggedInUser, DEFAULT_QUERY_USER_FIELDS),
                },
            ],
        };
    }

    return query;
};

export const normalizeQuery = (query: unknown): Record<string, unknown> =>
{
    if (!query)
    {
        throw new Error("Query is required.");
    }

    if (typeof query === "string")
    {
        const trimmed = query.trim();
        if (isGraphQlLikeQuery(trimmed))
        {
            throw new Error("GraphQL strings are not supported. Provide a Codecks query object or supported shorthand object.");
        }

        try
        {
            return normalizeQuery(JSON.parse(trimmed));
        }
        catch (error)
        {
            throw new Error("Query must be valid JSON or an object.");
        }
    }

    if (typeof query === "object")
    {
        return toNativeQueryFromShorthand(query as Record<string, unknown>) ?? (query as Record<string, unknown>);
    }

    throw new Error("Query must be valid JSON or an object.");
};

export const relationQuery = (relation: string, query?: Record<string, unknown>): string =>
{
    if (!query || Object.keys(query).length === 0)
    {
        return relation;
    }

    return `${relation}(${JSON.stringify(query)})`;
};

export const unwrapData = (payload: unknown): unknown =>
{
    if (!payload || typeof payload !== "object")
    {
        return payload;
    }

    const record = payload as Record<string, unknown>;
    return record.data ?? payload;
};

export const normalizeEntity = <T>(value: T | T[] | undefined): T | undefined =>
{
    if (Array.isArray(value))
    {
        return value[0];
    }

    return value;
};

export const normalizeCollection = <T>(value: T | T[] | undefined): T[] =>
{
    if (!value)
    {
        return [];
    }

    return Array.isArray(value) ? value : [value];
};

export const getRoot = (payload: unknown): CodecksEntity | undefined =>
{
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    if (!data)
    {
        return undefined;
    }

    const root = data._root;
    return normalizeEntity(root as CodecksEntity | CodecksEntity[] | undefined);
};

export const getAccount = (payload: unknown): CodecksEntity | undefined =>
{
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const root = getRoot(payload);
    if (!root)
    {
        return undefined;
    }

    const accountValue = root.account as unknown;
    if ((typeof accountValue === "string" || typeof accountValue === "number") && data?.account && typeof data.account === "object")
    {
        const accountMap = data.account as Record<string, CodecksEntity>;
        const resolved = accountMap[String(accountValue)];
        if (resolved)
        {
            return resolved;
        }
    }

    return normalizeEntity(accountValue as CodecksEntity | CodecksEntity[] | undefined);
};

export const getRelation = (entity: CodecksEntity | undefined, relation: string): unknown =>
{
    if (!entity)
    {
        return undefined;
    }

    const direct = entity[relation];
    if (direct !== undefined)
    {
        return direct;
    }

    const key = Object.keys(entity).find((entry) => entry.startsWith(`${relation}(`));
    return key ? entity[key] : undefined;
};

export const toIdValue = (value: string | number): string | number =>
{
    if (typeof value === "number")
    {
        return value;
    }

    if (/^\d+$/.test(value))
    {
        return Number(value);
    }

    return value;
};

export const blankToUndefined = <T extends string | number | undefined | null>(value: T): Exclude<T, "" | null> | undefined =>
{
    if (value === undefined || value === null)
    {
        return undefined;
    }

    if (typeof value === "string" && value.trim().length === 0)
    {
        return undefined;
    }

    return value as Exclude<T, "" | null>;
};

export const formatIdForQuery = (value: string | number): string =>
{
    if (typeof value === "number")
    {
        return String(value);
    }

    return String(value).trim();
};
