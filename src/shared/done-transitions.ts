import { runQuery } from "../runtime/transport";
import { normalizeCardStatusValue } from "./card-observation";
import { formatShortCode } from "./card-reference";
import { getEntityMap, resolveFromMap } from "./entity-maps";
import { getAccount, getRelation, normalizeCollection, relationQuery, unwrapData } from "./query";
import type { CodecksEntity } from "./types";

export type DoneTransitionEvent = {
    activityId: string;
    doneAt: string;
    cardId: string;
    accountSeq?: number;
    shortCode?: string;
    title: string;
    fromStatus: string;
    toStatus: string;
    effort?: number;
    assigneeId?: string;
    assigneeName?: string;
    runId?: string;
    deckId?: string;
    deckTitle?: string;
    deckAccountSeq?: number;
    changedBy?: {
        id?: string;
        name?: string;
        fullName?: string;
    };
    currentStatus?: string;
    currentDerivedStatus?: string;
    currentVisibility?: string;
};

export const parseDoneTransitionFromDiff = (diff: unknown): { fromStatus: string; toStatus: string } | null =>
{
    if (!diff || typeof diff !== "object")
    {
        return null;
    }

    const statusDiff = (diff as Record<string, unknown>).status;
    let fromValue: unknown;
    let toValue: unknown;

    if (Array.isArray(statusDiff) && statusDiff.length >= 2)
    {
        [fromValue, toValue] = statusDiff;
    }
    else if (statusDiff && typeof statusDiff === "object")
    {
        const objectValue = statusDiff as Record<string, unknown>;
        fromValue = objectValue.from ?? objectValue.old ?? objectValue.previous;
        toValue = objectValue.to ?? objectValue.new ?? objectValue.next;
    }
    else
    {
        return null;
    }

    const fromStatus = normalizeCardStatusValue(fromValue);
    const toStatus = normalizeCardStatusValue(toValue);
    if (!toStatus || toStatus !== "done" || fromStatus === toStatus)
    {
        return null;
    }

    return { fromStatus: fromStatus || "unknown", toStatus };
};

