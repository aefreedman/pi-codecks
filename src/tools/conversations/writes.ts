import { getBaseConfig } from "../../runtime/credentials";
import { fetchSharedActor } from "../../runtime/identity";
import { CodecksOperationError } from "../../runtime/operation-error";
import { runDispatch } from "../../runtime/transport";
import { isIntrinsicDocumentationCard } from "../../shared/card-observation";
import { fetchCardByAccountSeq, fetchCardById } from "../../shared/card-queries";
import { formatShortCode, normalizeCardReferencesForUserText, parseCardIdentifier } from "../../shared/card-reference";
import { formatDateTime, formatResolvableContextLabel } from "../../shared/presentation";
import { fetchOpenResolvableContexts, fetchResolvableById, fetchResolvableEntryById } from "../../shared/resolvable-queries";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { generateSessionId } from "../../shared/session-id";
import { outputFormatArg, tool } from "../../pi-tool-compat";
import { type CodecksEntity } from "../../shared/types";
import { formatCardUrl } from "../../shared/urls";
import { normalizeUserId } from "../../shared/users";
import { resolveResolvableTarget, addBlockerResolvable } from "./helpers";

export const card_add_comment = tool({
    description: "Open a general comment thread on a Codecks card when explicitly requested.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        content: tool.schema.string().min(1).describe("Comment content."),
        format: outputFormatArg,
    },
    async execute(args)
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
            return toStructuredErrorResult(format, "card-add-comment", "not_found", "Card not found.");
        }

        cardId = current.cardId as string;
        accountSeq = current.accountSeq as number | undefined;
        shortCode = formatShortCode(accountSeq);

        if (!cardId)
        {
            return toStructuredErrorResult(format, "card-add-comment", "validation_error", "Card ID is required.");
        }

        const normalizedContent = normalizeCardReferencesForUserText(args.content);
        let actor: { id: string | number; verifiedOrg: boolean };
        try { actor = await fetchSharedActor(); }
        catch (error) { return toStructuredErrorResult(format, "card-add-comment", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }

        try
        {
            await runDispatch("resolvables/create", {
                sessionId: generateSessionId(),
                cardId,
                context: "comment",
                content: normalizedContent,
                userId: actor.id,
            }, actor.verifiedOrg ? String(actor.id) : undefined);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-add-comment", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const url = shortCode ? formatCardUrl(shortCode) : "";
        const title = current.title ? String(current.title) : "";
        const preview = normalizedContent.length > 160
            ? `${normalizedContent.slice(0, 157)}...`
            : normalizedContent;
        const lines = [
            "## Comment Added",
            "",
            `- Title: ${title || "(untitled)"}`,
            `- ID: ${cardId}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            "- Context: comment",
            `- Comment: ${preview}`,
        ];

        return toStructuredResult(
            format,
            "card-add-comment",
            lines.join("\n"),
            {
                cardId,
                shortCode: shortCode || null,
                url: url || null,
                context: "comment",
                preview,
            },
        );
    },
});

export const card_add_review = tool({
    description: "Open a review conversation thread on a Codecks card.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        content: tool.schema.string().min(1).describe("Initial review content."),
        format: outputFormatArg,
    },
    async execute(args)
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
            return toStructuredErrorResult(format, "card-add-review", "not_found", "Card not found.");
        }

        cardId = current.cardId as string;
        accountSeq = current.accountSeq as number | undefined;
        shortCode = formatShortCode(accountSeq);

        if (!cardId)
        {
            return toStructuredErrorResult(format, "card-add-review", "validation_error", "Card ID is required.");
        }

        if (isIntrinsicDocumentationCard(current))
        {
            return toStructuredErrorResult(
                format,
                "card-add-review",
                "validation_error",
                "Documentation cards do not support review comments.",
            );
        }

        const contexts = await fetchOpenResolvableContexts(cardId);
        if (contexts.has("block"))
        {
            return toStructuredErrorResult(
                format,
                "card-add-review",
                "validation_error",
                "Cannot add review: card has an open blocker.",
            );
        }

        if (contexts.has("review"))
        {
            return toStructuredErrorResult(
                format,
                "card-add-review",
                "validation_error",
                "Cannot add review: card already has an open review. Reply to the existing review with codecks_card_reply_resolvable (cardId + context: \"review\", or resolvableId) instead.",
            );
        }

        const normalizedContent = normalizeCardReferencesForUserText(args.content);
        let actor: { id: string | number; verifiedOrg: boolean };
        try { actor = await fetchSharedActor(); }
        catch (error) { return toStructuredErrorResult(format, "card-add-review", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }

        try
        {
            await runDispatch("resolvables/create", {
                sessionId: generateSessionId(),
                cardId,
                context: "review",
                content: normalizedContent,
                userId: actor.id,
            }, actor.verifiedOrg ? String(actor.id) : undefined);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-add-review", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const url = shortCode ? formatCardUrl(shortCode) : "";
        const title = current.title ? String(current.title) : "";
        const preview = normalizedContent.length > 160
            ? `${normalizedContent.slice(0, 157)}...`
            : normalizedContent;
        const lines = [
            "## Review Added",
            "",
            `- Title: ${title || "(untitled)"}`,
            `- ID: ${cardId}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            "- Context: review",
            `- Review: ${preview}`,
        ];

        return toStructuredResult(
            format,
            "card-add-review",
            lines.join("\n"),
            {
                cardId,
                shortCode: shortCode || null,
                url: url || null,
                context: "review",
                preview,
            },
        );
    },
});

