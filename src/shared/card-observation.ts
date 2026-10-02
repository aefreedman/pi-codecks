import { extractRelationEntities } from "./entity-maps";
import { getRelation } from "./query";
import { type CodecksEntity } from "./types";

export type CardTypeValue = "regular" | "documentation";

export const normalizeCardStatusValue = (value: unknown): string => String(value ?? "").trim().toLowerCase();

export const resolveCardType = (card: CodecksEntity | undefined): CardTypeValue =>
{
    if (!card)
    {
        return "regular";
    }

    if (card.isDoc === true || String(card.isDoc ?? "").toLowerCase() === "true")
    {
        return "documentation";
    }

    const derivedStatus = normalizeCardStatusValue(card.derivedStatus);
    if (derivedStatus === "doc" || derivedStatus === "documentation")
    {
        return "documentation";
    }

    const status = normalizeCardStatusValue(card.status);
    if (status === "doc" || status === "documentation")
    {
        return "documentation";
    }

    return "regular";
};

export const isIntrinsicDocumentationCard = (card: CodecksEntity | undefined): boolean =>
{
    return resolveCardType(card) === "documentation";
};

export const isDocumentationCard = (
    card: CodecksEntity | undefined,
    cardMap: Record<string, CodecksEntity>,
    visited: Set<string> = new Set(),
): boolean =>
{
    if (!card)
    {
        return false;
    }

    const cardKey = String(card.cardId ?? card.accountSeq ?? "").trim();
    if (cardKey)
    {
        if (visited.has(cardKey))
        {
            return true;
        }
        visited.add(cardKey);
    }

    if (!isIntrinsicDocumentationCard(card))
    {
        return false;
    }

    const children = extractRelationEntities(card, "childCards", cardMap);
    if (children.length === 0)
    {
        return true;
    }

    return children.every((child) => isDocumentationCard(child, cardMap, visited));
};

export const hasOwn = (value: CodecksEntity, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

export const getCardChildCountInfo = (card: CodecksEntity): { known: boolean; count: number | null } =>
{
    const aggregate = card["count:childCards"];
    if (typeof aggregate === "number" && Number.isSafeInteger(aggregate) && aggregate >= 0)
    {
        return { known: true, count: aggregate };
    }

    const relation = getRelation(card, "childCards");
    const children = Array.isArray(relation) ? relation : [relation];
    const isChildReference = (value: unknown): boolean =>
        (typeof value === "string" && value.trim().length > 0)
        || (typeof value === "number" && Number.isFinite(value))
        || (Boolean(value) && typeof value === "object" && !Array.isArray(value)
            && ["cardId", "accountSeq", "id"].some((key) => (value as CodecksEntity)[key] !== undefined));
    if (relation === undefined || relation === null || !children.every(isChildReference))
    {
        return { known: false, count: null };
    }

    return { known: true, count: children.length };
};

export const getCardChildCount = (card: CodecksEntity): number =>
    getCardChildCountInfo(card).count ?? 0;

export const isCardTypeKnown = (card: CodecksEntity): boolean =>
    hasOwn(card, "isDoc") || hasOwn(card, "derivedStatus") || hasOwn(card, "status");
