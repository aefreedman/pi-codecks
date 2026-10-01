import { getBaseConfig } from "../runtime/credentials";
import { fetchLoggedInUser } from "../runtime/identity";
import { CodecksOperationError } from "../runtime/operation-error";
import { withAccountScanSlot } from "../runtime/pacing";
import { runQuery } from "../runtime/transport";
import { getCardChildCountInfo, hasOwn, isCardTypeKnown, resolveCardType } from "./card-observation";
import { cardDetailFields, cardPlanningFields, extractCardsFromPayload, handCardFields, hydrateCard } from "./card-queries";
import { buildReusableCardRefs, cardCodeToAccountSeq, formatShortCode } from "./card-reference";
import { extractEntitiesFromPayload, getEntityMap, resolveFromMap } from "./entity-maps";
import { renderLookupMessage, resolveDeck, resolveMilestone } from "./entity-resolution";
import { formatTags } from "./presentation";
import { formatIdForQuery, getAccount, getRelation, normalizeCollection, relationQuery, unwrapData } from "./query";
import { toErrorMessage } from "./results";
import { UUID_PATTERN } from "./session-id";
import { type CodecksEntity } from "./types";
import { normalizeUserId } from "./users";

export type CardSearchOutputMode = "compact" | "detailed" | "counts";
export type CardLocationScope = "any" | "deck" | "milestone" | "hand" | "bookmarks";

export type CardSearchIn = "title" | "content" | "title_or_content";

export type CardSearchParams = {
    title?: string;
    text?: string;
    searchIn?: CardSearchIn;
    cardCode?: string;
    location?: CardLocationScope;
    deck?: string | number;
    milestone?: string | number;
    userId?: string | number;
    limit?: number;
    scanLimit?: number;
    pageSize?: number;
    includeArchived?: boolean;
    includeDone?: boolean;
    outputMode?: CardSearchOutputMode;
};

export const inferCardLocationScope = (args: { location?: CardLocationScope; deck?: unknown; milestone?: unknown }): CardLocationScope | { error: string } =>
{
    const requestedLocation = args.location ?? "any";
    const hasDeck = args.deck !== undefined && String(args.deck).trim() !== "";
    const hasMilestone = args.milestone !== undefined && String(args.milestone).trim() !== "";

    if (requestedLocation === "any")
    {
        if (hasDeck && hasMilestone)
        {
            return "any";
        }

        if (hasDeck)
        {
            return "deck";
        }

        if (hasMilestone)
        {
            return "milestone";
        }
    }

    if (["hand", "bookmarks"].includes(requestedLocation) && (hasDeck || hasMilestone))
    {
        return { error: `location=${requestedLocation} cannot be combined with deck or milestone filters. Remove those filters or use location=deck/location=milestone.` };
    }

    return requestedLocation;
};

export type ClientCardScopeFilter = {
    type: "deck" | "milestone";
    id: string | number;
};

export const relationMatchesLookupId = (value: unknown, lookupId: string | number): boolean =>
{
    const target = String(lookupId);
    if (typeof value === "string" || typeof value === "number")
    {
        return String(value) === target;
    }

    if (!value || typeof value !== "object")
    {
        return false;
    }

    const entity = value as CodecksEntity;
    return [entity.id, entity.accountSeq]
        .filter((candidate) => candidate !== undefined && candidate !== null)
        .some((candidate) => String(candidate) === target);
};


export const cardMatchesClientScopes = (card: CodecksEntity, scopes: ClientCardScopeFilter[]): boolean =>
    scopes.every((scope) =>
    {
        const values = [card[scope.type], card[`${scope.type}_id`], card[`${scope.type}Id`]]
            .filter((value) => value !== undefined && value !== null);
        return values.length > 0 && values.every((value) => relationMatchesLookupId(value, scope.id));
    });

export type TextSearchMatcher = {
    raw: string;
    normalized: string;
    hasWildcard: boolean;
    backendContains?: string;
    matches(value: unknown): boolean;
};

export const normalizeTextForSearch = (value: unknown): string => String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9*?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const escapeRegex = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");