export const card_add_blocker = tool({
    description: "Open a blocker conversation thread on a Codecks card (not a content/markdown edit).",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        content: tool.schema.string().min(1).describe("Blocker reason content."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        return addBlockerResolvable({
            cardId: args.cardId,
            content: args.content,
            format: args.format,
            action: "card-add-blocker",
            includeAliasWarning: false,
        });
    },
});

export const card_add_block = tool({
    description: "Deprecated alias for adding a blocker thread. Prefer codecks_card_add_blocker.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        content: tool.schema.string().min(1).describe("Blocker reason content."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        return addBlockerResolvable({
            cardId: args.cardId,
            content: args.content,
            format: args.format,
            action: "card-add-block",
            includeAliasWarning: true,
        });
    },
});

export const card_reply_resolvable = tool({
    description: "Reply to an existing Codecks conversation thread (resolvable).",
    args: {
        resolvableId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Resolvable ID."),
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Card ID or short code if resolvableId is not provided."),
        context: tool.schema.enum(["comment", "review", "block", "blocker"]).optional().describe("Optional context filter when selecting an open card resolvable."),
        content: tool.schema.string().min(1).describe("Reply content."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const target = await resolveResolvableTarget({
            resolvableId: args.resolvableId,
            cardId: args.cardId,
            context: args.context,
        });
        if ("error" in target)
        {
            return toStructuredErrorResult(format, "card-reply-resolvable", "validation_error", target.error);
        }

        const resolvableId = String(target.resolvable.id ?? "").trim();
        if (!resolvableId)
        {
            return toStructuredErrorResult(format, "card-reply-resolvable", "validation_error", "Resolvable ID is required.");
        }

        if (target.resolvable.isClosed)
        {
            return toStructuredErrorResult(
                format,
                "card-reply-resolvable",
                "validation_error",
                "Cannot reply to a closed resolvable. Reopen it first.",
                { resolvableId },
            );
        }

        const normalizedContent = normalizeCardReferencesForUserText(args.content);
        let actor: { id: string | number; verifiedOrg: boolean };
        try { actor = await fetchSharedActor(); }
        catch (error) { return toStructuredErrorResult(format, "card-reply-resolvable", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }
        try
        {
            await runDispatch("resolvables/comment", {
                resolvableId,
                authorId: actor.id,
                content: normalizedContent,
            }, actor.verifiedOrg ? String(actor.id) : undefined);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-reply-resolvable", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), {
                resolvableId, ...getOperationErrorData(error),
            });
        }

        const shortCode = target.shortCode || "";
        const url = shortCode ? formatCardUrl(shortCode) : "";
        const context = String(target.resolvable.context ?? "comment").toLowerCase();
        const contextLabel = formatResolvableContextLabel(context);
        const preview = normalizedContent.length > 160
            ? `${normalizedContent.slice(0, 157)}...`
            : normalizedContent;
        const lines = [
            "## Resolvable Reply Added",
            "",
            `- Card: ${target.cardTitle || "(untitled)"}`,
            `- Card ID: ${target.cardId || "(n/a)"}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Resolvable ID: ${resolvableId}`,
            `- Context: ${contextLabel} (key: ${context})`,
            `- Reply: ${preview}`,
        ];

        return toStructuredResult(
            format,
            "card-reply-resolvable",
            lines.join("\n"),
            {
                cardId: target.cardId || null,
                shortCode: shortCode || null,
                url: url || null,
                resolvableId,
                context,
                contextLabel,
                preview,
            },
        );
    },
});