export const fetchDoneTransitionEvents = async (args: {
    sinceIso: string;
    until: Date;
    scanLimit: number;
    pageSize: number;
}): Promise<{ events: DoneTransitionEvent[]; scannedActivities: number; scanLimitReached: boolean }> =>
{
    const events: DoneTransitionEvent[] = [];
    let scannedActivities = 0;
    let offset = 0;
    const sinceDate = new Date(args.sinceIso);
    const sinceMs = Number.isNaN(sinceDate.getTime()) ? undefined : sinceDate.getTime();

    while (scannedActivities < args.scanLimit)
    {
        const pageLimit = Math.min(args.pageSize, args.scanLimit - scannedActivities);
        if (pageLimit <= 0)
        {
            break;
        }

        const activityFilters: Record<string, unknown> = {
            type: "card_update",
            createdAt: { op: "gte", value: args.sinceIso },
            $order: "-createdAt",
            $limit: pageLimit,
            $offset: offset,
        };
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("activities", activityFilters)]: [
                                "id",
                                "createdAt",
                                "type",
                                "data",
                                { card: ["cardId", "accountSeq", "title", "status", "derivedStatus", "visibility", "effort", "sprintId", { assignee: ["id", "name", "fullName"] }, { deck: ["id", "title", "accountSeq"] }] },
                                { changer: ["id", "name", "fullName"] },
                            ],
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const account = getAccount(payload);
        const activityMap = getEntityMap(data, "activity");
        const cardMap = getEntityMap(data, "card");
        const userMap = getEntityMap(data, "user");
        const deckMap = getEntityMap(data, "deck");
        const activityRefs = normalizeCollection(getRelation(account, "activities") as unknown[] | undefined);
        const activities = activityRefs
            .map((entry) => (typeof entry === "object" && entry ? entry as CodecksEntity : activityMap[String(entry)]))
            .filter((entry): entry is CodecksEntity => Boolean(entry));

        if (activities.length === 0)
        {
            break;
        }

        scannedActivities += activities.length;
        offset += activities.length;

        let reachedOlderThanSince = false;
        for (const activity of activities)
        {
            const createdAtRaw = activity.createdAt ? String(activity.createdAt) : "";
            if (!createdAtRaw)
            {
                continue;
            }

            const createdAt = new Date(createdAtRaw);
            if (Number.isNaN(createdAt.getTime()))
            {
                continue;
            }

            if (createdAt.getTime() > args.until.getTime())
            {
                continue;
            }

            if (sinceMs !== undefined && createdAt.getTime() < sinceMs)
            {
                reachedOlderThanSince = true;
                continue;
            }

            const dataValue = activity.data as Record<string, unknown> | undefined;
            const transition = parseDoneTransitionFromDiff(dataValue?.diff);
            if (!transition)
            {
                continue;
            }

            const resolvedCard = resolveFromMap(activity.card, cardMap)
                ?? (typeof activity.card === "object" && activity.card ? activity.card as CodecksEntity : undefined);
            const cardId = resolvedCard?.cardId
                ? String(resolvedCard.cardId)
                : (typeof activity.card === "string" || typeof activity.card === "number"
                    ? String(activity.card)
                    : "");
            if (!cardId)
            {
                continue;
            }

            const accountSeq = typeof resolvedCard?.accountSeq === "number"
                ? resolvedCard.accountSeq
                : undefined;
            const shortCode = accountSeq !== undefined ? formatShortCode(accountSeq) : undefined;
            const resolvedChanger = resolveFromMap(activity.changer, userMap)
                ?? (typeof activity.changer === "object" && activity.changer ? activity.changer as CodecksEntity : undefined);

            const resolvedAssignee = resolveFromMap(resolvedCard?.assignee, userMap)
                ?? (typeof resolvedCard?.assignee === "object" && resolvedCard.assignee ? resolvedCard.assignee as CodecksEntity : undefined);
            const resolvedDeck = resolveFromMap(resolvedCard?.deck, deckMap)
                ?? (typeof resolvedCard?.deck === "object" && resolvedCard.deck ? resolvedCard.deck as CodecksEntity : undefined);
            events.push({
                activityId: String(activity.id ?? ""),
                doneAt: createdAt.toISOString(),
                cardId,
                accountSeq,
                shortCode,
                title: String(resolvedCard?.title ?? "(untitled)"),
                fromStatus: transition.fromStatus,
                toStatus: transition.toStatus,
                ...(typeof resolvedCard?.effort === "number" && Number.isFinite(resolvedCard.effort) ? { effort: resolvedCard.effort } : {}),
                ...(resolvedAssignee?.id ? { assigneeId: String(resolvedAssignee.id), assigneeName: String(resolvedAssignee.fullName ?? resolvedAssignee.name ?? resolvedAssignee.id) } : {}),
                ...(resolvedCard?.sprintId ? { runId: String(resolvedCard.sprintId) } : {}),
                ...(resolvedDeck?.id ? { deckId: String(resolvedDeck.id) } : {}),
                ...(resolvedDeck?.title ? { deckTitle: String(resolvedDeck.title) } : {}),
                ...(typeof resolvedDeck?.accountSeq === "number" ? { deckAccountSeq: resolvedDeck.accountSeq } : {}),
                changedBy: resolvedChanger
                    ? {
                        id: resolvedChanger.id ? String(resolvedChanger.id) : undefined,
                        name: resolvedChanger.name ? String(resolvedChanger.name) : undefined,
                        fullName: resolvedChanger.fullName ? String(resolvedChanger.fullName) : undefined,
                    }
                    : undefined,
                currentStatus: resolvedCard?.status ? String(resolvedCard.status) : undefined,
                currentDerivedStatus: resolvedCard?.derivedStatus ? String(resolvedCard.derivedStatus) : undefined,
                currentVisibility: resolvedCard?.visibility ? String(resolvedCard.visibility) : undefined,
            });
        }

        if (activities.length < pageLimit)
        {
            break;
        }

        if (reachedOlderThanSince)
        {
            break;
        }
    }

    return {
        events,
        scannedActivities,
        scanLimitReached: scannedActivities >= args.scanLimit,
    };
};
