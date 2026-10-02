import { fetchSharedActor } from "../../runtime/identity";
import { CodecksOperationError } from "../../runtime/operation-error";
import { runDispatch } from "../../runtime/transport";
import { isIntrinsicDocumentationCard } from "../../shared/card-observation";
import { fetchCardByAccountSeq, fetchCardById, resolveCardForUpdate } from "../../shared/card-queries";
import { formatShortCode, normalizeCardReferencesForUserText, parseCardIdentifier } from "../../shared/card-reference";
import { formatResolvableContextLabel } from "../../shared/presentation";
import { normalizeResolvableContextInput } from "../../shared/resolvable-context";
import { fetchOpenResolvableContexts, fetchOpenResolvablesForCard, fetchResolvableById } from "../../shared/resolvable-queries";
import { type OutputFormat, classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { generateSessionId } from "../../shared/session-id";
import { type CodecksEntity } from "../../shared/types";
import { formatCardUrl } from "../../shared/urls";

export const resolveResolvableTarget = async (args: {
    resolvableId?: string | number;
    cardId?: string | number;
    context?: string;
}): Promise<{
    resolvable: CodecksEntity;
    cardId: string;
    shortCode: string;
    cardTitle: string;
} | { error: string }> =>
{
    if (args.resolvableId !== undefined)
    {
        const resolvableId = String(args.resolvableId).trim();
        if (!resolvableId)
        {
            return { error: "Resolvable ID is required." };
        }

        const resolvable = await fetchResolvableById(resolvableId);
        if (!resolvable)
        {
            return { error: "Resolvable not found." };
        }

        const card = typeof resolvable.card === "object" && resolvable.card
            ? resolvable.card as CodecksEntity
            : undefined;
        const cardIdValue = card?.cardId ? String(card.cardId) : "";
        const shortCode = formatShortCode(card?.accountSeq as number | undefined);
        return {
            resolvable,
            cardId: cardIdValue,
            shortCode,
            cardTitle: card?.title ? String(card.title) : "",
        };
    }

    if (args.cardId === undefined)
    {
        return { error: "Provide resolvableId or cardId." };
    }

    const card = await resolveCardForUpdate(args.cardId);
    if (!card)
    {
        return { error: "Card not found." };
    }

    const openResolvables = await fetchOpenResolvablesForCard(card.cardId);
    let contextFilter = "";
    let contextLabel = "";
    if (args.context)
    {
        const normalizedContext = normalizeResolvableContextInput(args.context);
        if ("error" in normalizedContext)
        {
            return { error: normalizedContext.error };
        }
        contextFilter = normalizedContext.context;
        contextLabel = normalizedContext.label;
    }

    const matches = openResolvables.filter((entry) =>
    {
        const context = String(entry.context ?? "").trim().toLowerCase();
        if (!contextFilter)
        {
            return true;
        }
        return context === contextFilter;
    });

    if (matches.length === 0)
    {
        return { error: contextFilter
            ? `No open ${contextLabel || contextFilter} resolvable found on this card.`
            : "No open resolvables found on this card." };
    }

    if (matches.length > 1)
    {
        const details = matches
            .map((entry) => `- ${String(entry.id ?? "(n/a)")} (${formatResolvableContextLabel(entry.context)})`)
            .join("\n");
        return {
            error: `Multiple open resolvables matched. Provide resolvableId.\n\n${details}`,
        };
    }

    return {
        resolvable: matches[0],
        cardId: card.cardId,
        shortCode: card.shortCode,
        cardTitle: card.title,
    };
};

export type ResolvableActionBucket = "new_activity" | "resurfaced";

export type ResolvableBubbleHeuristic = "unread" | "read" | "stale_review";

export const computeResolvableBubbleHeuristic = (args: {
    bucket: ResolvableActionBucket;
    context: string;
}): ResolvableBubbleHeuristic =>
{
    if (args.bucket === "new_activity")
    {
        return "unread";
    }

    if (args.context === "review")
    {
        return "stale_review";
    }

    return "read";
};

export const looksLikeContentEditIntent = (value: string): boolean =>
{
    const text = value.toLowerCase();
    const hints = [
        "markdown block",
        "code block",
        "```",
        "append",
        "prepend",
        "replace body",
        "update content",
        "edit content",
    ];

    return hints.some((hint) => text.includes(hint));
};

export const addBlockerResolvable = async (args: {
    cardId: string | number;
    content: string;
    format?: OutputFormat;
    action: "card-add-block" | "card-add-blocker";
    includeAliasWarning?: boolean;
}): Promise<string> =>
{
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
        return toStructuredErrorResult(format, args.action, "not_found", "Card not found.");
    }

    cardId = current.cardId as string;
    accountSeq = current.accountSeq as number | undefined;
    shortCode = formatShortCode(accountSeq);

    if (!cardId)
    {
        return toStructuredErrorResult(format, args.action, "validation_error", "Card ID is required.");
    }

    if (isIntrinsicDocumentationCard(current))
    {
        return toStructuredErrorResult(
            format,
            args.action,
            "validation_error",
            "Documentation cards do not support blocker comments.",
        );
    }

    const contexts = await fetchOpenResolvableContexts(cardId);
    if (contexts.has("review"))
    {
        return toStructuredErrorResult(
            format,
            args.action,
            "validation_error",
            "Cannot add blocker: card has an open review.",
        );
    }

    if (contexts.has("block"))
    {
        return toStructuredErrorResult(
            format,
            args.action,
            "validation_error",
            "Cannot add blocker: card already has an open blocker.",
        );
    }

    const normalizedContent = normalizeCardReferencesForUserText(args.content);
    let actor: { id: string | number; verifiedOrg: boolean };
    try { actor = await fetchSharedActor(); }
    catch (error) { return toStructuredErrorResult(format, args.action, error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }

    try
    {
        await runDispatch("resolvables/create", {
            sessionId: generateSessionId(),
            cardId,
            context: "block",
            content: normalizedContent,
            userId: actor.id,
        }, actor.verifiedOrg ? String(actor.id) : undefined);
    }
    catch (error)
    {
        return toStructuredErrorResult(format, args.action, error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
    }

    const url = shortCode ? formatCardUrl(shortCode) : "";
    const title = current.title ? String(current.title) : "";
    const preview = normalizedContent.length > 160
        ? `${normalizedContent.slice(0, 157)}...`
        : normalizedContent;
    const lines = [
        "## Blocker Added",
        "",
        `- Title: ${title || "(untitled)"}`,
        `- ID: ${cardId}`,
        `- Short Code: ${shortCode || "(n/a)"}`,
        `- URL: ${url || ""}`,
        "- Context: blocker (resolvable context key: block)",
        `- Blocker: ${preview}`,
    ];

    const warnings: string[] = [];
    if (args.includeAliasWarning)
    {
        warnings.push("`card_add_block` is deprecated for clarity. Prefer `card_add_blocker` for blocker threads.");
    }

    if (looksLikeContentEditIntent(normalizedContent))
    {
        warnings.push("This tool opens a blocker thread, not card body edits. Use `card_update` to change markdown/code content.");
    }

    const warningList = warnings.length > 0 ? warnings : undefined;

    if (warningList && format !== "json")
    {
        lines.push("", "Warnings", "--------", ...warningList.map((warning) => `- ${warning}`));
    }

    return toStructuredResult(
        format,
        args.action,
        lines.join("\n"),
        {
            cardId,
            shortCode: shortCode || null,
            url: url || null,
            context: "block",
            contextLabel: "blocker",
            preview,
            isAlias: args.includeAliasWarning ?? false,
        },
        warningList,
    );
};

export const resolvableDebugRelations: Record<string, { order: string; fields: string[] }> = {
    participants: { order: "-firstJoinedAt", fields: ["userId", "resolvableId", "firstJoinedAt"] },
    entries: { order: "-createdAt", fields: ["entryId", "createdAt"] },
};

export const userDebugRelations: Record<string, { order: string; fields: string[] }> = {
    participations: { order: "-firstJoinedAt", fields: ["userId", "resolvableId", "firstJoinedAt"] },
};