export const card_edit_resolvable_entry = tool({
    description: "Edit an existing Codecks conversation entry authored by the current user.",
    args: {
        entryId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Resolvable entry ID."),
        content: tool.schema.string().min(1).describe("Updated entry content."),
        expectedVersion: tool.schema.number().optional().describe("Optional optimistic concurrency version check."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const entryId = String(args.entryId).trim();
        if (!entryId)
        {
            return toStructuredErrorResult(
                format,
                "card-edit-resolvable-entry",
                "validation_error",
                "Entry ID is required.",
            );
        }

        let before: CodecksEntity | undefined;
        try
        {
            before = await fetchResolvableEntryById(entryId);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-edit-resolvable-entry", "api_error", toErrorMessage(error), {
                entryId,
            });
        }

        if (!before)
        {
            return toStructuredErrorResult(format, "card-edit-resolvable-entry", "not_found", "Resolvable entry not found.", {
                entryId,
            });
        }

        let actor: { id: string | number; verifiedOrg: boolean };
        try { actor = await fetchSharedActor(); }
        catch (error) { return toStructuredErrorResult(format, "card-edit-resolvable-entry", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }
        const currentUserId = String(actor.id ?? "").trim();
        const authorValue = before.author;
        const authorId = typeof authorValue === "object" && authorValue
            ? String((authorValue as CodecksEntity).id ?? "").trim()
            : String(authorValue ?? "").trim();

        if (!authorId)
        {
            return toStructuredErrorResult(
                format,
                "card-edit-resolvable-entry",
                "validation_error",
                "Unable to verify entry author; refusing to edit.",
                { entryId },
            );
        }

        if (!currentUserId || normalizeUserId(authorId) !== normalizeUserId(currentUserId))
        {
            const authorName = typeof authorValue === "object" && authorValue
                ? String((authorValue as CodecksEntity).fullName ?? (authorValue as CodecksEntity).name ?? authorId)
                : authorId;
            return toStructuredErrorResult(
                format,
                "card-edit-resolvable-entry",
                "forbidden",
                "Author-only policy: you can only edit entries you authored.",
                {
                    entryId,
                    entryAuthor: authorName,
                },
            );
        }

        const versionBefore = Number(before.version ?? 0);
        if (args.expectedVersion !== undefined && Number.isFinite(versionBefore) && versionBefore > 0)
        {
            if (args.expectedVersion !== versionBefore)
            {
                return toStructuredErrorResult(
                    format,
                    "card-edit-resolvable-entry",
                    "conflict",
                    `Version mismatch. Current version is ${versionBefore}, expected ${args.expectedVersion}.`,
                    {
                        entryId,
                        currentVersion: versionBefore,
                        expectedVersion: args.expectedVersion,
                    },
                );
            }
        }

        const normalizedContent = normalizeCardReferencesForUserText(args.content);
        const contentBefore = String(before.content ?? "");
        if (contentBefore === normalizedContent)
        {
            const resolvable = typeof before.resolvable === "object" && before.resolvable
                ? before.resolvable as CodecksEntity
                : undefined;
            const card = resolvable && typeof resolvable.card === "object"
                ? resolvable.card as CodecksEntity
                : undefined;
            const shortCode = formatShortCode(card?.accountSeq as number | undefined);
            const url = shortCode ? formatCardUrl(shortCode) : "";

            const lines = [
                "## Resolvable Entry Unchanged",
                "",
                `- Entry ID: ${entryId}`,
                `- Card: ${card?.title ? String(card.title) : "(untitled)"}`,
                `- Short Code: ${shortCode || "(n/a)"}`,
                `- URL: ${url || ""}`,
                `- Version: ${Number.isFinite(versionBefore) ? versionBefore : "(unknown)"}`,
            ];

            return toStructuredResult(
                format,
                "card-edit-resolvable-entry",
                lines.join("\n"),
                {
                    entryId,
                    changed: false,
                    versionBefore: Number.isFinite(versionBefore) ? versionBefore : null,
                    versionAfter: Number.isFinite(versionBefore) ? versionBefore : null,
                    cardId: card?.cardId ? String(card.cardId) : null,
                    shortCode: shortCode || null,
                    url: url || null,
                },
                ["Entry content is unchanged."],
            );
        }

        try
        {
            await runDispatch("resolvables/updateComment", {
                entryId,
                content: normalizedContent,
                authorId: actor.id,
            }, actor.verifiedOrg ? String(actor.id) : undefined);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-edit-resolvable-entry", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), {
                entryId, ...getOperationErrorData(error),
            });
        }

        const resolvable = typeof before.resolvable === "object" && before.resolvable
            ? before.resolvable as CodecksEntity
            : undefined;
        const card = resolvable && typeof resolvable.card === "object"
            ? resolvable.card as CodecksEntity
            : undefined;
        const shortCode = formatShortCode(card?.accountSeq as number | undefined);
        const url = shortCode ? formatCardUrl(shortCode) : "";
        const versionAfter = Number.isFinite(versionBefore) && versionBefore > 0 ? versionBefore + 1 : undefined;
        const updatedAt = new Date().toISOString();
        const preview = normalizedContent.length > 160 ? `${normalizedContent.slice(0, 157)}...` : normalizedContent;

        const lines = [
            "## Resolvable Entry Updated",
            "",
            `- Entry ID: ${entryId}`,
            `- Resolvable ID: ${resolvable?.id ? String(resolvable.id) : "(n/a)"}`,
            `- Context: ${String(resolvable?.context ?? "unknown")}`,
            `- Card: ${card?.title ? String(card.title) : "(untitled)"}`,
            `- Card ID: ${card?.cardId ? String(card.cardId) : "(n/a)"}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Version: ${Number.isFinite(versionBefore) ? versionBefore : "(unknown)"} -> ${versionAfter ?? "(unknown)"}`,
            `- Updated: ${updatedAt ? formatDateTime(updatedAt) : "(unknown)"}`,
            `- Content: ${preview}`,
        ];

        return toStructuredResult(
            format,
            "card-edit-resolvable-entry",
            lines.join("\n"),
            {
                entryId,
                changed: true,
                resolvableId: resolvable?.id ? String(resolvable.id) : null,
                context: resolvable?.context ? String(resolvable.context).toLowerCase() : null,
                cardId: card?.cardId ? String(card.cardId) : null,
                shortCode: shortCode || null,
                url: url || null,
                versionBefore: Number.isFinite(versionBefore) ? versionBefore : null,
                versionAfter: versionAfter ?? null,
                updatedAt: updatedAt || null,
                preview,
            },
        );
    },
});