export const wildcardToRegex = (normalizedPattern: string): RegExp =>
{
    const source = Array.from(normalizedPattern)
        .map((char) =>
        {
            if (char === "*")
            {
                return ".*";
            }

            if (char === "?")
            {
                return ".";
            }

            return escapeRegex(char);
        })
        .join("");

    return new RegExp(`^${source}$`);
};

export const selectBackendContainsToken = (normalizedPattern: string): string | undefined =>
{
    const tokens = normalizedPattern
        .split(/[*?\s]+/)
        .map((token) => token.trim())
        .filter((token) => /^[a-z0-9]{2,}$/.test(token))
        .sort((left, right) => right.length - left.length);

    return tokens[0];
};

export const createTextSearchMatcher = (pattern: string | undefined): TextSearchMatcher | undefined =>
{
    const raw = String(pattern ?? "").trim();
    if (!raw)
    {
        return undefined;
    }

    const normalized = normalizeTextForSearch(raw);
    if (!normalized)
    {
        return undefined;
    }

    const hasWildcard = /[*?]/.test(raw);
    const regex = hasWildcard ? wildcardToRegex(normalized) : undefined;
    const canSafelyUseBackendContains = /^[a-z0-9*?]+$/i.test(raw);
    const backendContains = canSafelyUseBackendContains ? selectBackendContainsToken(normalized) : undefined;

    return {
        raw,
        normalized,
        hasWildcard,
        backendContains,
        matches(value: unknown): boolean
        {
            const normalizedValue = normalizeTextForSearch(value).replace(/[*?]/g, "");
            return regex ? regex.test(normalizedValue) : normalizedValue.includes(normalized);
        },
    };
};

export const cardMatchesText = (card: CodecksEntity, matcher: TextSearchMatcher | undefined, searchIn: CardSearchIn): boolean =>
{
    if (!matcher)
    {
        return true;
    }

    if (searchIn === "title")
    {
        return matcher.matches(card.title);
    }

    if (searchIn === "content")
    {
        return matcher.matches(card.content);
    }

    return matcher.matches(card.title) || matcher.matches(card.content);
};

export const cardMatchesDoneFilter = (card: CodecksEntity, includeDone: boolean | undefined): boolean =>
{
    if (includeDone !== false)
    {
        return true;
    }

    const status = String(card.status ?? "").trim().toLowerCase();
    const derivedStatus = String(card.derivedStatus ?? "").trim().toLowerCase();
    return status !== "done" && derivedStatus !== "done";
};

export type CardSearchRenderContext = {
    titleMatcher?: TextSearchMatcher;
    textMatcher?: TextSearchMatcher;
    searchIn: CardSearchIn;
};

export const getCardMatchedFields = (card: CodecksEntity, context?: CardSearchRenderContext): string[] | undefined =>
{
    if (!context)
    {
        return undefined;
    }

    const fields = new Set<string>();
    if (context.titleMatcher?.matches(card.title))
    {
        fields.add("title");
    }

    if (context.textMatcher)
    {
        if ((context.searchIn === "title" || context.searchIn === "title_or_content") && context.textMatcher.matches(card.title))
        {
            fields.add("title");
        }

        if ((context.searchIn === "content" || context.searchIn === "title_or_content") && context.textMatcher.matches(card.content))
        {
            fields.add("content");
        }
    }

    return fields.size > 0 ? Array.from(fields) : undefined;
};

