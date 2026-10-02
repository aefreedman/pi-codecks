import type { CodecksEntity } from "../../shared/types";
import { extractRelationEntities, resolveFromMap } from "../../shared/entity-maps";
import { normalizeCardCandidate, normalizeCardGetData, normalizeRelatedCardSummary } from "./helpers";

/** Shared native observation rules; legacy renderer normalizers remain unchanged. */
        // Pilot-scoped evidence rules; do not change other tools' legacy type inference.
const hasObservedType = (source: CodecksEntity): boolean =>
            typeof source.isDoc === "boolean"
            || (typeof source.isDoc === "string" && /^(true|false)$/i.test(source.isDoc))
            || [source.status, source.derivedStatus].some(value => typeof value === "string" && value.trim().length > 0);
export const observeSummary = (summary: Record<string, unknown>, source: CodecksEntity): Record<string, unknown> =>
        {
            const clean = { ...summary };
            const derived = new Set(["shortCode", "cardRef", "accountSeqRef", "url", "cardType", "isDoc", "contentTrust", "tags"]);
            for (const field of Object.keys(clean))
            {
                if (!derived.has(field) && source[field] === undefined) delete clean[field];
                else if (!derived.has(field) && source[field] === null) clean[field] = null;
            }
            if (typeof source.accountSeq !== "number" || !Number.isSafeInteger(source.accountSeq) || source.accountSeq < 0)
            {
                for (const field of ["shortCode", "cardRef", "accountSeqRef", "url"]) delete clean[field];
            }
            if ("cardType" in clean && !hasObservedType(source))
            {
                clean.cardType = "unknown";
                delete clean.isDoc;
            }
            if ("cardType" in clean && (source.isDoc === null || typeof source.isDoc === "boolean")) clean.isDoc = source.isDoc;
            return clean;
        };
export const observeCandidate = (source: CodecksEntity): Record<string, unknown> =>
        {
            const clean = observeSummary(normalizeCardCandidate(source), source);
            if (source.derivedStatus !== undefined) clean.derivedStatus = source.derivedStatus;
            if (typeof source.isDoc === "boolean") clean.isDoc = source.isDoc;
            for (const [key, fields] of [["deck", ["title"]], ["milestone", ["name", "title"]], ["assignee", ["name", "fullName"]]] as const)
            {
                const relation = source[key];
                if (relation === null) clean[key] = null;
                else if (relation && typeof relation === "object")
                {
                    const observed = fields.map(field => (relation as CodecksEntity)[field]).find(value => value !== undefined);
                    if (observed !== undefined) clean[key] = observed;
                    else delete clean[key];
                }
                else delete clean[key];
            }
            return clean;
        };

export function observeCardGet(detail: { card: CodecksEntity; cardMap: Record<string, CodecksEntity> }, normalizedCard = normalizeCardGetData(detail.card, detail.cardMap)): Record<string, unknown> {
            const observed = observeSummary(normalizedCard, detail.card);
            for (const key of ["cardId", "accountSeq", "title", "content", "status", "derivedStatus", "visibility", "effort", "priority", "dueDate", "lastUpdatedAt", "deck", "milestone", "assignee", "creator", "parentCard", "childCards"])
            {
                if (detail.card[key] === undefined) delete observed[key];
                else if (detail.card[key] === null) observed[key] = null;
            }
            if (detail.card.masterTags === undefined) delete observed.tags;
            else if (detail.card.masterTags === null) observed.tags = null;
            // Summary normalizers are renderer-oriented and fill missing values with null.
            // Keep genuinely absent nested fields absent in the programmatic observation.
            for (const key of ["deck", "milestone", "assignee", "creator"])
            {
                const source = detail.card[key];
                const summary = observed[key];
                if (source && typeof source === "object" && summary && typeof summary === "object")
                {
                    observed[key] = observeSummary(summary as Record<string, unknown>, source as CodecksEntity);
                }
                else if (source !== null) delete observed[key];
            }
            const parent = resolveFromMap(detail.card.parentCard, detail.cardMap)
                ?? (detail.card.parentCard && typeof detail.card.parentCard === "object" ? detail.card.parentCard as CodecksEntity : undefined);
            if (parent && observed.parentCard && typeof observed.parentCard === "object")
                observed.parentCard = observeSummary(observed.parentCard as Record<string, unknown>, parent);
            else if (detail.card.parentCard !== null) delete observed.parentCard;
            const children = extractRelationEntities(detail.card, "childCards", detail.cardMap);
            if (Array.isArray(observed.childCards))
                observed.childCards = children.map(child => observeSummary(normalizeRelatedCardSummary(child)!, child));
            if (Array.isArray(detail.card.childCards) && detail.card.childCards.length !== children.length)
                delete observed.childCards;
            return observed;
}