export const card_close_resolvable = tool({
    description: "Close a Codecks conversation thread (resolvable).",
    args: {
        resolvableId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Resolvable ID."),
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Card ID or short code if resolvableId is not provided."),
        context: tool.schema.enum(["comment", "review", "block", "blocker"]).optional().describe("Optional context filter when selecting an open card resolvable."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const target = await resolveResolvableTarget({
            resolvableId: args.resolvableId,
            cardId: args.cardId,
            context: args.context,
        });
        if ("error" in target)
        {
            return toStructuredErrorResult(format, "card-close-resolvable", "validation_error", target.error);
        }

        const resolvableId = String(target.resolvable.id ?? "").trim();
        if (!resolvableId)
        {
            return toStructuredErrorResult(format, "card-close-resolvable", "validation_error", "Resolvable ID is required.");
        }

        if (target.resolvable.isClosed)
        {
            return toStructuredErrorResult(
                format,
                "card-close-resolvable",
                "validation_error",
                "Resolvable is already closed.",
                { resolvableId },
            );
        }

        let actor: { id: string | number; verifiedOrg: boolean };
        try { actor = await fetchSharedActor(); }
        catch (error) { return toStructuredErrorResult(format, "card-close-resolvable", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }
        try
        {
            await runDispatch("resolvables/close", {
                id: resolvableId,
                closedBy: actor.id,
            }, actor.verifiedOrg ? String(actor.id) : undefined);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-close-resolvable", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), {
                resolvableId, ...getOperationErrorData(error),
            });
        }

        const shortCode = target.shortCode || "";
        const url = shortCode ? formatCardUrl(shortCode) : "";
        const context = String(target.resolvable.context ?? "comment").toLowerCase();
        const contextLabel = formatResolvableContextLabel(context);
        const lines = [
            "## Resolvable Closed",
            "",
            `- Card: ${target.cardTitle || "(untitled)"}`,
            `- Card ID: ${target.cardId || "(n/a)"}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Resolvable ID: ${resolvableId}`,
            `- Context: ${contextLabel} (key: ${context})`,
        ];

        return toStructuredResult(
            format,
            "card-close-resolvable",
            lines.join("\n"),
            {
                cardId: target.cardId || null,
                shortCode: shortCode || null,
                url: url || null,
                resolvableId,
                context,
                contextLabel,
            },
        );
    },
});

