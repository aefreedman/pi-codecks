import { fetchLoggedInUser } from "../../runtime/identity";
import { runQuery } from "../../runtime/transport";
import { formatShortCode } from "../../shared/card-reference";
import { extractRelationEntities, getEntityMap, resolveFromMap } from "../../shared/entity-maps";
import { formatDateTime, formatResolvableContextLabel } from "../../shared/presentation";
import { formatIdForQuery, getAccount, getRelation, getRoot, normalizeCollection, normalizeEntity, relationQuery, unwrapData } from "../../shared/query";
import { toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { outputFormatArg, tool } from "../../pi-tool-compat";
import { type CodecksEntity, type CodecksUser } from "../../shared/types";
import { formatCardUrl } from "../../shared/urls";
import { type ResolvableActionBucket, computeResolvableBubbleHeuristic, resolvableDebugRelations, userDebugRelations } from "./helpers";

export const debug_logged_in_user_resolvable_participation = tool({
    description: "Probe participant/subscription/opt-out signals for logged-in-user attention-worthy resolvables and estimate bubble states.",
    args: {
        scanLimit: tool.schema.number().min(1).max(1000).optional().describe("Maximum number of recent cards to scan for open resolvables."),
        detailLimit: tool.schema.number().min(1).max(100).optional().describe("Maximum number of attention-worthy resolvables to include in the diagnostic sample."),
        relationProbeLimit: tool.schema.number().min(1).max(50).optional().describe("Maximum number of items to request for each sample resolvable relation probe."),
        staleAfterHours: tool.schema.number().min(1).max(24 * 30).optional().describe("Treat self-authored still-open threads older than this as resurfaced/actionable."),
        probeResolvableRelations: tool.schema.array(tool.schema.string()).optional().describe("Optional sample resolvable relation names to probe individually."),
        probeResolvableFields: tool.schema.array(tool.schema.string()).optional().describe("Optional sample resolvable scalar fields to probe individually."),
        includePayload: tool.schema.boolean().optional().describe("Include compact raw payload snippets for successful probes."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const scanLimit = args.scanLimit ?? 200;
        const detailLimit = args.detailLimit ?? 25;
        const relationProbeLimit = args.relationProbeLimit ?? 10;
        const staleAfterHours = args.staleAfterHours ?? 24;
        const staleThresholdMs = staleAfterHours * 60 * 60 * 1000;
        const includePayload = args.includePayload ?? false;
        const now = Date.now();
        const defaultRelationProbes = ["participants", "participantUsers", "subscribers", "followers", "watchers", "members", "conversationParticipants", "subscriptions", "reads", "snoozes"];
        const defaultFieldProbes = ["leftAt", "left", "isMuted", "muted", "isSubscribed", "subscribed", "isFollowing", "following", "participantIds", "watcherIds"];
        const probeResolvableRelations = Array.from(new Set((args.probeResolvableRelations ?? defaultRelationProbes)
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)));
        const probeResolvableFields = Array.from(new Set((args.probeResolvableFields ?? defaultFieldProbes)
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)));
        const warnings: string[] = [];

        let loggedInUser: CodecksUser;
        try
        {
            loggedInUser = await fetchLoggedInUser();
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "debug-logged-in-user-resolvable-participation", "api_error", toErrorMessage(error));
        }

        const loggedInUserId = String(loggedInUser.id ?? "").trim();
        if (!loggedInUserId)
        {
            return toStructuredErrorResult(format, "debug-logged-in-user-resolvable-participation", "api_error", "Unable to resolve logged-in user id.");
        }

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

        const resolveUserEntity = (value: unknown): CodecksEntity | undefined => resolveFromMap(value, userMap);
        const toTimestamp = (value: unknown): number =>
        {
            const date = new Date(String(value ?? ""));
            return Number.isNaN(date.getTime()) ? 0 : date.getTime();
        };
        const normalizeContent = (content: string): string => content.replace(/\s+/g, " ").trim();
        const truncate = (content: string, maxLength: number): string =>
        {
            if (content.length <= maxLength)
            {
                return content;
            }

            return `${content.slice(0, Math.max(0, maxLength - 3))}...`;
        };

        const actionableItems: Array<Record<string, unknown>> = [];

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
                const context = String(resolvable.context ?? "unknown").trim().toLowerCase();
                const entryList = extractRelationEntities(resolvable, "entries", entryMap)
                    .slice()
                    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));
                const latestEntry = entryList[0];
                const latestAuthor = resolveUserEntity(latestEntry?.author);
                const latestAuthorId = String(latestAuthor?.id ?? latestEntry?.author ?? "").trim();
                const latestContentRaw = latestEntry?.content ? String(latestEntry.content) : "";
                const latestPreview = latestContentRaw ? truncate(normalizeContent(latestContentRaw), 160) : "(no sampled entries)";
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

                const bubbleHeuristic = computeResolvableBubbleHeuristic({ bucket, context });

                actionableItems.push({
                    cardId: String(card.cardId ?? ""),
                    accountSeq,
                    shortCode: shortCode || null,
                    url: url || null,
                    title: String(card.title ?? "(untitled)"),
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
                    latestEntryPreview: latestPreview,
                    latestEntryByLoggedInUser: latestByLoggedInUser,
                    latestEntryByOtherUser: latestByOtherUser,
                    latestEntryMentionsLoggedInUser: latestMentionsLoggedInUser,
                    participantSampleUserIds: participantIds,
                    participantSampleIncludesLoggedInUser: userAppearsInSampleParticipants,
                    cardAssigneeIsLoggedInUser,
                    cardCreatorIsLoggedInUser,
                    resolvableCreatedByLoggedInUser: resolvableCreatorIsLoggedInUser,
                });
            }
        }

        actionableItems.sort((left, right) => toTimestamp(right.latestActivityAt) - toTimestamp(left.latestActivityAt));
        const sampleItems = actionableItems.slice(0, detailLimit);
        const sampleResolvableId = sampleItems.length > 0 ? String(sampleItems[0].resolvableId ?? "").trim() : "";
        const sampleKey = sampleResolvableId ? `resolvable(${formatIdForQuery(sampleResolvableId)})` : "";

        const resolvableRelationProbes: Array<Record<string, unknown>> = [];
        if (sampleResolvableId)
        {
            for (const relation of probeResolvableRelations)
            {
                const relationName = String(relation).trim();
                if (!relationName)
                {
                    continue;
                }

                const supported = resolvableDebugRelations[relationName];
                if (!supported)
                {
                    const error = `Unsupported resolvable probe relation '${relationName}'; only known ordered hasMany relations may be paginated.`;
                    warnings.push(error);
                    resolvableRelationProbes.push({ relation: relationName, ok: false, error });
                    continue;
                }
                const relationKey = relationQuery(relationName, { $order: supported.order, $limit: relationProbeLimit });
                const probeQuery = {
                    [sampleKey]: [
                        "id",
                        "context",
                        {
                            [relationKey]: supported.fields,
                        },
                    ],
                };

                try
                {
                    const probePayload = await runQuery(probeQuery);
                    const probeData = unwrapData(probePayload) as Record<string, unknown> | undefined;
                    const probeResolvableMap = getEntityMap(probeData, "resolvable");
                    const rawResolvable = probeResolvableMap[sampleResolvableId]
                        ?? resolveFromMap(probeData ? probeData[sampleKey] : undefined, probeResolvableMap)
                        ?? (probeData ? (probeData.resolvable as CodecksEntity | undefined) : undefined);
                    const relationValues = normalizeCollection(getRelation(rawResolvable, relationName) as unknown[] | undefined);
                    resolvableRelationProbes.push({
                        relation: relationName,
                        ok: true,
                        itemCount: relationValues.length,
                        sampleValues: relationValues.slice(0, 5),
                        payload: includePayload ? probeData ?? null : undefined,
                    });
                }
                catch (error)
                {
                    const message = toErrorMessage(error);
                    warnings.push(`sample resolvable relation ${relationName} probe failed: ${message}`);
                    resolvableRelationProbes.push({ relation: relationName, ok: false, error: message });
                }
            }
        }
        else
        {
            warnings.push("No attention-worthy resolvables were found in the scanned card window, so sample resolvable relation probes were skipped.");
        }

        const resolvableFieldProbes: Array<Record<string, unknown>> = [];
        if (sampleResolvableId)
        {
            for (const field of probeResolvableFields)
            {
                const fieldName = String(field).trim();
                if (!fieldName)
                {
                    continue;
                }

                const probeQuery = {
                    [sampleKey]: ["id", "context", fieldName],
                };

                try
                {
                    const probePayload = await runQuery(probeQuery);
                    const probeData = unwrapData(probePayload) as Record<string, unknown> | undefined;
                    const probeResolvableMap = getEntityMap(probeData, "resolvable");
                    const rawResolvable = probeResolvableMap[sampleResolvableId]
                        ?? resolveFromMap(probeData ? probeData[sampleKey] : undefined, probeResolvableMap)
                        ?? (probeData ? (probeData.resolvable as CodecksEntity | undefined) : undefined);
                    const value = rawResolvable ? rawResolvable[fieldName] : undefined;
                    resolvableFieldProbes.push({
                        field: fieldName,
                        ok: true,
                        hasValue: value !== undefined,
                        value: value ?? null,
                        payload: includePayload ? probeData ?? null : undefined,
                    });
                }
                catch (error)
                {
                    const message = toErrorMessage(error);
                    warnings.push(`sample resolvable field ${fieldName} probe failed: ${message}`);
                    resolvableFieldProbes.push({ field: fieldName, ok: false, error: message });
                }
            }
        }

        const lines = [
            "## Logged-in User Resolvable Participation Debug",
            "",
            `- User: ${loggedInUser.fullName ?? loggedInUser.name ?? "(unknown)"}`,
            `- User ID: ${loggedInUserId}`,
            `- Scanned Cards: ${cards.length}`,
            `- Actionable Resolvables: ${actionableItems.length}`,
            `- Sample Size: ${sampleItems.length}`,
            `- Sample Resolvable: ${sampleResolvableId || "(none)"}`,
            `- Resolvable Relation Probes: ${resolvableRelationProbes.length}`,
            `- Resolvable Field Probes: ${resolvableFieldProbes.length}`,
            `- Stale After Hours: ${staleAfterHours}`,
            "",
            "### Sample Actionable Resolvables",
        ];

        for (const item of sampleItems)
        {
            lines.push(`- ${String(item.shortCode ?? "(n/a)")} â€¢ ${String(item.contextLabel ?? "unknown")} â€¢ ${String(item.title ?? "(untitled)")} â€¢ ${String(item.bucket ?? "unknown")} â€¢ bubble=${String(item.bubbleHeuristic ?? "unknown")}`);
            lines.push(`  latest ${String(item.latestActivityAtFormatted ?? "") || "(unknown time)"} â€¢ ${String(item.latestEntryAuthor ?? "Unknown")} â€¢ ${String(item.reason ?? "unknown")}`);
            lines.push(`  ${String(item.latestEntryPreview ?? "(no preview)")}`);
        }

        if (resolvableRelationProbes.length > 0)
        {
            lines.push("", `### Sample Resolvable Relation Probes (${sampleResolvableId})`);
            for (const probe of resolvableRelationProbes)
            {
                if (probe.ok)
                {
                    lines.push(`- SUCCESS ${String(probe.relation ?? "(unknown)")} â€¢ count=${String(probe.itemCount ?? 0)} â€¢ sample=${JSON.stringify(probe.sampleValues ?? [])}`);
                }
                else
                {
                    lines.push(`- FAIL ${String(probe.relation ?? "(unknown)")} â€¢ ${String(probe.error ?? "Unknown error")}`);
                }
            }
        }

        if (resolvableFieldProbes.length > 0)
        {
            lines.push("", `### Sample Resolvable Field Probes (${sampleResolvableId})`);
            for (const probe of resolvableFieldProbes)
            {
                if (probe.ok)
                {
                    lines.push(`- SUCCESS ${String(probe.field ?? "(unknown)")} â€¢ hasValue=${probe.hasValue ? "yes" : "no"} â€¢ value=${JSON.stringify(probe.value ?? null)}`);
                }
                else
                {
                    lines.push(`- FAIL ${String(probe.field ?? "(unknown)")} â€¢ ${String(probe.error ?? "Unknown error")}`);
                }
            }
        }

        if (warnings.length > 0)
        {
            lines.push("", "### Warnings", ...warnings.map((warning) => `- ${warning}`));
        }

        return toStructuredResult(
            format,
            "debug-logged-in-user-resolvable-participation",
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
                sampleSize: sampleItems.length,
                sampleResolvableId: sampleResolvableId || null,
                sampleActionableResolvables: sampleItems,
                resolvableRelationProbes,
                resolvableFieldProbes,
                warnings,
            },
            warnings,
        );
    },
});