export const normalizeCardSearchSummary = (card: CodecksEntity, context?: CardSearchRenderContext, detailed = false): Record<string, unknown> =>
{
    const deck = card.deck as CodecksEntity | undefined;
    const milestone = card.milestone as CodecksEntity | undefined;
    const parentCard = card.parentCard as CodecksEntity | undefined;

    const childCount = getCardChildCountInfo(card);
    const hasEffort = hasOwn(card, "effort");
    const matchedFields = getCardMatchedFields(card, context);

    return {
        cardId: card.cardId,
        accountSeq: card.accountSeq,
        shortCode: formatShortCode(card.accountSeq as number | undefined),
        ...buildReusableCardRefs(card.accountSeq as number | undefined),
        title: card.title,
        status: card.status,
        derivedStatus: card.derivedStatus,
        visibility: card.visibility,
        cardType: isCardTypeKnown(card) ? resolveCardType(card) : "unknown",
        cardTypeKnown: isCardTypeKnown(card),
        isDoc: Boolean(card.isDoc),
        effortKnown: hasEffort,
        effort: hasEffort ? (card.effort ?? null) : undefined,
        priority: card.priority ?? null,
        lastUpdatedAt: card.lastUpdatedAt ?? null,
        dueDate: card.dueDate ?? null,
        childCountKnown: childCount.known,
        childCount: childCount.count,
        deck: deck?.title,
        deckId: deck?.id ?? null,
        deckAccountSeq: deck?.accountSeq ?? null,
        milestone: milestone?.title ?? milestone?.name,
        milestoneId: milestone?.id ?? null,
        milestoneAccountSeq: milestone?.accountSeq ?? null,
        assignee: (card.assignee as CodecksEntity | undefined)?.name
            ?? (card.assignee as CodecksEntity | undefined)?.fullName,
        tags: formatTags(card.masterTags),
        ...(detailed ? {
            content: card.content ?? "",
            parentReference: formatShortCode(parentCard?.accountSeq as number | undefined) || null,
            archived: card.visibility === "archived" || card.visibility === "deleted",
        } : {}),
        ...(matchedFields ? { matchedFields } : {}),
    };
};

export const incrementFacet = (counter: Record<string, number>, value: unknown, fallback = "(none)"): void =>
{
    const key = String(value ?? fallback).trim() || fallback;
    counter[key] = (counter[key] ?? 0) + 1;
};

export const buildCardSearchFacets = (cards: CodecksEntity[]): Record<string, Record<string, number>> =>
{
    const facets: Record<string, Record<string, number>> = {
        status: {},
        derivedStatus: {},
        deck: {},
        milestone: {},
        assignee: {},
        effort: {},
        priority: {},
        cardType: {},
    };

    for (const card of cards)
    {
        const deck = card.deck as CodecksEntity | undefined;
        const milestone = card.milestone as CodecksEntity | undefined;
        const assignee = card.assignee as CodecksEntity | undefined;
        incrementFacet(facets.status, card.status);
        incrementFacet(facets.derivedStatus, card.derivedStatus);
        incrementFacet(facets.deck, deck?.title);
        incrementFacet(facets.milestone, milestone?.title ?? milestone?.name);
        incrementFacet(facets.assignee, assignee?.name ?? assignee?.fullName);
        incrementFacet(facets.effort, hasOwn(card, "effort") ? (card.effort ?? "(unset)") : "(unknown)");
        incrementFacet(facets.priority, card.priority);
        incrementFacet(facets.cardType, isCardTypeKnown(card) ? resolveCardType(card) : "unknown");
    }

    return facets;
};

export type CardSearchResult = {
    error?: string;
    cards?: CodecksEntity[];
    rawCount?: number;
    renderContext?: CardSearchRenderContext;
    matchedCards?: CodecksEntity[];
    scannedCards?: number;
    scanLimit?: number;
    pageSize?: number;
    complete?: boolean;
    scanLimitReached?: boolean;
    requestsAttempted?: number;
    queueWaitMs?: number;
    elapsedMs?: number;
};

export type PagedCardScanResult = { cards: CodecksEntity[]; scannedCards: number; complete: boolean; scanLimitReached: boolean; requestsAttempted: number; queueWaitMs: number; elapsedMs: number };

// A failed page still represents an attempted logical scan and may have returned
// earlier pages. Keep that evidence so semantic title-filter fallback is auditable.
export class PagedCardScanFailure extends Error
{
    constructor(readonly cause: unknown, readonly scan: PagedCardScanResult)
    {
        super(toErrorMessage(cause));
        this.name = "PagedCardScanFailure";
    }
}

