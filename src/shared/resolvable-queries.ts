import { runQuery } from "../runtime/transport";
import { extractRelationEntities, getEntityMap, resolveFromMap } from "./entity-maps";
import { formatIdForQuery, relationQuery, unwrapData } from "./query";
import { type CodecksEntity } from "./types";

export const fetchOpenResolvableContextsForCards = async (cardIds: string[]): Promise<Record<string, Set<string>>> =>
{
    const uniqueIds = Array.from(new Set(cardIds.map((id) => String(id)).filter((id) => id.trim().length > 0)));
    if (uniqueIds.length === 0)
    {
        return {};
    }

    const query: Record<string, unknown> = {};
    for (const id of uniqueIds)
    {
        query[`card(${formatIdForQuery(id)})`] = [
            {
                [relationQuery("resolvables", { isClosed: false })]: ["id", "context", "isClosed"],
            },
        ];
    }

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const resolvableMap = getEntityMap(data, "resolvable");
    const contextsByCard: Record<string, Set<string>> = {};

    for (const id of uniqueIds)
    {
        const lookupKey = `card(${formatIdForQuery(id)})`;
        const rawCard = cardMap[String(id)]
            ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
            ?? (data ? (data.card as CodecksEntity | undefined) : undefined);
        const resolvables = extractRelationEntities(rawCard, "resolvables", resolvableMap);
        const contexts = new Set<string>();

        for (const resolvable of resolvables)
        {
            if (resolvable.isClosed)
            {
                continue;
            }

            const contextValue = String(resolvable.context ?? "").trim().toLowerCase();
            if (contextValue)
            {
                contexts.add(contextValue);
            }
        }

        contextsByCard[id] = contexts;
    }

    return contextsByCard;
};

export const fetchOpenResolvableContexts = async (cardId: string): Promise<Set<string>> =>
{
    const contexts = await fetchOpenResolvableContextsForCards([cardId]);
    return contexts[String(cardId)] ?? new Set<string>();
};

export const fetchResolvableById = async (resolvableId: string): Promise<CodecksEntity | undefined> =>
{
    const idLiteral = formatIdForQuery(resolvableId);
    const query = {
        [`resolvable(${idLiteral})`]: [
            "id",
            "context",
            "isClosed",
            "createdAt",
            "closedAt",
            { card: ["cardId", "accountSeq", "title", "status", "derivedStatus"] },
            { creator: ["id", "name", "fullName"] },
            { closedBy: ["id", "name", "fullName"] },
            {
                entries: [
                    "entryId",
                    "createdAt",
                    "content",
                    { author: ["id", "name", "fullName"] },
                ],
            },
        ],
    };

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const resolvableMap = getEntityMap(data, "resolvable");
    const cardMap = getEntityMap(data, "card");
    const userMap = getEntityMap(data, "user");
    const entryMap = getEntityMap(data, "resolvableEntry");
    const lookupKey = `resolvable(${idLiteral})`;
    const rawResolvable = resolvableMap[String(resolvableId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, resolvableMap)
        ?? (data ? (data.resolvable as CodecksEntity | undefined) : undefined);

    if (!rawResolvable)
    {
        return undefined;
    }

    const entries = extractRelationEntities(rawResolvable, "entries", entryMap)
        .map((entry) => ({
            ...entry,
            author: resolveFromMap(entry.author, userMap) ?? entry.author,
        }));

    return {
        ...rawResolvable,
        card: resolveFromMap(rawResolvable.card, cardMap) ?? rawResolvable.card,
        creator: resolveFromMap(rawResolvable.creator, userMap) ?? rawResolvable.creator,
        closedBy: resolveFromMap(rawResolvable.closedBy, userMap) ?? rawResolvable.closedBy,
        entries,
    };
};

export const fetchResolvableEntryById = async (entryId: string): Promise<CodecksEntity | undefined> =>
{
    const idLiteral = formatIdForQuery(entryId);
    const query = {
        [`resolvableEntry(${idLiteral})`]: [
            "entryId",
            "content",
            "version",
            "createdAt",
            "lastChangedAt",
            { author: ["id", "name", "fullName"] },
            {
                resolvable: [
                    "id",
                    "context",
                    "isClosed",
                    "createdAt",
                    "closedAt",
                    { card: ["cardId", "accountSeq", "title", "status", "derivedStatus"] },
                ],
            },
        ],
    };

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const entryMap = getEntityMap(data, "resolvableEntry");
    const userMap = getEntityMap(data, "user");
    const resolvableMap = getEntityMap(data, "resolvable");
    const cardMap = getEntityMap(data, "card");
    const lookupKey = `resolvableEntry(${idLiteral})`;
    const rawEntry = entryMap[String(entryId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, entryMap)
        ?? (data ? (data.resolvableEntry as CodecksEntity | undefined) : undefined);

    if (!rawEntry)
    {
        return undefined;
    }

    const resolvable = resolveFromMap(rawEntry.resolvable, resolvableMap) ?? rawEntry.resolvable;
    const hydratedResolvable = typeof resolvable === "object" && resolvable
        ? {
            ...(resolvable as CodecksEntity),
            card: resolveFromMap((resolvable as CodecksEntity).card, cardMap) ?? (resolvable as CodecksEntity).card,
        }
        : resolvable;

    return {
        ...rawEntry,
        author: resolveFromMap(rawEntry.author, userMap) ?? rawEntry.author,
        resolvable: hydratedResolvable,
    };
};

export const fetchOpenResolvablesForCard = async (cardId: string): Promise<CodecksEntity[]> =>
{
    const idLiteral = formatIdForQuery(cardId);
    const query = {
        [`card(${idLiteral})`]: [
            "cardId",
            "accountSeq",
            "title",
            {
                [relationQuery("resolvables", { isClosed: false, $order: "-createdAt" })]: [
                    "id",
                    "context",
                    "isClosed",
                    "createdAt",
                    "closedAt",
                ],
            },
        ],
    };

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const resolvableMap = getEntityMap(data, "resolvable");
    const lookupKey = `card(${idLiteral})`;
    const rawCard = cardMap[String(cardId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
        ?? (data ? (data.card as CodecksEntity | undefined) : undefined);
    const openResolvables = extractRelationEntities(rawCard, "resolvables", resolvableMap);
    return openResolvables.filter((entry) => !entry.isClosed);
};
