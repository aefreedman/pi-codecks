import { runExactReadQuery, runQuery } from "../runtime/transport";
import { MAX_REFERENCE_LOOKUPS, cardCodeToAccountSeq, formatShortCode, parseCardIdentifier } from "./card-reference";
import { getEntityMap, resolveFromMap } from "./entity-maps";
import { formatIdForQuery, getAccount, getRelation, normalizeCollection, relationQuery, unwrapData } from "./query";
import { type CodecksEntity } from "./types";

export const fetchCardsByAccountSeqs = async (codes: string[]): Promise<CodecksEntity[]> =>
{
    const seqs = codes
        .map((code) => cardCodeToAccountSeq(code))
        .filter((value): value is number => typeof value === "number")
        .slice(0, MAX_REFERENCE_LOOKUPS);

    if (seqs.length === 0)
    {
        return [];
    }

    const query = {
        _root: [
            {
                account: [
                    {
                        [relationQuery("cards", { accountSeq: seqs })]: [
                            "accountSeq",
                            "cardId",
                            "title",
                            "status",
                        ],
                    },
                ],
            },
        ],
    };

    const payload = await runQuery(query);
    return extractCardsFromPayload(payload, "cards");
};

export const fetchCardByAccountSeq = async (
    seq: number,
    fields: Array<string | Record<string, unknown>> = ["cardId", "accountSeq", "title", "content", "status", "derivedStatus", "isDoc"],
): Promise<CodecksEntity | undefined> =>
{
    const query = {
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

    const payload = await runQuery(query);
    return extractCardsFromPayload(payload, "cards")[0];
};

export const fetchCardById = async (
    cardId: string,
    fields: Array<string | Record<string, unknown>> = ["cardId", "accountSeq", "title", "content", "status", "derivedStatus", "isDoc"],
): Promise<CodecksEntity | undefined> =>
{
    const idLiteral = formatIdForQuery(cardId);
    const query = {
        [`card(${idLiteral})`]: fields,
    };

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const lookupKey = `card(${idLiteral})`;
    return cardMap[String(cardId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
        ?? (data ? (data.card as CodecksEntity | undefined) : undefined);
};

export const fetchCardByAccountSeqExactlyOnce = async (seq: number, fields: Array<string | Record<string, unknown>>): Promise<CodecksEntity | undefined> =>
{
    const query = { _root: [{ account: [{ [relationQuery("cards", { accountSeq: [seq] })]: fields }] }] };
    return extractCardsFromPayload(await runExactReadQuery(query), "cards")[0];
};

export const fetchCardByIdExactlyOnce = async (cardId: string, fields: Array<string | Record<string, unknown>>): Promise<CodecksEntity | undefined> =>
{
    const idLiteral = formatIdForQuery(cardId);
    const query = { [`card(${idLiteral})`]: fields };
    const payload = await runExactReadQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const lookupKey = `card(${idLiteral})`;
    return cardMap[String(cardId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
        ?? (data ? (data.card as CodecksEntity | undefined) : undefined);
};

export const resolveCardForUpdate = async (
    value: string | number,
): Promise<{ cardId: string; shortCode: string; title: string } | null> =>
{
    const parsed = parseCardIdentifier(value);
    let cardId = parsed.cardId ?? value;
    const accountSeq = parsed.accountSeq;
    let shortCode = parsed.cardCode ? `$${parsed.cardCode}` : "";
    const current = accountSeq !== undefined
        ? await fetchCardByAccountSeq(accountSeq)
        : typeof cardId === "string"
            ? await fetchCardById(cardId)
            : undefined;

    if (!current?.cardId)
    {
        return null;
    }

    cardId = current.cardId as string;
    shortCode = formatShortCode(current.accountSeq as number | undefined);

    return {
        cardId,
        shortCode,
        title: current.title ? String(current.title) : "",
    };
};

export const cardSummaryFields = [
    "cardId",
    "accountSeq",
    "title",
    "status",
    "derivedStatus",
    "isDoc",
    "visibility",
    "lastUpdatedAt",
    "dueDate",
    "effort",
    "priority",
    "masterTags",
    { deck: ["id", "title", "accountSeq"] },
    { milestone: ["id", "name", "accountSeq"] },
    { assignee: ["id", "name", "fullName"] },
];

export const cardPlanningFields = [
    ...cardSummaryFields,
    "count:childCards",
];

export const cardDetailFields = [
    ...cardSummaryFields,
    "content",
    { creator: ["id", "name", "fullName"] },
    { parentCard: ["cardId", "accountSeq", "title", "status", "derivedStatus", "isDoc"] },
    { childCards: ["cardId", "accountSeq", "title", "status", "derivedStatus", "isDoc"] },
];

export const handCardFields = [
    "cardId",
    "userId",
    "isVisible",
    "sortIndex",
    { card: cardPlanningFields },
    { user: ["id", "name", "fullName"] },
];

export const hydrateCard = (card: CodecksEntity, maps: {
    user: Record<string, CodecksEntity>;
    deck: Record<string, CodecksEntity>;
    milestone: Record<string, CodecksEntity>;
}): CodecksEntity =>
{
    return {
        ...card,
        assignee: resolveFromMap(card.assignee, maps.user) ?? card.assignee,
        deck: resolveFromMap(card.deck, maps.deck) ?? card.deck,
        milestone: resolveFromMap(card.milestone, maps.milestone) ?? card.milestone,
    };
};

export const extractCardsFromPayload = (payload: unknown, relationName = "cards"): CodecksEntity[] =>
{
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const cardsRef = normalizeCollection(getRelation(account, relationName) as unknown[] | undefined);
    const cardMap = getEntityMap(data, "card");
    const userMap = getEntityMap(data, "user");
    const deckMap = getEntityMap(data, "deck");
    const milestoneMap = getEntityMap(data, "milestone");

    return cardsRef
        .map((entry) => (typeof entry === "object" ? (entry as CodecksEntity) : cardMap[String(entry)]))
        .filter((entry): entry is CodecksEntity => Boolean(entry))
        .map((entry) => hydrateCard(entry, { user: userMap, deck: deckMap, milestone: milestoneMap }));
};
