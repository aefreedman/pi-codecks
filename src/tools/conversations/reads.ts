import type { CodecksOperationPayload } from "../../pi/tool-definition";
import { withOperationContextIfMissing } from "../../runtime/operation-context";
import { type ConversationArguments, createConversationReadResult, observeCard, observeThread, observeEntry, relationEvidence, relationReferenceCount } from "./conversations-dto-helpers";
import { fetchLoggedInUser } from "../../runtime/identity";
import { runQuery } from "../../runtime/transport";
import { fetchCardByAccountSeq, fetchCardById, hydrateCard } from "../../shared/card-queries";
import { formatShortCode, parseCardIdentifier } from "../../shared/card-reference";
import { extractRelationEntities, getEntityMap, resolveFromMap } from "../../shared/entity-maps";
import { formatDateTime, formatResolvableContextLabel } from "../../shared/presentation";
import { formatIdForQuery, getAccount, relationQuery, unwrapData } from "../../shared/query";
import { normalizeResolvableContextInput } from "../../shared/resolvable-context";
import { toErrorMessage } from "../../shared/results";
import { outputFormatArg, tool } from "../../pi-tool-compat";
import { type CodecksEntity, type CodecksUser } from "../../shared/types";
import { formatCardUrl } from "../../shared/urls";
import { type ResolvableActionBucket, computeResolvableBubbleHeuristic } from "./helpers";

export const card_list_resolvables = tool({
    description: "List Codecks card conversation threads (comments, reviews, blockers).",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        contexts: tool.schema.array(tool.schema.string()).optional().describe("Optional list of contexts to include (comment, review, block/blocker)."),
        includeClosed: tool.schema.boolean().optional().describe("Include closed resolvables."),
        limit: tool.schema.number().min(1).max(500).optional().describe("Maximum number of resolvables to return."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        return (await executeCardListResolvablesPayload(args)).text;
    },
});