export const fetchPagedCardsWithoutSlot = async (args: {
    filters: Record<string, unknown>;
    fields: Array<string | Record<string, unknown>>;
    scanLimit: number;
    pageSize: number;
}): Promise<Omit<PagedCardScanResult, "queueWaitMs" | "elapsedMs">> =>
{
    const cards: CodecksEntity[] = [];
    const seenCardIds = new Set<string>();
    let scannedCards = 0;
    let offset = 0;
    let complete = false;
    let requestsAttempted = 0;

    while (scannedCards < args.scanLimit)
    {
        const requestedPageSize = Math.min(args.pageSize, args.scanLimit - scannedCards);
        const pageFilters = {
            ...args.filters,
            $order: "-lastUpdatedAt",
            $limit: requestedPageSize,
            $offset: offset,
        };
        requestsAttempted += 1;
        let payload: unknown;
        try
        {
            payload = await runQuery({
                _root: [
                    {
                        account: [
                            {
                                [relationQuery("cards", pageFilters)]: args.fields,
                            },
                        ],
                    },
                ],
            });
        }
        catch (error)
        {
            throw new PagedCardScanFailure(error, {
                cards,
                scannedCards,
                complete: false,
                scanLimitReached: false,
                requestsAttempted,
                queueWaitMs: 0,
                elapsedMs: 0,
            });
        }
        const account = getAccount(payload);
        const serverRows = normalizeCollection(getRelation(account, "cards") as unknown[] | undefined);
        const rowCount = serverRows.length;
        scannedCards += rowCount;
        offset += rowCount;

        for (const card of extractCardsFromPayload(payload, "cards"))
        {
            const cardId = String(card.cardId ?? "").trim();
            if (cardId && seenCardIds.has(cardId))
            {
                continue;
            }
            if (cardId)
            {
                seenCardIds.add(cardId);
            }
            cards.push(card);
        }

        if (rowCount < requestedPageSize)
        {
            complete = true;
            break;
        }
    }

    return {
        cards,
        scannedCards,
        complete,
        scanLimitReached: !complete && scannedCards >= args.scanLimit,
        requestsAttempted,
    };
};

export const fetchPagedCards = async (args: {
    filters: Record<string, unknown>;
    fields: Array<string | Record<string, unknown>>;
    scanLimit: number;
    pageSize: number;
}): Promise<PagedCardScanResult> =>
{
    const startedAt = Date.now();
    return withAccountScanSlot(async (queueWaitMs) =>
    {
        try
        {
            const result = await fetchPagedCardsWithoutSlot(args);
            return { ...result, queueWaitMs, elapsedMs: Date.now() - startedAt };
        }
        catch (error)
        {
            if (error instanceof PagedCardScanFailure)
            {
                throw new PagedCardScanFailure(error.cause, {
                    ...error.scan,
                    queueWaitMs,
                    elapsedMs: Date.now() - startedAt,
                });
            }
            if (error instanceof CodecksOperationError)
            {
                throw new CodecksOperationError(error.category, error.message, {
                    ...error.details,
                    queueWaitMs,
                    elapsedMs: Date.now() - startedAt,
                });
            }
            throw error;
        }
    });
};

export const resolveExplicitHumanHandTarget = async (value: string | number): Promise<string | number> =>
{
    const raw = String(value).trim();
    if (!/^\d+$/.test(raw) && !UUID_PATTERN.test(raw))
        throw new CodecksOperationError("api_error", "Provide an exact human userId from codecks_user_lookup for the named hand.");
    const key = `user(${formatIdForQuery(raw)})`;
    const payload = await runQuery({ [key]: ["id", "name", "fullName", "kind", "isIntegration"] });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const userMap = getEntityMap(data, "user");
    const user = userMap[raw] ?? resolveFromMap(data?.[key], userMap);
    if (!user?.id || normalizeUserId(String(user.id)) !== normalizeUserId(raw)
        || !String(user.name ?? user.fullName ?? "").trim() || user.kind === "api_token" || user.isIntegration === true)
        throw new CodecksOperationError("api_error", "The named hand target was not verified as a human user; no hand query was sent.");
    return user.id as string | number;
};