export const debug_logged_in_user_resolvables = tool({
    description: "Probe logged-in-user resolvable inbox state, including likely unread/snooze surfaces and thread metadata.",
    args: {
        scanLimit: tool.schema.number().min(1).max(1000).optional().describe("Maximum number of recent cards to scan for open resolvables."),
        detailLimit: tool.schema.number().min(1).max(200).optional().describe("Maximum number of open resolvables to include in the diagnostic sample."),
        relationProbeLimit: tool.schema.number().min(1).max(50).optional().describe("Maximum number of items to request for each loggedInUser relation probe."),
        probeRelations: tool.schema.array(tool.schema.string()).optional().describe("Optional loggedInUser relation names to probe individually."),
        probeFields: tool.schema.array(tool.schema.string()).optional().describe("Optional scalar field names to probe individually on a sample resolvable."),
        includePayload: tool.schema.boolean().optional().describe("Include compact raw payload snippets for successful probes."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const scanLimit = args.scanLimit ?? 100;
        const detailLimit = args.detailLimit ?? 25;
        const relationProbeLimit = args.relationProbeLimit ?? 10;
        const includePayload = args.includePayload ?? false;
        const defaultRelationProbes = ["resolvables", "conversations", "unreadResolvables", "snoozedResolvables"];
        const defaultFieldProbes = ["updatedAt", "lastChangedAt", "isUnread", "unread", "lastReadAt", "readAt", "snoozedUntil", "attentionAt"];
        const probeRelations = Array.from(new Set((args.probeRelations ?? defaultRelationProbes)
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)));
        const probeFields = Array.from(new Set((args.probeFields ?? defaultFieldProbes)
            .map((value) => String(value ?? "").trim())
            .filter((value) => value.length > 0)));
        const warnings: string[] = [];

        let loggedInUser: CodecksUser;
        try
        {
            loggedInUser = await fetchLoggedInUser();
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "debug-logged-in-user-resolvables", "api_error", toErrorMessage(error));
        }

        const loggedInUserId = String(loggedInUser.id ?? "").trim();
        if (!loggedInUserId)
        {
            return toStructuredErrorResult(format, "debug-logged-in-user-resolvables", "api_error", "Unable to resolve logged-in user id.");
        }

        const openQuery = {
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

        let openPayload: unknown;
        try
        {
            openPayload = await runQuery(openQuery);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "debug-logged-in-user-resolvables", "api_error", toErrorMessage(error));
        }

        const openData = unwrapData(openPayload) as Record<string, unknown> | undefined;
        const account = getAccount(openPayload);
        const cardMap = getEntityMap(openData, "card");
        const userMap = getEntityMap(openData, "user");
        const resolvableMap = getEntityMap(openData, "resolvable");
        const entryMap = getEntityMap(openData, "resolvableEntry");
        const cards = extractRelationEntities(account, "cards", cardMap);

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

        const openItems: Array<Record<string, unknown>> = [];
        let latestByLoggedInUserCount = 0;
        let latestByOtherUserCount = 0;
        let latestMentionsLoggedInUserCount = 0;
        let assignedToLoggedInUserCount = 0;
        let cardCreatedByLoggedInUserCount = 0;
        let resolvableCreatedByLoggedInUserCount = 0;
        let userAppearsInSampleParticipantsCount = 0;

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
                const entryList = extractRelationEntities(resolvable, "entries", entryMap)
                    .slice()
                    .sort((left, right) => toTimestamp(right.createdAt) - toTimestamp(left.createdAt));
                const latestEntry = entryList[0];
                const latestAuthor = resolveUserEntity(latestEntry?.author);
                const latestAuthorId = String(latestAuthor?.id ?? latestEntry?.author ?? "").trim();
                const latestContentRaw = latestEntry?.content ? String(latestEntry.content) : "";
                const latestContent = normalizeContent(latestContentRaw);
                const latestPreview = latestContent ? truncate(latestContent, 160) : "(no sampled entries)";
                const latestCreatedAt = latestEntry?.createdAt ?? resolvable.createdAt ?? null;
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
                const latestByLoggedInUser = latestAuthorId === loggedInUserId;
                const latestByOtherUser = latestAuthorId.length > 0 && latestAuthorId !== loggedInUserId;
                const cardAssigneeIsLoggedInUser = cardAssigneeId === loggedInUserId;
                const cardCreatorIsLoggedInUser = cardCreatorId === loggedInUserId;
                const resolvableCreatorIsLoggedInUser = resolvableCreatorId === loggedInUserId;
                const userAppearsInSampleParticipants = participantIds.includes(loggedInUserId);

                if (latestByLoggedInUser)
                {
                    latestByLoggedInUserCount += 1;
                }
                if (latestByOtherUser)
                {
                    latestByOtherUserCount += 1;
                }
                if (latestMentionsLoggedInUser)
                {
                    latestMentionsLoggedInUserCount += 1;
                }
                if (cardAssigneeIsLoggedInUser)
                {
                    assignedToLoggedInUserCount += 1;
                }
                if (cardCreatorIsLoggedInUser)
                {
                    cardCreatedByLoggedInUserCount += 1;
                }
                if (resolvableCreatorIsLoggedInUser)
                {
                    resolvableCreatedByLoggedInUserCount += 1;
                }
                if (userAppearsInSampleParticipants)
                {
                    userAppearsInSampleParticipantsCount += 1;
                }

                let heuristic = "user_link_not_obvious";
                if (latestByOtherUser && latestMentionsLoggedInUser)
                {
                    heuristic = "latest_other_and_mentions_logged_in_user";
                }
                else if (latestByOtherUser && cardAssigneeIsLoggedInUser)
                {
                    heuristic = "latest_other_and_card_assigned_to_logged_in_user";
                }
                else if (latestByOtherUser)
                {
                    heuristic = "latest_by_other_user";
                }
                else if (latestByLoggedInUser)
                {
                    heuristic = "latest_by_logged_in_user";
                }
                else if (userAppearsInSampleParticipants)
                {
                    heuristic = "logged_in_user_present_in_sample_participants";
                }

                openItems.push({
                    cardId: String(card.cardId ?? ""),
                    accountSeq,
                    shortCode: shortCode || null,
                    url: url || null,
                    title: String(card.title ?? "(untitled)"),
                    status: String(card.status ?? "unknown"),
                    derivedStatus: String(card.derivedStatus ?? "unknown"),
                    resolvableId: String(resolvable.id ?? ""),
                    context: String(resolvable.context ?? "unknown").toLowerCase(),
                    contextLabel: formatResolvableContextLabel(resolvable.context),
                    createdAt: resolvable.createdAt ?? null,
                    latestActivityAt: latestCreatedAt,
                    latestActivityAtFormatted: formatDateTime(latestCreatedAt),
                    latestEntryAuthor: (latestAuthor?.fullName ?? latestAuthor?.name ?? latestAuthorId) || "Unknown",
                    latestEntryAuthorId: latestAuthorId || null,
                    latestEntryByLoggedInUser: latestByLoggedInUser,
                    latestEntryByOtherUser: latestByOtherUser,
                    latestEntryMentionsLoggedInUser: latestMentionsLoggedInUser,
                    latestEntryPreview: latestPreview,
                    sampleEntryCount: entryList.length,
                    resolvableCreator: (resolvableCreator?.fullName ?? resolvableCreator?.name ?? resolvableCreatorId) || "Unknown",
                    resolvableCreatorId: resolvableCreatorId || null,
                    resolvableCreatedByLoggedInUser: resolvableCreatorIsLoggedInUser,
                    cardAssignee: (cardAssignee?.fullName ?? cardAssignee?.name ?? cardAssigneeId) || "Unknown",
                    cardAssigneeId: cardAssigneeId || null,
                    cardAssigneeIsLoggedInUser,
                    cardCreator: (cardCreator?.fullName ?? cardCreator?.name ?? cardCreatorId) || "Unknown",
                    cardCreatorId: cardCreatorId || null,
                    cardCreatorIsLoggedInUser,
                    participantSampleUserIds: participantIds,
                    participantSampleIncludesLoggedInUser: userAppearsInSampleParticipants,
                    heuristic,
                });
            }
        }

        openItems.sort((left, right) => toTimestamp(right.latestActivityAt) - toTimestamp(left.latestActivityAt));
        const sampleItems = openItems.slice(0, detailLimit);

        const relationProbes: Array<Record<string, unknown>> = [];
        for (const relation of probeRelations)
        {
            const relationName = String(relation).trim();
            if (!relationName)
            {
                continue;
            }

            const supported = userDebugRelations[relationName];
            if (!supported)
            {
                const error = `Unsupported loggedInUser probe relation '${relationName}'; only known ordered hasMany relations may be paginated.`;
                warnings.push(error);
                relationProbes.push({ relation: relationName, ok: false, error });
                continue;
            }
            const relationKey = relationQuery(relationName, { $order: supported.order, $limit: relationProbeLimit });
            const probeQuery = {
                _root: [
                    {
                        loggedInUser: [
                            "id",
                            "name",
                            {
                                [relationKey]: supported.fields,
                            },
                        ],
                    },
                ],
            };

            try
            {
                const probePayload = await runQuery(probeQuery);
                const probeData = unwrapData(probePayload) as Record<string, unknown> | undefined;
                const probeRoot = getRoot(probePayload);
                const probeUserMap = getEntityMap(probeData, "user");
                const probeUser = normalizeEntity((resolveFromMap(probeRoot?.loggedInUser, probeUserMap) ?? probeRoot?.loggedInUser) as CodecksEntity | CodecksEntity[] | undefined);
                const relationValues = normalizeCollection(getRelation(probeUser as CodecksEntity | undefined, relationName) as unknown[] | undefined);
                relationProbes.push({
                    relation: relationName,
                    ok: true,
                    itemCount: relationValues.length,
                    sampleIds: relationValues
                        .map((value) =>
                        {
                            if (typeof value === "object" && value)
                            {
                                const entry = value as CodecksEntity;
                                return String(entry.id ?? entry.entryId ?? "").trim();
                            }
                            return String(value ?? "").trim();
                        })
                        .filter((value) => value.length > 0)
                        .slice(0, 5),
                    payload: includePayload ? probeData ?? null : undefined,
                });
            }
            catch (error)
            {
                const message = toErrorMessage(error);
                warnings.push(`loggedInUser.${relationName} probe failed: ${message}`);
                relationProbes.push({
                    relation: relationName,
                    ok: false,
                    error: message,
                });
            }
        }

        const fieldProbes: Array<Record<string, unknown>> = [];
        const sampleResolvableId = sampleItems.length > 0 ? String(sampleItems[0].resolvableId ?? "").trim() : "";
        if (sampleResolvableId)
        {
            const sampleKey = `resolvable(${formatIdForQuery(sampleResolvableId)})`;
            for (const field of probeFields)
            {
                const fieldName = String(field).trim();
                if (!fieldName)
                {
                    continue;
                }

                const probeQuery = {
                    [sampleKey]: [
                        "id",
                        "context",
                        "isClosed",
                        fieldName,
                    ],
                };

                try
                {
                    const probePayload = await runQuery(probeQuery);
                    const probeData = unwrapData(probePayload) as Record<string, unknown> | undefined;
                    const probeResolvableMap = getEntityMap(probeData, "resolvable");
                    const rawResolvable = probeResolvableMap[sampleResolvableId]
                        ?? resolveFromMap(probeData ? probeData[sampleKey] : undefined, probeResolvableMap)
                        ?? (probeData ? (probeData.resolvable as CodecksEntity | undefined) : undefined);
                    const value = rawResolvable ? rawResolvable[fieldName] : undefined;
                    fieldProbes.push({
                        field: fieldName,
                        ok: true,
                        hasValue: value !== undefined,
                        value: value ?? null,
                        payload: includePayload ? probeData ?? null : undefined,
                    });
                }
                catch (error)
                {
                    const message = toErrorMessage(error);
                    warnings.push(`resolvable.${fieldName} probe failed: ${message}`);
                    fieldProbes.push({
                        field: fieldName,
                        ok: false,
                        error: message,
                    });
                }
            }
        }
        else
        {
            warnings.push("No open resolvables were found in the scanned card window, so sample resolvable field probes were skipped.");
        }

        const lines = [
            "## Logged-in User Resolvable Debug",
            "",
            `- User: ${loggedInUser.fullName ?? loggedInUser.name ?? "(unknown)"}`,
            `- User ID: ${loggedInUserId}`,
            `- Scanned Cards: ${cards.length}`,
            `- Open Resolvables Found: ${openItems.length}`,
            `- Sample Size: ${sampleItems.length}`,
            `- Probe Budget Used: ${2 + relationProbes.length + fieldProbes.length}`,
            `- Relation Probes: ${relationProbes.length}`,
            `- Field Probes: ${fieldProbes.length}`,
            "",
            "### Heuristic Summary",
            `- Latest entry by logged-in user: ${latestByLoggedInUserCount}`,
            `- Latest entry by other user: ${latestByOtherUserCount}`,
            `- Latest entry mentions logged-in user: ${latestMentionsLoggedInUserCount}`,
            `- Card assignee is logged-in user: ${assignedToLoggedInUserCount}`,
            `- Card creator is logged-in user: ${cardCreatedByLoggedInUserCount}`,
            `- Resolvable creator is logged-in user: ${resolvableCreatedByLoggedInUserCount}`,
            `- Logged-in user appears in sampled participants: ${userAppearsInSampleParticipantsCount}`,
        ];

        if (sampleItems.length > 0)
        {
            lines.push("", "### Sample Open Resolvables");
            for (const item of sampleItems)
            {
                lines.push(
                    `- ${String(item.shortCode ?? "(n/a)")} â€¢ ${String(item.contextLabel ?? "unknown")} â€¢ ${String(item.title ?? "(untitled)")} â€¢ latest: ${String(item.latestEntryAuthor ?? "Unknown")} â€¢ mention-user: ${item.latestEntryMentionsLoggedInUser ? "yes" : "no"} â€¢ assignee-is-user: ${item.cardAssigneeIsLoggedInUser ? "yes" : "no"} â€¢ creator-is-user: ${item.cardCreatorIsLoggedInUser ? "yes" : "no"} â€¢ heuristic: ${String(item.heuristic ?? "unknown")}`,
                );
                lines.push(`  latest at ${String(item.latestActivityAtFormatted ?? "") || "(unknown time)"} â€¢ ${String(item.latestEntryPreview ?? "(no preview)")}`);
            }
        }

        if (relationProbes.length > 0)
        {
            lines.push("", "### loggedInUser Relation Probes");
            for (const probe of relationProbes)
            {
                if (probe.ok)
                {
                    const sampleIds = Array.isArray(probe.sampleIds) && probe.sampleIds.length > 0
                        ? String((probe.sampleIds as unknown[]).join(", "))
                        : "(none)";
                    lines.push(`- SUCCESS ${String(probe.relation ?? "(unknown)")} â€¢ count=${String(probe.itemCount ?? 0)} â€¢ sample=${sampleIds}`);
                }
                else
                {
                    lines.push(`- FAIL ${String(probe.relation ?? "(unknown)")} â€¢ ${String(probe.error ?? "Unknown error")}`);
                }
            }
        }

        if (fieldProbes.length > 0)
        {
            lines.push("", `### Sample Resolvable Field Probes (${sampleResolvableId})`);
            for (const probe of fieldProbes)
            {
                if (probe.ok)
                {
                    lines.push(`- SUCCESS ${String(probe.field ?? "(unknown)")} â€¢ hasValue=${probe.hasValue ? "yes" : "no"} â€¢ value=${JSON.stringify(probe.value ?? null)}`);
                }
                else
                {
                    lines.push(`- FAIL ${String(probe.field ?? "(unknown)")} â€¢ ${String(probe.error ?? "Unknown error")}`);
                }
            }
        }

        if (warnings.length > 0)
        {
            lines.push("", "### Warnings", ...warnings.map((warning) => `- ${warning}`));
        }

        return toStructuredResult(
            format,
            "debug-logged-in-user-resolvables",
            lines.join("\n"),
            {
                user: {
                    id: loggedInUserId,
                    name: loggedInUser.name ?? null,
                    fullName: loggedInUser.fullName ?? null,
                },
                scanLimit,
                scannedCards: cards.length,
                openResolvableCount: openItems.length,
                sampleSize: sampleItems.length,
                relationProbeLimit,
                relationProbes,
                fieldProbes,
                heuristicSummary: {
                    latestByLoggedInUser: latestByLoggedInUserCount,
                    latestByOtherUser: latestByOtherUserCount,
                    latestMentionsLoggedInUser: latestMentionsLoggedInUserCount,
                    cardAssigneeIsLoggedInUser: assignedToLoggedInUserCount,
                    cardCreatorIsLoggedInUser: cardCreatedByLoggedInUserCount,
                    resolvableCreatorIsLoggedInUser: resolvableCreatedByLoggedInUserCount,
                    participantSampleIncludesLoggedInUser: userAppearsInSampleParticipantsCount,
                },
                sampleResolvables: sampleItems,
                warnings,
            },
            warnings,
        );
    },
});