export const list_open_resolvable_cards = tool({
    description: "List cards across the account that currently have open resolvables, grouped by context.",
    args: {
        contexts: tool.schema.array(tool.schema.string()).optional().describe("Optional list of contexts to include (comment, review, block/blocker)."),
        limit: tool.schema.number().min(1).max(500).optional().describe("Maximum number of matching cards to return."),
        scanLimit: tool.schema.number().min(1).max(5000).optional().describe("Maximum number of recent cards to scan."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        return (await executeListOpenResolvableCardsPayload(args)).text;
    },
});

export const list_logged_in_user_actionable_resolvables = tool({
    description: "List open resolvables that are heuristically attention-worthy for the logged-in user.",
    args: {
        contexts: tool.schema.array(tool.schema.string()).optional().describe("Optional list of contexts to include (comment, review, block/blocker)."),
        limit: tool.schema.number().min(1).max(500).optional().describe("Maximum number of matching cards to return per context."),
        scanLimit: tool.schema.number().min(1).max(1000).optional().describe("Maximum number of recent cards to scan for open resolvables."),
        staleAfterHours: tool.schema.number().min(1).max(24 * 30).optional().describe("Treat self-authored still-open threads older than this as resurfaced/actionable."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        return (await executeListLoggedInUserActionableResolvablesPayload(args)).text;
    },
});

// Optional probes must not send $limit without $order, or paginate unknown/single/fkAsArray relations.
// Only these schema-confirmed hasMany relations have a known sortable field and safe selection.

export const executeCardListResolvablesPayload = (args: ConversationArguments): Promise<CodecksOperationPayload> => withOperationContextIfMissing(async () => {
        const native = createConversationReadResult("card_list_resolvables");
        const { success: toStructuredResult, failure: toStructuredErrorResult } = native;
        const format = args.format ?? "text";
        const parsed = parseCardIdentifier(args.cardId);
        let cardId = parsed.cardId ?? args.cardId;
        let accountSeq = parsed.accountSeq;
        let shortCode = parsed.cardCode ? `$${parsed.cardCode}` : "";
        const current = accountSeq !== undefined
            ? await fetchCardByAccountSeq(accountSeq)
            : typeof cardId === "string"
                ? await fetchCardById(cardId)
                : undefined;

        if (!current?.cardId)
        {
            return toStructuredErrorResult(format, "card-list-resolvables", "not_found", "Card not found.");
        }

        cardId = current.cardId as string;
        accountSeq = current.accountSeq as number | undefined;
        shortCode = formatShortCode(accountSeq);

        if (!cardId)
        {
            return toStructuredErrorResult(format, "card-list-resolvables", "validation_error", "Card ID is required.");
        }

        const includeClosed = args.includeClosed ?? false;
        const filters: Record<string, unknown> = {
            $order: ["contextAsPrio", "-createdAt"],
        };

        if (!includeClosed)
        {
            filters.isClosed = false;
        }

        const idLiteral = formatIdForQuery(cardId);
        const query = {
            [`card(${idLiteral})`]: [
                "cardId",
                "accountSeq",
                "title",
                "status",
                "derivedStatus",
                {
                    [relationQuery("resolvables", filters)]: [
                        "id",
                        "context",
                        "createdAt",
                        "isClosed",
                        "closedAt",
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const cardMap = getEntityMap(data, "card");
        const userMap = getEntityMap(data, "user");
        const resolvableMap = getEntityMap(data, "resolvable");
        const lookupKey = `card(${idLiteral})`;
        const rawCard = cardMap[String(cardId)]
            ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
            ?? (data ? (data.card as CodecksEntity | undefined) : undefined);
        const card = rawCard
            ? hydrateCard(rawCard, {
                user: userMap,
                deck: getEntityMap(data, "deck"),
                milestone: getEntityMap(data, "milestone"),
            })
            : undefined;

        if (!card)
        {
            return toStructuredErrorResult(format, "card-list-resolvables", "not_found", "Card not found.");
        }

        let requestedContexts: string[] | undefined;
        if (args.contexts && args.contexts.length > 0)
        {
            const normalized: string[] = [];
            for (const value of args.contexts)
            {
                const contextResult = normalizeResolvableContextInput(value);
                if ("error" in contextResult)
                {
                    return toStructuredErrorResult(format, "card-list-resolvables", "validation_error", contextResult.error);
                }
                normalized.push(contextResult.context);
            }
            requestedContexts = Array.from(new Set(normalized));
        }

        native.facts.card = observeCard(rawCard);
        const resolvables = extractRelationEntities(card, "resolvables", resolvableMap);
        const filtered = resolvables.filter((resolvable) =>
        {
            const contextValue = String(resolvable.context ?? "").toLowerCase();
            if (requestedContexts && !requestedContexts.includes(contextValue))
            {
                return false;
            }

            if (!includeClosed && resolvable.isClosed)
            {
                return false;
            }

            return true;
        });

        const limit = args.limit ?? 50;
        const limited = filtered.slice(0, limit);
        Object.assign(native.facts, { sourceThreadReferences: relationReferenceCount(rawCard, "resolvables"), sourceThreads: resolvables.length, matchedThreads: filtered.length, emittedThreads: limited.length, limit, includeClosed, threads: [] });
        native.setRead(relationEvidence(rawCard, "resolvables", resolvableMap) ? "complete" : "incomplete");
        const resolvableIds = limited
            .map((entry) => String(entry.id ?? "").trim())
            .filter((value) => value.length > 0);

        if (limited.length === 0 || resolvableIds.length === 0)
        {
            if (limited.length > 0) { native.facts.threads = limited.map(thread => ({ ...observeThread(thread), detailObserved: false, observedEntries: 0, entries: [] })); native.setRead("incomplete"); }
            const url = shortCode ? formatCardUrl(shortCode) : "";
            const emptyText = [
                "## Resolvables",
                "",
                `- Title: ${card.title ?? "(untitled)"}`,
                `- ID: ${cardId}`,
                `- Short Code: ${shortCode || "(n/a)"}`,
                `- URL: ${url || ""}`,
                `- Status: ${String(card.status ?? "unknown")}`,
                `- Derived Status: ${String(card.derivedStatus ?? "unknown")}`,
                "- Total: 0",
                "",
                "No resolvables matched the search criteria.",
            ].join("\n");

            return toStructuredResult(
                format,
                "card-list-resolvables",
                emptyText,
                {
                    cardId,
                    cardStatus: String(card.status ?? "unknown"),
                    cardDerivedStatus: String(card.derivedStatus ?? "unknown"),
                    shortCode: shortCode || null,
                    total: 0,
                    contexts: [],
                    contextLabels: [],
                    includeClosed,
                    threads: [],
                },
            );
        }

        const detailQuery: Record<string, unknown> = {};

        for (const resolvableId of resolvableIds)
        {
            detailQuery[`resolvable(${formatIdForQuery(resolvableId)})`] = [
                "id",
                "closedAt",
                {
                    entries: [
                        "createdAt",
                        "entryId",
                        "content",
                        "version",
                        {
                            author: ["id", "name", "fullName"],
                        },
                    ],
                },
            ];
        }

        const detailPayload = await runQuery(detailQuery);
        const detailData = unwrapData(detailPayload) as Record<string, unknown> | undefined;
        const detailResolvableMap = getEntityMap(detailData, "resolvable");
        const entryMap = getEntityMap(detailData, "resolvableEntry");
        const detailUserMap = getEntityMap(detailData, "user");
        const grouped = new Map<string, CodecksEntity[]>();

        for (const resolvable of limited)
        {
            const contextValue = String(resolvable.context ?? "unknown").toLowerCase();
            const list = grouped.get(contextValue) ?? [];
            list.push(resolvable);
            grouped.set(contextValue, list);
        }

        const defaultOrder = ["comment", "review", "block"];
        const orderedContexts: string[] = [];
        const priorityOrder = requestedContexts ?? defaultOrder;

        for (const context of priorityOrder)
        {
            if (grouped.has(context))
            {
                orderedContexts.push(context);
            }
        }

        for (const context of grouped.keys())
        {
            if (!orderedContexts.includes(context))
            {
                orderedContexts.push(context);
            }
        }

        const resolveUserName = (userId: unknown): string =>
        {
            if (!userId)
            {
                return "Unknown";
            }

            const user = detailUserMap[String(userId)];
            return user?.name ?? user?.fullName ?? String(userId);
        };

        const normalizeContent = (content: string): string =>
        {
            return content.replace(/\s+/g, " ").trim();
        };

        const toTimestamp = (value: unknown): number =>
        {
            const date = new Date(String(value ?? ""));
            return Number.isNaN(date.getTime()) ? 0 : date.getTime();
        };

        const formatPreview = (content: string): string =>
        {
            if (content.length <= 160)
            {
                return content;
            }

            return `${content.slice(0, 157)}...`;
        };

        const url = shortCode ? formatCardUrl(shortCode) : "";
        const lines = [
            "## Resolvables",
            "",
            `- Title: ${card.title ?? "(untitled)"}`,
            `- ID: ${cardId}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Status: ${String(card.status ?? "unknown")}`,
            `- Derived Status: ${String(card.derivedStatus ?? "unknown")}`,
            `- Total: ${limited.length}`,
        ];

        const threadItems: Array<Record<string, unknown>> = [];

        for (const context of orderedContexts)
        {
            const entries = grouped.get(context);
            if (!entries || entries.length === 0)
            {
                continue;
            }

            const headerRaw = formatResolvableContextLabel(context);
            const header = headerRaw.charAt(0).toUpperCase() + headerRaw.slice(1);
            lines.push("", `### ${header}`);

            for (const resolvable of entries)
            {
                const resolvableId = String(resolvable.id ?? "");
                const detail = resolvableId ? detailResolvableMap[resolvableId] : undefined;
                const entryList = detail ? extractRelationEntities(detail, "entries", entryMap) : [];
                (native.facts.threads as unknown[]).push({ ...observeThread(resolvable), detailObserved: !!detail, sourceEntries: detail && relationEvidence(detail, "entries", entryMap) ? entryList.length : undefined, observedEntries: entryList.length, entries: entryList.map(entry => observeEntry(entry, detailUserMap)) });
                if (!detail || !relationEvidence(detail, "entries", entryMap)) native.setRead("incomplete");
                const sortedEntries = entryList
                    .slice()
                    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));
                const latestEntry = sortedEntries[0];
                const contentRaw = latestEntry?.content ? String(latestEntry.content) : "";
                const normalized = contentRaw ? normalizeContent(contentRaw) : "";
                const preview = normalized ? formatPreview(normalized) : "(no entries)";
                const author = latestEntry ? resolveUserName(latestEntry.author) : "Unknown";
                const timestampValue = latestEntry?.createdAt ?? resolvable.createdAt;
                const timestamp = formatDateTime(timestampValue);
                const state = resolvable.isClosed ? "closed" : "open";
                const closedTag = resolvable.isClosed ? " â€¢ Closed" : " â€¢ Open";
                const entryCount = entryList.length;
                const contextLabel = formatResolvableContextLabel(context);
                lines.push(`- ${state.toUpperCase()} ${resolvableId} â€¢ ${contextLabel} â€¢ ${timestamp} â€¢ ${author}${closedTag} â€¢ ${preview}`);

                threadItems.push({
                    id: resolvableId,
                    context,
                    contextLabel,
                    state,
                    createdAt: resolvable.createdAt ?? null,
                    closedAt: resolvable.closedAt ?? null,
                    entryCount,
                    latestEntry: latestEntry
                        ? {
                            entryId: latestEntry.entryId ?? latestEntry.id ?? null,
                            createdAt: latestEntry.createdAt ?? null,
                            author,
                            preview,
                        }
                        : null,
                });
            }
        }

        return toStructuredResult(
            format,
            "card-list-resolvables",
            lines.join("\n"),
            {
                cardId,
                cardStatus: String(card.status ?? "unknown"),
                cardDerivedStatus: String(card.derivedStatus ?? "unknown"),
                shortCode: shortCode || null,
                total: limited.length,
                contexts: orderedContexts,
                contextLabels: orderedContexts.map((value) => formatResolvableContextLabel(value)),
                includeClosed,
                threads: threadItems,
            },
        );
});
export const executeListOpenResolvableCardsPayload = (args: ConversationArguments): Promise<CodecksOperationPayload> => withOperationContextIfMissing(async () => {
        const native = createConversationReadResult("list_open_resolvable_cards");
        const { success: toStructuredResult, failure: toStructuredErrorResult } = native;
        const format = args.format ?? "text";
        let requestedContexts: string[] | undefined;

        if (args.contexts && args.contexts.length > 0)
        {
            const normalized: string[] = [];
            for (const value of args.contexts)
            {
                const contextResult = normalizeResolvableContextInput(value);
                if ("error" in contextResult)
                {
                    return toStructuredErrorResult(format, "list-open-resolvable-cards", "validation_error", contextResult.error);
                }

                normalized.push(contextResult.context);
            }

            requestedContexts = Array.from(new Set(normalized));
        }

        const scanLimit = args.scanLimit ?? 200;
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("cards", { $limit: scanLimit, $order: "-lastUpdatedAt" })]: [
                                "cardId",
                                "accountSeq",
                                "title",
                                "status",
                                "derivedStatus",
                                {
                                    [relationQuery("resolvables", { isClosed: false, $order: ["contextAsPrio", "-createdAt"] })]: [
                                        "id",
                                        "context",
                                        "createdAt",
                                        "isClosed",
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const account = getAccount(payload);
        const cardMap = getEntityMap(data, "card");
        const resolvableMap = getEntityMap(data, "resolvable");
        const cards = extractRelationEntities(account, "cards", cardMap);
        const sourceCardReferences = relationReferenceCount(account, "cards");
        Object.assign(native.facts, { scanLimit, scannedCards: cards.length, sourceCardReferences, relationResolutionComplete: relationEvidence(account, "cards", cardMap), scanLimitReached: sourceCardReferences === undefined ? undefined : sourceCardReferences >= scanLimit, cards: [], groups: [] });
        native.setRead("incomplete");

        const grouped = new Map<string, Array<Record<string, unknown>>>();
        const matchedCards: Array<Record<string, unknown>> = [];
        let openResolvableCount = 0;

        for (const card of cards)
        {
            const resolvables = extractRelationEntities(card, "resolvables", resolvableMap)
                .filter((resolvable) => !resolvable.isClosed);
            if (resolvables.length === 0)
            {
                continue;
            }

            const resolvablesByContext = new Map<string, CodecksEntity[]>();
            for (const resolvable of resolvables)
            {
                const contextValue = String(resolvable.context ?? "").trim().toLowerCase();
                if (!contextValue)
                {
                    continue;
                }

                if (requestedContexts && !requestedContexts.includes(contextValue))
                {
                    continue;
                }

                const list = resolvablesByContext.get(contextValue) ?? [];
                list.push(resolvable);
                resolvablesByContext.set(contextValue, list);
            }

            if (resolvablesByContext.size === 0)
            {
                continue;
            }

            const parsedAccountSeq = typeof card.accountSeq === "number"
                ? card.accountSeq
                : Number.parseInt(String(card.accountSeq ?? ""), 10);
            const accountSeq = Number.isFinite(parsedAccountSeq) ? parsedAccountSeq : null;
            const shortCode = accountSeq !== null ? formatShortCode(accountSeq) : "";
            const url = shortCode ? formatCardUrl(shortCode) : "";
            const contextCounts = Array.from(resolvablesByContext.entries()).map(([context, entries]) => ({
                context,
                contextLabel: formatResolvableContextLabel(context),
                count: entries.length,
                resolvableIds: entries
                    .map((entry) => String(entry.id ?? "").trim())
                    .filter((value) => value.length > 0),
                latestCreatedAt: entries
                    .map((entry) => String(entry.createdAt ?? ""))
                    .filter((value) => value.length > 0)
                    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null,
            }));
            const totalOpenResolvables = contextCounts.reduce((sum, entry) => sum + Number(entry.count ?? 0), 0);
            openResolvableCount += totalOpenResolvables;

            const cardItem = {
                cardId: String(card.cardId ?? ""),
                accountSeq,
                shortCode: shortCode || null,
                url: url || null,
                title: String(card.title ?? "(untitled)"),
                status: String(card.status ?? "unknown"),
                derivedStatus: String(card.derivedStatus ?? "unknown"),
                totalOpenResolvables,
                contexts: contextCounts,
            };
            matchedCards.push(cardItem);
            (native.facts.cards as unknown[]).push({ ...observeCard(card), sourceThreads: totalOpenResolvables, threads: Array.from(resolvablesByContext.values()).flat().map(observeThread) });

            for (const contextEntry of contextCounts)
            {
                const context = String(contextEntry.context);
                const list = grouped.get(context) ?? [];
                list.push({
                    ...cardItem,
                    context: contextEntry.context,
                    contextLabel: contextEntry.contextLabel,
                    contextCount: contextEntry.count,
                    resolvableIds: contextEntry.resolvableIds,
                    latestCreatedAt: contextEntry.latestCreatedAt,
                });
                grouped.set(context, list);
            }
        }

        if (matchedCards.length === 0)
        {
            Object.assign(native.facts, { matchedCards: 0, openResolvables: 0, emittedCards: 0 });
            return toStructuredErrorResult(
                format,
                "list-open-resolvable-cards",
                "not_found",
                "No cards with open resolvables matched the search criteria.",
                { scanLimit, contexts: requestedContexts ?? null },
            );
        }

        const limit = args.limit ?? 100;
        const defaultOrder = ["review", "comment", "block"];
        const orderedContexts: string[] = [];
        const priorityOrder = requestedContexts ?? defaultOrder;

        for (const context of priorityOrder)
        {
            if (grouped.has(context))
            {
                orderedContexts.push(context);
            }
        }

        for (const context of grouped.keys())
        {
            if (!orderedContexts.includes(context))
            {
                orderedContexts.push(context);
            }
        }

        const limitedGroups = orderedContexts.map((context) =>
        {
            const entries = (grouped.get(context) ?? []).slice(0, limit);
            return {
                context,
                contextLabel: formatResolvableContextLabel(context),
                total: (grouped.get(context) ?? []).length,
                cards: entries,
            };
        }).filter((entry) => entry.cards.length > 0);

        Object.assign(native.facts, { matchedCards: matchedCards.length, openResolvables: openResolvableCount, emittedCards: Math.min(matchedCards.length, limit), groups: limitedGroups.map(group => ({ context: group.context, sourceCards: group.total, emittedCards: group.cards.length, cardIds: group.cards.map(card => card.cardId) })) });
        native.facts.cards = (native.facts.cards as unknown[]).slice(0, limit);
        const totalReturnedCards = limitedGroups.reduce((sum, entry) => sum + entry.cards.length, 0);
        const lines = [
            "## Open Resolvable Cards",
            "",
            `- Scanned Cards: ${cards.length}`,
            `- Matched Cards: ${matchedCards.length}`,
            `- Open Resolvables: ${openResolvableCount}`,
            `- Contexts: ${(limitedGroups.map((entry) => entry.contextLabel).join(", ")) || "(none)"}`,
            `- Per-Context Limit: ${limit}`,
            `- Scan Limit: ${scanLimit}`,
        ];

        for (const group of limitedGroups)
        {
            const header = group.contextLabel.charAt(0).toUpperCase() + group.contextLabel.slice(1);
            lines.push("", `### ${header} (${group.total})`);

            for (const card of group.cards)
            {
                const shortCode = String(card.shortCode ?? "");
                const title = String(card.title ?? "(untitled)");
                const contextCount = Number(card.contextCount ?? 0);
                const status = String(card.status ?? "unknown");
                const derivedStatus = String(card.derivedStatus ?? "unknown");
                lines.push(`- ${shortCode || "(n/a)"} â€¢ ${title} â€¢ ${contextCount} open ${group.contextLabel}${contextCount === 1 ? "" : "s"} â€¢ ${status} / ${derivedStatus}`);
            }
        }

        return toStructuredResult(
            format,
            "list-open-resolvable-cards",
            lines.join("\n"),
            {
                scanLimit,
                scannedCards: cards.length,
                matchedCards: matchedCards.length,
                openResolvables: openResolvableCount,
                returnedCards: totalReturnedCards,
                contexts: limitedGroups.map((entry) => entry.context),
                contextLabels: limitedGroups.map((entry) => entry.contextLabel),
                groups: limitedGroups,
                cards: matchedCards.slice(0, limit),
            },
        );
});
export const executeListLoggedInUserActionableResolvablesPayload = (args: ConversationArguments): Promise<CodecksOperationPayload> => withOperationContextIfMissing(async () => {
        const native = createConversationReadResult("list_logged_in_user_actionable_resolvables");
        const { success: toStructuredResult, failure: toStructuredErrorResult } = native;
        const format = args.format ?? "text";
        let requestedContexts: string[] | undefined;

        if (args.contexts && args.contexts.length > 0)
        {
            const normalized: string[] = [];
            for (const value of args.contexts)
            {
                const contextResult = normalizeResolvableContextInput(value);
                if ("error" in contextResult)
                {
                    return toStructuredErrorResult(format, "list-logged-in-user-actionable-resolvables", "validation_error", contextResult.error);
                }

                normalized.push(contextResult.context);
            }

            requestedContexts = Array.from(new Set(normalized));
        }

        let loggedInUser: CodecksUser;
        try
        {
            loggedInUser = await fetchLoggedInUser();
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "list-logged-in-user-actionable-resolvables", "api_error", toErrorMessage(error));
        }

        const loggedInUserId = String(loggedInUser.id ?? "").trim();
        if (!loggedInUserId)
        {
            return toStructuredErrorResult(format, "list-logged-in-user-actionable-resolvables", "api_error", "Unable to resolve logged-in user id.");
        }

        const scanLimit = args.scanLimit ?? 200;
        const staleAfterHours = args.staleAfterHours ?? 24;
        const staleThresholdMs = staleAfterHours * 60 * 60 * 1000;
        const now = Date.now();
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("cards", { $limit: scanLimit, $order: "-lastUpdatedAt" })]: [
                                "cardId",
                                "accountSeq",
                                "title",
                                "status",
                                "derivedStatus",
                                { assignee: ["id", "name", "fullName"] },
                                { creator: ["id", "name", "fullName"] },
                                {
                                    [relationQuery("resolvables", { isClosed: false, $order: ["contextAsPrio", "-createdAt"] })]: [
                                        "id",
                                        "context",
                                        "createdAt",
                                        "isClosed",
                                        { creator: ["id", "name", "fullName"] },
                                        {
                                            [relationQuery("entries", { $limit: 3, $order: "-createdAt" })]: [
                                                "entryId",
                                                "content",
                                                "createdAt",
                                                { author: ["id", "name", "fullName"] },
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const account = getAccount(payload);
        const cardMap = getEntityMap(data, "card");
        const userMap = getEntityMap(data, "user");
        const resolvableMap = getEntityMap(data, "resolvable");
        const entryMap = getEntityMap(data, "resolvableEntry");
        const cards = extractRelationEntities(account, "cards", cardMap);
        const sourceCardReferences = relationReferenceCount(account, "cards");
        Object.assign(native.facts, { scanLimit, scannedCards: cards.length, sourceCardReferences, relationResolutionComplete: relationEvidence(account, "cards", cardMap), scanLimitReached: sourceCardReferences === undefined ? undefined : sourceCardReferences >= scanLimit, groups: [] });
        native.setRead("incomplete");

        Object.assign(native.facts, { userId: loggedInUserId, staleAfterHours, items: [] });
        const resolveUserEntity = (value: unknown): CodecksEntity | undefined =>
        {
            return resolveFromMap(value, userMap);
        };

        const toTimestamp = (value: unknown): number =>
        {
            const date = new Date(String(value ?? ""));
            return Number.isNaN(date.getTime()) ? 0 : date.getTime();
        };

        const normalizeContent = (content: string): string =>
        {
            return content.replace(/\s+/g, " ").trim();
        };

        const truncate = (content: string, maxLength: number): string =>
        {
            if (content.length <= maxLength)
            {
                return content;
            }

            return `${content.slice(0, Math.max(0, maxLength - 3))}...`;
        };

        const grouped = new Map<string, Map<string, Record<string, unknown>>>();
        const actionableItems: Array<Record<string, unknown>> = [];
        let waitingOnUserCount = 0;
        let resurfacedCount = 0;
        let unreadCount = 0;
        let readCount = 0;
        let staleReviewCount = 0;

        for (const card of cards)
        {
            const parsedAccountSeq = typeof card.accountSeq === "number"
                ? card.accountSeq
                : Number.parseInt(String(card.accountSeq ?? ""), 10);
            const accountSeq = Number.isFinite(parsedAccountSeq) ? parsedAccountSeq : null;
            const shortCode = accountSeq !== null ? formatShortCode(accountSeq) : "";
            const url = shortCode ? formatCardUrl(shortCode) : "";
            const cardAssignee = resolveUserEntity(card.assignee);
            const cardCreator = resolveUserEntity(card.creator);
            const openResolvables = extractRelationEntities(card, "resolvables", resolvableMap)
                .filter((resolvable) => !resolvable.isClosed);

            for (const resolvable of openResolvables)
            {
                const context = String(resolvable.context ?? "").trim().toLowerCase();
                if (!context)
                {
                    continue;
                }

                if (requestedContexts && !requestedContexts.includes(context))
                {
                    continue;
                }

                const entryList = extractRelationEntities(resolvable, "entries", entryMap)
                    .slice()
                    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));
                const latestEntry = entryList[0];
                const latestAuthor = resolveUserEntity(latestEntry?.author);
                const latestAuthorId = String(latestAuthor?.id ?? latestEntry?.author ?? "").trim();
                const latestContentRaw = latestEntry?.content ? String(latestEntry.content) : "";
                const latestContent = normalizeContent(latestContentRaw);
                const latestPreview = latestContent ? truncate(latestContent, 160) : "(no sampled entries)";
                const latestActivityAt = latestEntry?.createdAt ?? resolvable.createdAt ?? null;
                const latestActivityTs = toTimestamp(latestActivityAt);
                const latestMentionsLoggedInUser = latestContentRaw.includes(`[userId:${loggedInUserId}]`);
                const cardAssigneeId = String(cardAssignee?.id ?? "").trim();
                const cardCreatorId = String(cardCreator?.id ?? "").trim();
                const resolvableCreator = resolveUserEntity(resolvable.creator);
                const resolvableCreatorId = String(resolvableCreator?.id ?? "").trim();
                const participantIds = Array.from(new Set(entryList
                    .map((entry) =>
                    {
                        const author = resolveUserEntity(entry.author);
                        return String(author?.id ?? entry.author ?? "").trim();
                    })
                    .concat([resolvableCreatorId, cardAssigneeId, cardCreatorId])
                    .filter((value) => value.length > 0)));
                const participantNames = participantIds.map((participantId) =>
                {
                    const user = userMap[participantId];
                    return String(user?.fullName ?? user?.name ?? participantId);
                });
                const latestByLoggedInUser = latestAuthorId === loggedInUserId;
                const latestByOtherUser = latestAuthorId.length > 0 && latestAuthorId !== loggedInUserId;
                const cardAssigneeIsLoggedInUser = cardAssigneeId === loggedInUserId;
                const cardCreatorIsLoggedInUser = cardCreatorId === loggedInUserId;
                const resolvableCreatorIsLoggedInUser = resolvableCreatorId === loggedInUserId;
                const userAppearsInSampleParticipants = participantIds.includes(loggedInUserId);

                let bucket: ResolvableActionBucket | null = null;
                let reason = "";

                if (latestByOtherUser && latestMentionsLoggedInUser)
                {
                    bucket = "new_activity";
                    reason = "latest_other_and_mentions_logged_in_user";
                }
                else if (latestByOtherUser && cardAssigneeIsLoggedInUser)
                {
                    bucket = "new_activity";
                    reason = "latest_other_and_card_assigned_to_logged_in_user";
                }
                else if (latestByOtherUser && cardCreatorIsLoggedInUser)
                {
                    bucket = "new_activity";
                    reason = "latest_other_and_card_created_by_logged_in_user";
                }
                else if (latestByOtherUser && resolvableCreatorIsLoggedInUser)
                {
                    bucket = "new_activity";
                    reason = "latest_other_and_resolvable_created_by_logged_in_user";
                }
                else if (latestByOtherUser && userAppearsInSampleParticipants)
                {
                    bucket = "new_activity";
                    reason = "latest_other_and_prior_participant";
                }
                else if (latestByLoggedInUser && latestActivityTs > 0 && (now - latestActivityTs) >= staleThresholdMs)
                {
                    bucket = "resurfaced";
                    reason = "stale_self_authored_open_thread";
                }

                if (!bucket)
                {
                    continue;
                }

                if (bucket === "new_activity")
                {
                    waitingOnUserCount += 1;
                }
                else
                {
                    resurfacedCount += 1;
                }

                const bubbleHeuristic = computeResolvableBubbleHeuristic({ bucket, context });
                if (bubbleHeuristic === "unread")
                {
                    unreadCount += 1;
                }
                else if (bubbleHeuristic === "read")
                {
                    readCount += 1;
                }
                else
                {
                    staleReviewCount += 1;
                }

                const item = {
                    cardId: String(card.cardId ?? ""),
                    accountSeq,
                    shortCode: shortCode || null,
                    url: url || null,
                    title: String(card.title ?? "(untitled)"),
                    ownerName: String((cardAssignee?.fullName ?? cardAssignee?.name ?? cardAssigneeId) || "Unknown"),
                    status: String(card.status ?? "unknown"),
                    derivedStatus: String(card.derivedStatus ?? "unknown"),
                    resolvableId: String(resolvable.id ?? ""),
                    context,
                    contextLabel: formatResolvableContextLabel(context),
                    bucket,
                    reason,
                    bubbleHeuristic,
                    latestActivityAt,
                    latestActivityAtFormatted: formatDateTime(latestActivityAt),
                    latestEntryAuthor: (latestAuthor?.fullName ?? latestAuthor?.name ?? latestAuthorId) || "Unknown",
                    latestEntryAuthorId: latestAuthorId || null,
                    latestEntryPreview: latestPreview,
                    participantNames,
                    latestEntryByLoggedInUser: latestByLoggedInUser,
                    latestEntryByOtherUser: latestByOtherUser,
                    latestEntryMentionsLoggedInUser: latestMentionsLoggedInUser,
                    participantSampleIncludesLoggedInUser: userAppearsInSampleParticipants,
                    cardAssigneeIsLoggedInUser,
                    cardCreatorIsLoggedInUser,
                    resolvableCreatedByLoggedInUser: resolvableCreatorIsLoggedInUser,
                };
                actionableItems.push(item);
                (native.facts.items as unknown[]).push({ card: observeCard(card), thread: observeThread(resolvable), latestEntry: latestEntry ? observeEntry(latestEntry, userMap) : undefined, bucket, reason, bubbleHeuristic, latestActivityAt, latestEntryByLoggedInUser: latestByLoggedInUser, latestEntryByOtherUser: latestByOtherUser, latestEntryMentionsLoggedInUser: latestMentionsLoggedInUser, participantSampleIncludesLoggedInUser: userAppearsInSampleParticipants });

                const groupedByContext = grouped.get(context) ?? new Map<string, Record<string, unknown>>();
                const existing = groupedByContext.get(String(card.cardId ?? ""));
                if (!existing)
                {
                    groupedByContext.set(String(card.cardId ?? ""), {
                        cardId: String(card.cardId ?? ""),
                        accountSeq,
                        shortCode: shortCode || null,
                        url: url || null,
                        title: String(card.title ?? "(untitled)"),
                        ownerName: String((cardAssignee?.fullName ?? cardAssignee?.name ?? cardAssigneeId) || "Unknown"),
                        status: String(card.status ?? "unknown"),
                        derivedStatus: String(card.derivedStatus ?? "unknown"),
                        context,
                        contextLabel: formatResolvableContextLabel(context),
                        actionableCount: 1,
                        newActivityCount: bucket === "new_activity" ? 1 : 0,
                        resurfacedCount: bucket === "resurfaced" ? 1 : 0,
                        latestActivityAt,
                        latestActivityAtFormatted: formatDateTime(latestActivityAt),
                        reasons: [reason],
                        buckets: [bucket],
                        bubbleHeuristics: [bubbleHeuristic],
                        resolvableIds: [String(resolvable.id ?? "")],
                        latestEntryAuthors: [((latestAuthor?.fullName ?? latestAuthor?.name ?? latestAuthorId) || "Unknown")],
                        participantNames,
                        preview: latestPreview,
                    });
                }
                else
                {
                    const reasons = Array.isArray(existing.reasons) ? existing.reasons as unknown[] : [];
                    const buckets = Array.isArray(existing.buckets) ? existing.buckets as unknown[] : [];
                    const bubbleHeuristics = Array.isArray(existing.bubbleHeuristics) ? existing.bubbleHeuristics as unknown[] : [];
                    const resolvableIds = Array.isArray(existing.resolvableIds) ? existing.resolvableIds as unknown[] : [];
                    const latestEntryAuthors = Array.isArray(existing.latestEntryAuthors) ? existing.latestEntryAuthors as unknown[] : [];
                    const participantNamesExisting = Array.isArray(existing.participantNames) ? existing.participantNames as unknown[] : [];
                    existing.actionableCount = Number(existing.actionableCount ?? 0) + 1;
                    existing.newActivityCount = Number(existing.newActivityCount ?? 0) + (bucket === "new_activity" ? 1 : 0);
                    existing.resurfacedCount = Number(existing.resurfacedCount ?? 0) + (bucket === "resurfaced" ? 1 : 0);
                    if (latestActivityTs > toTimestamp(existing.latestActivityAt))
                    {
                        existing.latestActivityAt = latestActivityAt;
                        existing.latestActivityAtFormatted = formatDateTime(latestActivityAt);
                        existing.preview = latestPreview;
                    }
                    existing.reasons = Array.from(new Set([...reasons.map((value) => String(value)), reason]));
                    existing.buckets = Array.from(new Set([...buckets.map((value) => String(value)), bucket]));
                    existing.bubbleHeuristics = Array.from(new Set([...bubbleHeuristics.map((value) => String(value)), bubbleHeuristic]));
                    existing.resolvableIds = Array.from(new Set([...resolvableIds.map((value) => String(value)), String(resolvable.id ?? "")]));
                    existing.latestEntryAuthors = Array.from(new Set([...latestEntryAuthors.map((value) => String(value)), ((latestAuthor?.fullName ?? latestAuthor?.name ?? latestAuthorId) || "Unknown")]));
                    existing.participantNames = Array.from(new Set([...participantNamesExisting.map((value) => String(value)), ...participantNames]));
                }

                grouped.set(context, groupedByContext);
            }
        }

        if (actionableItems.length === 0)
        {
            Object.assign(native.facts, { actionableResolvableCount: 0, waitingOnUserCount: 0, resurfacedCount: 0, bubbleSummary: { unread: 0, read: 0, stale_review: 0 } });
            return toStructuredErrorResult(
                format,
                "list-logged-in-user-actionable-resolvables",
                "not_found",
                "No actionable open resolvables matched the heuristic criteria.",
                { scanLimit, staleAfterHours, contexts: requestedContexts ?? null, userId: loggedInUserId },
            );
        }

        const limit = args.limit ?? 100;
        const defaultOrder = ["review", "comment", "block"];
        const orderedContexts: string[] = [];
        const priorityOrder = requestedContexts ?? defaultOrder;

        for (const context of priorityOrder)
        {
            if (grouped.has(context))
            {
                orderedContexts.push(context);
            }
        }

        for (const context of grouped.keys())
        {
            if (!orderedContexts.includes(context))
            {
                orderedContexts.push(context);
            }
        }

        const groups = orderedContexts.map((context) =>
        {
            const cardsForContext = Array.from((grouped.get(context) ?? new Map<string, Record<string, unknown>>()).values())
                .sort((left, right) => toTimestamp(right.latestActivityAt) - toTimestamp(left.latestActivityAt));
            return {
                context,
                contextLabel: formatResolvableContextLabel(context),
                total: cardsForContext.length,
                cards: cardsForContext.slice(0, limit),
            };
        }).filter((entry) => entry.cards.length > 0);

        Object.assign(native.facts, { actionableResolvableCount: actionableItems.length, waitingOnUserCount, resurfacedCount, bubbleSummary: { unread: unreadCount, read: readCount, stale_review: staleReviewCount }, groups: groups.map(group => ({ context: group.context, sourceCards: group.total, emittedCards: group.cards.length, cardIds: group.cards.map(card => card.cardId) })) });
        const warnings = [
            "Heuristic result only: exact per-user unread/snooze/inbox state is not currently exposed by the stable query surfaces this tool can access.",
            `Resurfaced threads are approximated as self-authored still-open threads with no sampled updates for at least ${staleAfterHours} hour(s).`,
        ];

        const lines = [
            "## Logged-in User Actionable Resolvables",
            "",
            `- User: ${loggedInUser.fullName ?? loggedInUser.name ?? "(unknown)"}`,
            `- User ID: ${loggedInUserId}`,
            `- Scanned Cards: ${cards.length}`,
            `- Actionable Resolvables: ${actionableItems.length}`,
            `- New Activity: ${waitingOnUserCount}`,
            `- Resurfaced: ${resurfacedCount}`,
            `- Bubble Heuristic: unread=${unreadCount}, read=${readCount}, stale_review=${staleReviewCount}`,
            `- Stale After Hours: ${staleAfterHours}`,
            `- Contexts: ${(groups.map((entry) => entry.contextLabel).join(", ")) || "(none)"}`,
            `- Per-Context Limit: ${limit}`,
            `- Scan Limit: ${scanLimit}`,
        ];

        for (const group of groups)
        {
            const header = group.contextLabel.charAt(0).toUpperCase() + group.contextLabel.slice(1);
            lines.push("", `### ${header} (${group.total})`);

            for (const card of group.cards)
            {
                const shortCodeLabel = String(card.shortCode ?? "") || "(n/a)";
                const title = String(card.title ?? "(untitled)");
                const ownerName = String(card.ownerName ?? "Unknown");
                const actionableCount = Number(card.actionableCount ?? 0);
                const buckets = Array.isArray(card.buckets) ? (card.buckets as unknown[]).map((value) => String(value)).join(", ") : "unknown";
                const reasons = Array.isArray(card.reasons) ? (card.reasons as unknown[]).map((value) => String(value)).join(", ") : "unknown";
                const bubbleHeuristics = Array.isArray(card.bubbleHeuristics) ? (card.bubbleHeuristics as unknown[]).map((value) => String(value)).join(", ") : "unknown";
                lines.push(`- ${shortCodeLabel} â€¢ ${ownerName} â€¢ ${title} â€¢ ${actionableCount} actionable â€¢ bubble=${bubbleHeuristics} â€¢ ${buckets} â€¢ ${reasons}`);
                const latestEntryAuthors = Array.isArray(card.latestEntryAuthors) ? (card.latestEntryAuthors as unknown[]).map((value) => String(value)) : [];
                const participantNames = Array.isArray(card.participantNames) ? (card.participantNames as unknown[]).map((value) => String(value)) : [];
                const highlightedParticipants = participantNames.map((name) => latestEntryAuthors.includes(name) ? `â†’ ${name}` : name).join(", ");
                lines.push(`  participants: ${highlightedParticipants || "(unknown)"}`);
                lines.push(`  latest ${String(card.latestActivityAtFormatted ?? "") || "(unknown time)"} â€¢ ${String(card.preview ?? "(no preview)")}`);
            }
        }

        return toStructuredResult(
            format,
            "list-logged-in-user-actionable-resolvables",
            lines.join("\n"),
            {
                user: {
                    id: loggedInUserId,
                    name: loggedInUser.name ?? null,
                    fullName: loggedInUser.fullName ?? null,
                },
                scanLimit,
                scannedCards: cards.length,
                staleAfterHours,
                actionableResolvableCount: actionableItems.length,
                waitingOnUserCount,
                resurfacedCount,
                bubbleSummary: {
                    unread: unreadCount,
                    read: readCount,
                    stale_review: staleReviewCount,
                },
                contexts: groups.map((entry) => entry.context),
                contextLabels: groups.map((entry) => entry.contextLabel),
                groups,
                items: actionableItems,
            },
            warnings,
        );
});