export const card_reopen_resolvable = tool({
    description: "Reopen a closed Codecks conversation thread (resolvable).",
    args: {
        resolvableId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Resolvable ID."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const resolvableId = String(args.resolvableId).trim();
        if (!resolvableId)
        {
            return toStructuredErrorResult(format, "card-reopen-resolvable", "validation_error", "Resolvable ID is required.");
        }

        let before: CodecksEntity | undefined;
        try
        {
            before = await fetchResolvableById(resolvableId);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-reopen-resolvable", "api_error", toErrorMessage(error), {
                resolvableId,
            });
        }

        if (!before)
        {
            return toStructuredErrorResult(format, "card-reopen-resolvable", "not_found", "Resolvable not found.", {
                resolvableId,
            });
        }

        if (!before.isClosed)
        {
            return toStructuredErrorResult(
                format,
                "card-reopen-resolvable",
                "validation_error",
                "Resolvable is already open.",
                { resolvableId },
            );
        }

        let orgActorId: string | undefined;
        if (getBaseConfig().profileKey === "ORG")
        {
            try { orgActorId = String((await fetchSharedActor()).id); }
            catch (error) { return toStructuredErrorResult(format, "card-reopen-resolvable", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }
        }
        try
        {
            await runDispatch("resolvables/reopen", { id: resolvableId }, orgActorId);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-reopen-resolvable", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), {
                resolvableId, ...getOperationErrorData(error),
            });
        }

        const card = typeof before.card === "object" && before.card ? before.card as CodecksEntity : undefined;
        const shortCode = formatShortCode(card?.accountSeq as number | undefined);
        const url = shortCode ? formatCardUrl(shortCode) : "";
        const context = String(before.context ?? "comment").toLowerCase();
        const contextLabel = formatResolvableContextLabel(context);
        const lines = [
            "## Resolvable Reopened",
            "",
            `- Card: ${card?.title ? String(card.title) : "(untitled)"}`,
            `- Card ID: ${card?.cardId ? String(card.cardId) : "(n/a)"}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Resolvable ID: ${resolvableId}`,
            `- Context: ${contextLabel} (key: ${context})`,
        ];

        return toStructuredResult(
            format,
            "card-reopen-resolvable",
            lines.join("\n"),
            {
                cardId: card?.cardId ? String(card.cardId) : null,
                shortCode: shortCode || null,
                url: url || null,
                resolvableId,
                context,
                contextLabel,
            },
        );
    },
});