export const fetchCardMatches = async (args: CardSearchParams): Promise<CardSearchResult> =>
{
    const includeArchived = args.includeArchived ?? (args.cardCode !== undefined);
    const titleMatcher = createTextSearchMatcher(args.title);
    const textMatcher = createTextSearchMatcher(args.text);
    const searchIn: CardSearchIn = args.searchIn ?? (textMatcher ? "title_or_content" : "title");
    const needsContent = Boolean(textMatcher && (searchIn === "content" || searchIn === "title_or_content"));
    const renderContext = (titleMatcher || textMatcher) ? { titleMatcher, textMatcher, searchIn } : undefined;
    const filterArchived = (cards: CodecksEntity[]): CodecksEntity[] => cards.filter((card) =>
    {
        if (includeArchived)
        {
            return true;
        }

        const visibility = String(card.visibility ?? "default").trim().toLowerCase();
        return visibility !== "archived" && visibility !== "deleted";
    });
    const filterCards = (cards: CodecksEntity[]): CodecksEntity[] => filterArchived(cards)
        .filter((card) => cardMatchesDoneFilter(card, args.includeDone))
        .filter((card) => cardMatchesText(card, titleMatcher, "title"))
        .filter((card) => cardMatchesText(card, textMatcher, searchIn));
    const filters: Record<string, unknown> = {};
    const clientScopeFilters: ClientCardScopeFilter[] = [];
    const inferredLocation = inferCardLocationScope(args);
    if (typeof inferredLocation !== "string")
    {
        return { error: inferredLocation.error };
    }
    const location = inferredLocation;
    const profile = getBaseConfig().profileKey;
    if (location === "bookmarks" && profile === "ORG") return { error: "ORG has no own bookmarks; select PERSONAL to view personal bookmarks." };
    if (location === "hand" && profile === "ORG" && args.userId === undefined)
        return { error: "ORG has no own hand; provide an explicit human userId to read a named hand." };
    if (args.userId !== undefined && location !== "hand") return { error: "userId is only supported for location=hand." };
    if (args.userId !== undefined && profile !== "ORG") return { error: "Explicit userId hand targeting is available only with ORG; PERSONAL reads its own hand." };

    if (args.cardCode && (location === "hand" || location === "bookmarks"))
        return { error: "cardCode cannot be combined with hand or bookmarks scope; use a scoped title search or fetch the known card directly." };

    if (args.cardCode)
    {
        const seq = cardCodeToAccountSeq(args.cardCode);
        if (seq === null)
        {
            return { error: "Invalid card code format." };
        }

        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("cards", { accountSeq: [seq] })]: needsContent ? cardDetailFields : cardPlanningFields,
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const cards = filterCards(extractCardsFromPayload(payload, "cards"));
        return {
            cards,
            matchedCards: cards,
            rawCount: cards.length,
            renderContext,
            scannedCards: cards.length,
            complete: true,
            scanLimitReached: false,
        };
    }

    if (titleMatcher?.backendContains)
    {
        filters.title = { op: "contains", value: titleMatcher.backendContains };
    }

    if (location === "deck" && args.deck === undefined)
    {
        return { error: "Provide a deck name or ID for location=deck." };
    }

    if (location === "milestone" && args.milestone === undefined)
    {
        return { error: "Provide a milestone name or ID for location=milestone." };
    }

    if (args.deck !== undefined)
    {
        const deckResult = await resolveDeck(args.deck);
        if (deckResult.kind !== "resolved")
        {
            return { error: renderLookupMessage(deckResult, String(args.deck ?? "")) };
        }
        filters.deckId = deckResult.id;
        clientScopeFilters.push({ type: "deck", id: deckResult.id });
    }

    if (args.milestone !== undefined)
    {
        const milestoneResult = await resolveMilestone(args.milestone);
        if (milestoneResult.kind !== "resolved")
        {
            return { error: renderLookupMessage(milestoneResult, String(args.milestone ?? "")) };
        }
        clientScopeFilters.push({ type: "milestone", id: milestoneResult.id });
    }

    if (location === "hand")
    {
        const userId = profile === "ORG" ? await resolveExplicitHumanHandTarget(args.userId!) : (await fetchLoggedInUser()).id!;
        const limit = args.limit ?? 7;
        const queueFilters = {
            userId,
            cardDoneAt: null,
            $order: "sortIndex",
            $limit: limit,
        };
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("queueEntries", queueFilters)]: [
                                "sortIndex",
                                {
                                    card: needsContent ? cardDetailFields : cardPlanningFields,
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const queueEntries = extractEntitiesFromPayload(payload, "queueEntries", "queueEntry");
        const cardMap = getEntityMap(data, "card");
        const userMap = getEntityMap(data, "user");
        const deckMap = getEntityMap(data, "deck");
        const milestoneMap = getEntityMap(data, "milestone");

        const cards = queueEntries
            .sort((left, right) => Number(left.sortIndex ?? Number.MAX_SAFE_INTEGER) - Number(right.sortIndex ?? Number.MAX_SAFE_INTEGER))
            .map((queueEntry) =>
            {
                const resolvedCard = resolveFromMap(queueEntry.card, cardMap)
                    ?? (typeof queueEntry.card === "object" && queueEntry.card ? queueEntry.card as CodecksEntity : undefined);
                return resolvedCard;
            })
            .filter((entry): entry is CodecksEntity => Boolean(entry))
            .map((entry) => hydrateCard(entry, { user: userMap, deck: deckMap, milestone: milestoneMap }));

        const filteredCards = filterCards(cards);
        const complete = queueEntries.length < limit;
        return {
            cards: filteredCards.slice(0, limit),
            matchedCards: filteredCards,
            rawCount: filteredCards.length,
            renderContext,
            scannedCards: queueEntries.length,
            scanLimit: limit,
            pageSize: limit,
            complete,
            scanLimitReached: !complete,
        };
    }

    if (location === "bookmarks")
    {
        const user = await fetchLoggedInUser();
        const limit = args.limit ?? 20;
        const handFilters = {
            userId: user.id,
            isVisible: true,
            $order: "sortIndex",
            $limit: limit,
        };
        const handCardFieldsForSearch = needsContent
            ? handCardFields.map((field) => (typeof field === "object" && field && "card" in field ? { card: cardDetailFields } : field))
            : handCardFields;
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("handCards", handFilters)]: handCardFieldsForSearch,
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const handCards = extractEntitiesFromPayload(payload, "handCards", "handCard");
        const cardMap = getEntityMap(data, "card");
        const userMap = getEntityMap(data, "user");
        const deckMap = getEntityMap(data, "deck");
        const milestoneMap = getEntityMap(data, "milestone");
        const userId = String(user.id);

        const cards = handCards
            .filter((handCard) =>
            {
                const resolvedUser = resolveFromMap(handCard.user, userMap)
                    ?? (typeof handCard.user === "object" && handCard.user ? handCard.user as CodecksEntity : undefined);
                const handUserId = String(handCard.userId ?? resolvedUser?.id ?? handCard.user ?? "").trim();
                return handUserId === userId;
            })
            .map((handCard) =>
            {
                const resolvedCard = resolveFromMap(handCard.card, cardMap)
                    ?? (typeof handCard.card === "object" && handCard.card ? handCard.card as CodecksEntity : undefined);
                const byCardId = cardMap[String(handCard.cardId ?? "")];
                return resolvedCard ?? byCardId;
            })
            .filter((entry): entry is CodecksEntity => Boolean(entry))
            .map((entry) => hydrateCard(entry, { user: userMap, deck: deckMap, milestone: milestoneMap }));

        const filteredCards = filterCards(cards);
        const complete = handCards.length < limit;
        return {
            cards: filteredCards.slice(0, limit),
            matchedCards: filteredCards,
            rawCount: filteredCards.length,
            renderContext,
            scannedCards: handCards.length,
            scanLimit: limit,
            pageSize: limit,
            complete,
            scanLimitReached: !complete,
        };
    }

    const limit = args.limit ?? 20;
    const scanLimit = args.scanLimit ?? 3000;
    const pageSize = Math.min(args.pageSize ?? 500, scanLimit);
    const fetched = await fetchPagedCards({
        filters,
        fields: needsContent ? cardDetailFields : cardPlanningFields,
        scanLimit,
        pageSize,
    });
    const scopedCards = fetched.cards.filter((card) => cardMatchesClientScopes(card, clientScopeFilters));
    const cards = filterCards(scopedCards);
    return {
        cards: cards.slice(0, limit),
        rawCount: cards.length,
        renderContext,
        matchedCards: cards,
        scannedCards: fetched.scannedCards,
        scanLimit,
        pageSize,
        complete: fetched.complete,
        scanLimitReached: fetched.scanLimitReached,
        requestsAttempted: fetched.requestsAttempted,
        queueWaitMs: fetched.queueWaitMs,
        elapsedMs: fetched.elapsedMs,
    };
};
