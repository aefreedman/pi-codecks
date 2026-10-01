import { validateMutationText } from "../../shared/mutation-text";
import { getBaseConfig } from "../../runtime/credentials";
import { fetchLoggedInUser, fetchSharedActor } from "../../runtime/identity";
import { getActiveWorkspaceRoot } from "../../runtime/operation-context";
import { CodecksOperationError } from "../../runtime/operation-error";
import { runDispatch, runQuery } from "../../runtime/transport";
import { type CardTypeValue, isIntrinsicDocumentationCard, resolveCardType } from "../../shared/card-observation";
import { cardDetailFields, fetchCardByAccountSeq, fetchCardById, resolveCardForUpdate } from "../../shared/card-queries";
import { buildReusableCardRefs, formatShortCode, normalizeCardReferencesForUserText, parseCardIdentifier } from "../../shared/card-reference";
import { extractRelationEntities, getEntityMap, resolveFromMap } from "../../shared/entity-maps";
import { renderLookupMessage, resolveDeck, resolveMilestone } from "../../shared/entity-resolution";
import { blankToUndefined, formatIdForQuery, unwrapData } from "../../shared/query";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult, truncateStructuredValue } from "../../shared/results";
import { type RunLookupResult, resolveRunForUpdate } from "../../shared/runs";
import { generateSessionId } from "../../shared/session-id";
import { outputFormatArg } from "../../pi-tool-compat";
import { type CodecksEntity } from "../../shared/types";
import { formatCardUrl } from "../../shared/urls";
import { resolveAssigneeId } from "../../shared/users";
import { tool } from "../../pi-tool-compat";
import { join } from "path";
import { resolve } from "path";
import { normalizeCreateTags, buildBodyHashtagTokens, appendBodyHashtagsToCardContent, normalizeCardTypeInput, normalizePriorityInput, normalizeStatusInput, normalizeCardTitleLine, splitCardContent, buildCardContent, removeDuplicateBodyTitle, normalizeCardTitleInput, normalizeCardBodyInput, resolveCardDocument, type SignedUploadInfo, snapshotAttachmentSource, assertUnchangedAttachmentSource, detectContentType, requestSignedUpload, uploadFileToSignedUrl, fetchCardForStatusUpdate, buildCardCreatePayload, actionKeyFor, extractDispatchCardIdentity, classifyMutationOutcome, mutateNamedHand } from "./helpers";

export const card_create = tool({
    description: "Create a Codecks card in a deck or milestone.",
    args: {
        title: tool.schema.string().optional().describe("Card title."),
        content: tool.schema.string().optional().describe("Card body content. Legacy full-document input is normalized to a plain first-line title plus body."),
        cardType: tool.schema.string().optional().describe("Card type: regular or documentation."),
        deck: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Deck name or ID."),
        milestone: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Milestone name or ID."),
        effort: tool.schema.number().optional().describe("Effort value."),
        priority: tool.schema.string().optional().describe("Priority label."),
        assigneeId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Assignee ID."),
        putOnHand: tool.schema.boolean().optional().describe("PERSONAL own-hand creation; ORG target is unverified and remains guarded."),
        parentCardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Optional parent Hero card ID, short code, or URL."),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Optional list of tags. Added to card body as #hashtags."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const textErrors = validateMutationText([
            ["title", args.title],
            ["content", args.content],
            ...(args.tags ?? []).map((tag, index) => [`tags[${index}]`, tag] as [string, unknown]),
        ]);
        if (textErrors.length > 0)
        {
            return toStructuredErrorResult(format, "card-create", "validation_error", textErrors.join(" "), { indexedErrors: textErrors, requestsAttempted: 0 });
        }
        const document = resolveCardDocument(args.title, args.content);
        const content = buildCardContent(document.titleLine, document.body);
        const normalizedTags = normalizeCreateTags(args.tags);
        const bodyHashtagTokens = buildBodyHashtagTokens(normalizedTags);
        const contentWithTags = appendBodyHashtagsToCardContent(content, bodyHashtagTokens);

        if (!content)
        {
            return toStructuredErrorResult(format, "card-create", "validation_error", "Card content is required (title and/or content).");
        }

        const resolvedTitle = document.titleLine;
        const deckArg = blankToUndefined(args.deck);
        const milestoneArg = blankToUndefined(args.milestone);
        const assigneeArg = blankToUndefined(args.assigneeId);
        const parentCardArg = blankToUndefined(args.parentCardId);
        if (getBaseConfig().profileKey === "ORG" && args.putOnHand === true)
            return toStructuredErrorResult(format, "card-create", "org_actor_unverified", "ORG has no own hand. The target for putOnHand is unverified; no mutation was sent.");
        if (getBaseConfig().profileKey === "ORG" && deckArg === undefined && assigneeArg === undefined)
            return toStructuredErrorResult(format, "card-create", "validation_error", "A card cannot be both unassigned and deckless; provide deck or assigneeId. No mutation was sent.");

        let normalizedCardType: { value: CardTypeValue; label: string; isDoc: boolean } | null = null;
        if (args.cardType !== undefined)
        {
            normalizedCardType = normalizeCardTypeInput(String(args.cardType));
            if (!normalizedCardType)
            {
                return toStructuredErrorResult(
                    format,
                    "card-create",
                    "validation_error",
                    "Card type must be one of: regular, documentation (aliases: doc, docs).",
                );
            }
        }

        let deckId: string | number | null = null;
        if (deckArg !== undefined)
        {
            const deckResult = await resolveDeck(deckArg);
            if (deckResult.kind !== "resolved")
            {
                return toStructuredErrorResult(
                    format,
                    "card-create",
                    deckResult.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                    renderLookupMessage(deckResult, String(deckArg ?? "")),
                );
            }
            deckId = String(deckResult.id);
        }

        let milestoneId: string | number | null = null;
        if (milestoneArg !== undefined)
        {
            const milestoneResult = await resolveMilestone(milestoneArg);
            if (milestoneResult.kind !== "resolved")
            {
                return toStructuredErrorResult(
                    format,
                    "card-create",
                    milestoneResult.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                    renderLookupMessage(milestoneResult, String(milestoneArg ?? "")),
                );
            }
            milestoneId = String(milestoneResult.id);
        }

        let assigneeId: string | number | null;
        try
        {
            assigneeId = getBaseConfig().profileKey === "ORG" && assigneeArg === undefined
                ? null : await resolveAssigneeId(assigneeArg ?? null);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-create", "validation_error", toErrorMessage(error));
        }

        let normalizedPriority: { code: string | null; label: string } | null = null;
        if (args.priority !== undefined)
        {
            normalizedPriority = normalizePriorityInput(String(args.priority));
            if (!normalizedPriority)
            {
                return toStructuredErrorResult(
                    format,
                    "card-create",
                    "validation_error",
                    "Priority must be one of: none, low, medium, high, a, b, c.",
                );
            }
        }

        const user = getBaseConfig().profileKey === "ORG" ? undefined : await fetchLoggedInUser();
        let parentCardId: string | undefined;
        if (parentCardArg !== undefined)
        {
            const parentResolved = await resolveCardForUpdate(parentCardArg);
            if (!parentResolved)
            {
                return toStructuredErrorResult(format, "card-create", "not_found", "Parent card not found.");
            }
            parentCardId = parentResolved.cardId;
        }

        const createsPrivateCard = !deckId && !parentCardId;

        const payload = buildCardCreatePayload({
            assigneeId,
            content: contentWithTags,
            putOnHand: args.putOnHand ?? false,
            deckId,
            milestoneId,
            effort: args.effort ?? null,
            priority: normalizedPriority?.code ?? null,
            userId: user?.id,
            parentCardId: parentCardId ?? null,
            isDoc: normalizedCardType?.isDoc,
        });

        let response: unknown;
        try
        {
            response = await runDispatch("cards/create", payload);
        }
        catch (error)
        {
            const category = error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error));
            return toStructuredErrorResult(format, "card-create", category, toErrorMessage(error), getOperationErrorData(error));
        }
        const createdData = unwrapData(response) as Record<string, unknown> | undefined;
        const createdCard = createdData?.card && typeof createdData.card === "object"
            ? createdData.card as Record<string, unknown>
            : createdData;
        const dispatchIdentity = extractDispatchCardIdentity(response);
        const createdId = dispatchIdentity.cardId ?? "";
        const createdSeq = dispatchIdentity.accountSeq ?? undefined;
        const createdCardType = normalizedCardType?.value
            ?? resolveCardType(createdCard as CodecksEntity | undefined);
        const shortCode = createdSeq !== undefined ? formatShortCode(createdSeq) : "";
        const url = shortCode ? formatCardUrl(shortCode) : "";
        const lines = [
            "## Card Created",
            "",
            `- Title: ${resolvedTitle || "(untitled)"}`,
            `- Short Code: ${shortCode || "(unavailable)"}`,
            `- URL: ${url || "(unavailable)"}`,
            `- Card Type: ${createdCardType}`,
            `- Parent Card: ${parentCardId ?? "(none)"}`,
            `- Priority: ${normalizedPriority?.label ?? "None"}`,
            `- Tags: ${normalizedTags.length > 0 ? normalizedTags.join(", ") : "None"}`,
            `- Body Hashtags: ${bodyHashtagTokens.length > 0 ? bodyHashtagTokens.map((tag) => `#${tag}`).join(" ") : "None"}`,
            `- Private Card: ${createsPrivateCard ? "Yes (no deck assigned)" : "No"}`,
        ];
        const warnings = createsPrivateCard
            ? ["Card was created as a Private card because no deck was assigned."]
            : undefined;
        return toStructuredResult(
            format,
            "card-create",
            lines.join("\n"),
            {
                title: resolvedTitle || "(untitled)",
                cardId: createdId || null,
                shortCode: shortCode || null,
                ...buildReusableCardRefs(createdSeq),
                url: url || null,
                cardType: createdCardType,
                parentCardId: parentCardId ?? null,
                privateCard: createsPrivateCard,
                ownerId: assigneeId,
                assigneeId,
                priority: normalizedPriority?.label ?? "None",
                tags: normalizedTags,
                bodyHashtags: bodyHashtagTokens,
            },
            warnings,
        );
    },
});

export const card_set_parent = tool({
    description: "Set or clear a card's Hero parent (sub-card relationship).",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL for the child card."),
        parentCardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Hero card ID, short code, or URL. Omit to clear parent."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const childResolved = await resolveCardForUpdate(args.cardId);
        if (!childResolved)
        {
            return toStructuredErrorResult(format, "card-set-parent", "not_found", "Child card not found.");
        }

        let parentResolved: { cardId: string; shortCode: string; title: string } | null = null;
        if (args.parentCardId !== undefined)
        {
            const rawParent = String(args.parentCardId).trim();
            if (rawParent)
            {
                parentResolved = await resolveCardForUpdate(args.parentCardId);
                if (!parentResolved)
                {
                    return toStructuredErrorResult(format, "card-set-parent", "not_found", "Parent card not found.");
                }
            }
        }

        if (parentResolved && parentResolved.cardId === childResolved.cardId)
        {
            return toStructuredErrorResult(format, "card-set-parent", "validation_error", "A card cannot be its own parent.");
        }

        const payload: Record<string, unknown> = {
            sessionId: generateSessionId(),
            id: childResolved.cardId,
            parentCardId: parentResolved ? parentResolved.cardId : null,
        };

        try
        {
            await runDispatch("cards/update", payload);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-set-parent", "api_error", toErrorMessage(error));
        }

        const childUrl = childResolved.shortCode ? formatCardUrl(childResolved.shortCode) : "";
        const parentUrl = parentResolved?.shortCode ? formatCardUrl(parentResolved.shortCode) : "";
        const lines = [
            "## Card Parent Updated",
            "",
            `- Child: ${childResolved.shortCode || childResolved.cardId} ${childResolved.title || "(untitled)"}`,
            `- Child URL: ${childUrl || ""}`,
            parentResolved
                ? `- Parent: ${parentResolved.shortCode || parentResolved.cardId} ${parentResolved.title || "(untitled)"}`
                : "- Parent: (cleared)",
            parentResolved
                ? `- Parent URL: ${parentUrl || ""}`
                : "- Parent URL: (none)",
        ];

        return toStructuredResult(
            format,
            "card-set-parent",
            lines.join("\n"),
            {
                child: {
                    cardId: childResolved.cardId,
                    shortCode: childResolved.shortCode || null,
                    cardRef: childResolved.shortCode || null,
                    url: childUrl || null,
                    title: childResolved.title || "(untitled)",
                },
                parent: parentResolved
                    ? {
                        cardId: parentResolved.cardId,
                        shortCode: parentResolved.shortCode || null,
                        cardRef: parentResolved.shortCode || null,
                        url: parentUrl || null,
                        title: parentResolved.title || "(untitled)",
                    }
                    : null,
            },
        );
    },
});

export const card_update_run = tool({
    description: "Assign a Codecks card to a Run, or remove it from its Run, by updating sprintId.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        runId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Run/Sprint ID, account sequence, or label search."),
        sprintId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Alias for runId."),
        clearRun: tool.schema.boolean().optional().describe("Remove the card from its current Run by setting sprintId to null."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const card = await resolveCardForUpdate(args.cardId);
        if (!card)
        {
            return toStructuredErrorResult(format, "card-update-run", "not_found", "Card not found.");
        }

        const rawRunId = args.runId ?? args.sprintId;
        if (args.clearRun !== true && (rawRunId === undefined || String(rawRunId).trim() === ""))
        {
            return toStructuredErrorResult(format, "card-update-run", "validation_error", "Provide runId/sprintId or set clearRun=true.");
        }

        let run: RunLookupResult | null = null;
        if (args.clearRun !== true && rawRunId !== undefined)
        {
            try
            {
                run = await resolveRunForUpdate(rawRunId);
            }
            catch (error)
            {
                return toStructuredErrorResult(format, "card-update-run", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
            }

            if (!run)
            {
                return toStructuredErrorResult(format, "card-update-run", "not_found", "Run not found.");
            }
        }

        try
        {
            await runDispatch("cards/update", {
                sessionId: generateSessionId(),
                id: card.cardId,
                sprintId: run ? run.runId : null,
            });
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-update-run", "api_error", toErrorMessage(error));
        }

        const lines = [
            "## Card Run Updated",
            "",
            `- Card: ${card.shortCode || card.cardId} ${card.title || "(untitled)"}`,
            run
                ? `- Run: #${run.accountSeq ?? "?"} ${run.label}`
                : "- Run: (cleared)",
        ];

        return toStructuredResult(
            format,
            "card-update-run",
            lines.join("\n"),
            {
                cardId: card.cardId,
                shortCode: card.shortCode || null,
                cardRef: card.shortCode || null,
                runId: run?.runId ?? null,
                sprintId: run?.runId ?? null,
                runAccountSeq: run?.accountSeq ?? null,
            },
        );
    },
});

export const card_add_attachment = tool({
    description: "Attach a file to a Codecks card.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        filePath: tool.schema.string().min(1).describe("Path to the file to attach."),
        contentType: tool.schema.string().optional().describe("Optional MIME type override."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const parsed = parseCardIdentifier(args.cardId);
        let accountSeq = parsed.accountSeq;
        let cardId = parsed.cardId ?? args.cardId;
        let title = "";
        let shortCode = parsed.cardCode ? `$${parsed.cardCode}` : "";

        if (accountSeq !== undefined)
        {
            const cardMeta = await fetchCardByAccountSeq(accountSeq);
            if (!cardMeta?.cardId)
            {
                return toStructuredErrorResult(format, "card-add-attachment", "not_found", "Card not found.");
            }
            cardId = cardMeta.cardId as string;
            title = String(cardMeta.title ?? "");
            accountSeq = cardMeta.accountSeq as number | undefined;
            shortCode = formatShortCode(accountSeq);
        }

        if (!cardId)
        {
            return toStructuredErrorResult(format, "card-add-attachment", "validation_error", "Card ID is required.");
        }

        const workspaceRoot = getActiveWorkspaceRoot();
        const source = await snapshotAttachmentSource(args.filePath, workspaceRoot);
        let actor: { id: string | number; verifiedOrg: boolean };
        try { actor = await fetchSharedActor(); }
        catch (error) { return toStructuredErrorResult(format, "card-add-attachment", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error)); }
        const contentType = detectContentType(source.canonicalPath, args.contentType);
        let signed: SignedUploadInfo;
        try { signed = await requestSignedUpload(source); }
        catch (error) { return toStructuredErrorResult(format, "card-add-attachment", error instanceof CodecksOperationError ? error.category : "api_error", error instanceof CodecksOperationError ? toErrorMessage(error) : "Codecks upload signing failed; no storage upload or card registration was attempted.", { uploadStage: "sign", ...getOperationErrorData(error) }); }
        // Re-resolve and re-hash immediately before the upload attempt. The bytes
        // uploaded are exactly the bytes from this second, validated snapshot.
        const uploadSource = await snapshotAttachmentSource(args.filePath, workspaceRoot);
        assertUnchangedAttachmentSource(source, uploadSource);
        let uploaded: { fileName: string; size: number; type: string; url: string };
        try { uploaded = await uploadFileToSignedUrl(signed, uploadSource, contentType); }
        catch (error) { return toStructuredErrorResult(format, "card-add-attachment", error instanceof CodecksOperationError ? error.category : "api_error", "Signed storage upload outcome is uncertain; inspect the exact card before any further write.", { uploadStage: "storage", mutationCertainty: "indeterminate", ...getOperationErrorData(error) }); }

        try
        {
            await runDispatch("cards/addFile", {
                cardId,
                userId: actor.id,
                fileData: {
                    fileName: uploaded.fileName,
                    url: uploaded.url,
                    size: uploaded.size,
                    type: uploaded.type,
                },
            } as Record<string, unknown>, actor.verifiedOrg ? String(actor.id) : undefined);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-add-attachment", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const url = shortCode ? formatCardUrl(shortCode) : "";
        const lines = [
            "## Attachment Added",
            "",
            `- Card: ${title || "(untitled)"}`,
            `- Card ID: ${cardId}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- File: ${uploaded.fileName}`,
            `- Type: ${uploaded.type}`,
            `- Size: ${uploaded.size} bytes`,
            `- File URL: ${uploaded.url}`,
        ];

        return toStructuredResult(
            format,
            "card-add-attachment",
            lines.join("\n"),
            {
                cardId,
                shortCode: shortCode || null,
                url: url || null,
                fileName: uploaded.fileName,
                type: uploaded.type,
                size: uploaded.size,
                fileUrl: uploaded.url,
            },
        );
    },
});

export const card_update = tool({
    description: "Update Codecks card title/body content (including markdown/code blocks) or metadata.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        title: tool.schema.string().optional().describe("New card title."),
        content: tool.schema.string().optional().describe("Card body content (markdown, text, or code blocks). Legacy full-document input is normalized to a plain first-line title plus body."),
        cardType: tool.schema.string().optional().describe("Card type: regular or documentation."),
        deck: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Deck name or ID."),
        milestone: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Milestone name or ID."),
        assigneeId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Assignee ID."),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Replacement list of card tags."),
        mode: tool.schema.enum(["replace", "append", "prepend"]).optional().describe("How to apply content updates."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const textErrors = validateMutationText([
            ["title", args.title],
            ["content", args.content],
            ...(args.tags ?? []).map((tag, index) => [`tags[${index}]`, tag] as [string, unknown]),
        ]);
        if (textErrors.length > 0)
        {
            return toStructuredErrorResult(format, "card-update", "validation_error", textErrors.join(" "), { indexedErrors: textErrors, requestsAttempted: 0 });
        }
        if (
            args.title === undefined
            && args.content === undefined
            && args.cardType === undefined
            && args.deck === undefined
            && args.milestone === undefined
            && args.assigneeId === undefined
            && args.tags === undefined
        )
        {
            return toStructuredErrorResult(
                format,
                "card-update",
                "validation_error",
                "Provide at least one field to update (title, content, cardType, deck, milestone, assigneeId, tags).",
            );
        }

        const mode = args.mode ?? "replace";
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
            return toStructuredErrorResult(format, "card-update", "not_found", "Card not found.");
        }

        cardId = current.cardId as string;
        accountSeq = current.accountSeq as number | undefined;
        shortCode = formatShortCode(accountSeq);

        if (!cardId)
        {
            return toStructuredErrorResult(format, "card-update", "validation_error", "Card ID is required.");
        }

        let normalizedCardType: { value: CardTypeValue; label: string; isDoc: boolean } | null = null;
        if (args.cardType !== undefined)
        {
            normalizedCardType = normalizeCardTypeInput(String(args.cardType));
            if (!normalizedCardType)
            {
                return toStructuredErrorResult(
                    format,
                    "card-update",
                    "validation_error",
                    "Card type must be one of: regular, documentation (aliases: doc, docs).",
                );
            }
        }

        const existingContent = current.content ? String(current.content) : "";
        const parts = splitCardContent(existingContent, current.title ? String(current.title) : "");
        const updatedTitleLine = args.title !== undefined
            ? normalizeCardTitleInput(String(args.title))
            : parts.titleLine;
        let updatedBody = parts.body;

        const resolvedTitle = updatedTitleLine || (current.title ? normalizeCardTitleLine(String(current.title)) : "");
        if (args.content !== undefined)
        {
            const cleaned = normalizeCardBodyInput(String(args.content));
            const incomingBody = removeDuplicateBodyTitle(resolvedTitle, cleaned);
            if (mode === "append")
            {
                updatedBody = updatedBody
                    ? incomingBody
                        ? `${updatedBody}\n\n${incomingBody}`
                        : updatedBody
                    : incomingBody;
            }
            else if (mode === "prepend")
            {
                updatedBody = updatedBody
                    ? incomingBody
                        ? `${incomingBody}\n\n${updatedBody}`
                        : updatedBody
                    : incomingBody;
            }
            else
            {
                updatedBody = cleaned;
            }
        }

        updatedBody = removeDuplicateBodyTitle(resolvedTitle, updatedBody);
        const updatedContent = (args.content !== undefined || args.title !== undefined)
            ? normalizeCardReferencesForUserText(appendBodyHashtagsToCardContent(buildCardContent(resolvedTitle, updatedBody), []))
            : undefined;
        const payload: Record<string, unknown> = {
            sessionId: generateSessionId(),
            id: cardId,
        };

        if (args.deck !== undefined)
        {
            const deckResult = await resolveDeck(args.deck);
            if (deckResult.kind !== "resolved")
            {
                return toStructuredErrorResult(
                    format,
                    "card-update",
                    deckResult.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                    renderLookupMessage(deckResult, String(args.deck ?? "")),
                );
            }
            payload.deckId = deckResult.id;
        }

        if (args.milestone !== undefined)
        {
            const milestoneResult = await resolveMilestone(args.milestone);
            if (milestoneResult.kind !== "resolved")
            {
                return toStructuredErrorResult(
                    format,
                    "card-update",
                    milestoneResult.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                    renderLookupMessage(milestoneResult, String(args.milestone ?? "")),
                );
            }
            payload.milestoneId = milestoneResult.id;
        }

        if (args.assigneeId !== undefined)
        {
            try
            {
                payload.assigneeId = await resolveAssigneeId(args.assigneeId);
            }
            catch (error)
            {
                return toStructuredErrorResult(format, "card-update", "validation_error", toErrorMessage(error));
            }
        }

        if (args.tags !== undefined)
        {
            payload.masterTags = normalizeCreateTags(args.tags);
        }

        if ((args.title !== undefined || updatedContent !== undefined) && resolvedTitle)
        {
            payload.title = resolvedTitle;
        }

        if (updatedContent !== undefined)
        {
            payload.content = updatedContent;
        }

        if (normalizedCardType)
        {
            payload.isDoc = normalizedCardType.isDoc;
        }

        if (Object.keys(payload).length <= 2)
        {
            return toStructuredErrorResult(
                format,
                "card-update",
                "validation_error",
                "Provide at least one field to update (title, content, cardType, deck, milestone, assigneeId, tags).",
            );
        }

        let dispatchReturned: unknown;
        try
        {
            dispatchReturned = unwrapData(await runDispatch("cards/update", payload));
        }
        catch (error)
        {
            const outcome = classifyMutationOutcome(error);
            return toStructuredErrorResult(format, "card-update", outcome === "indeterminate" ? "request_timeout" : "api_error", toErrorMessage(error), {
                status: outcome,
                certainty: outcome === "indeterminate" ? "possibly_applied" : "definitely_rejected",
                actionKey: actionKeyFor("update", 0, payload),
                retry: outcome === "indeterminate" ? "do_not_retry" : "not_automatic",
            });
        }

        const resolvedCardType = normalizedCardType?.value ?? resolveCardType(current);
        const title = resolvedTitle ?? (current?.title ? String(current.title) : "");
        const url = shortCode ? formatCardUrl(shortCode) : "";
        const fieldsUpdated = [
            args.title !== undefined ? "title" : null,
            args.content !== undefined ? "content" : null,
            args.cardType !== undefined ? "cardType" : null,
            args.deck !== undefined ? "deck" : null,
            args.milestone !== undefined ? "milestone" : null,
            args.assigneeId !== undefined ? "assignee" : null,
            args.tags !== undefined ? "tags" : null,
        ].filter(Boolean) as string[];

        const lines = [
            "## Card Updated",
            "",
            `- Title: ${title || "(untitled)"}`,
            `- ID: ${cardId}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Card Type: ${resolvedCardType}`,
            `- Updated Fields: ${fieldsUpdated.length > 0 ? fieldsUpdated.join(", ") : "(none)"}`,
        ];

        if (args.content !== undefined)
        {
            lines.push(`- Content Mode: ${mode}`);
        }

        return toStructuredResult(
            format,
            "card-update",
            lines.join("\n"),
            {
                responseSchemaVersion: 1,
                status: "updated",
                certainty: "dispatch_returned",
                actionKey: actionKeyFor("update", 0, payload),
                normalizedRequested: {
                    title: payload.title ?? null,
                    content: payload.content ?? null,
                    deckId: payload.deckId ?? null,
                    milestoneId: payload.milestoneId ?? null,
                    assigneeId: payload.assigneeId ?? null,
                    tags: payload.masterTags ?? null,
                    cardType: normalizedCardType?.value ?? null,
                },
                dispatchReturned: truncateStructuredValue(dispatchReturned).value,
                persistedVerified: null,
                verificationState: "not_performed",
                title: title || "(untitled)",
                cardId,
                shortCode: shortCode || null,
                url: url || null,
                cardType: resolvedCardType,
                updatedFields: fieldsUpdated,
                contentMode: args.content !== undefined ? mode : null,
            },
        );
    },
});

export const card_update_status = tool({
    description: "Update a Codecks card status. Fails fast for unsupported operations such as documentation-card status writes and starting hero cards directly.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        status: tool.schema.string().min(1).describe("New status (e.g. not_started, started, done). Documentation cards cannot change status, and hero cards cannot be started directly."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const normalizedStatus = normalizeStatusInput(String(args.status));
        if (!normalizedStatus)
        {
            return toStructuredErrorResult(
                format,
                "card-update-status",
                "validation_error",
                "Status must be one of: not_started, started, done (aliases: todo, in_progress, completed).",
            );
        }

        const parsed = parseCardIdentifier(args.cardId);
        let cardId = parsed.cardId ?? args.cardId;
        let accountSeq = parsed.accountSeq;
        let shortCode = parsed.cardCode ? `$${parsed.cardCode}` : "";
        const statusTarget = accountSeq !== undefined
            ? await fetchCardForStatusUpdate({ accountSeq })
            : typeof cardId === "string"
                ? await fetchCardForStatusUpdate({ cardId })
                : { openContexts: new Set<string>() };
        const current = statusTarget.card;

        if (!current?.cardId)
        {
            return toStructuredErrorResult(format, "card-update-status", "not_found", "Card not found.");
        }

        cardId = current.cardId as string;
        accountSeq = current.accountSeq as number | undefined;
        shortCode = formatShortCode(accountSeq);

        if (!cardId)
        {
            return toStructuredErrorResult(format, "card-update-status", "validation_error", "Card ID is required.");
        }

        const title = current.title ? String(current.title) : "";
        if (isIntrinsicDocumentationCard(current))
        {
            return toStructuredErrorResult(
                format,
                "card-update-status",
                "validation_error",
                "Documentation cards do not support status changes. Update the card content or card type instead.",
                {
                    cardId,
                    shortCode: shortCode || null,
                    title: title || null,
                    cardType: "documentation",
                },
            );
        }

        if (normalizedStatus.code === "started")
        {
            const detailIdLiteral = formatIdForQuery(cardId);
            let detailCard = current;
            let childCount = 0;

            try
            {
                const detailPayload = await runQuery({
                    [`card(${detailIdLiteral})`]: cardDetailFields,
                });
                const detailData = unwrapData(detailPayload) as Record<string, unknown> | undefined;
                const detailCardMap = getEntityMap(detailData, "card");
                const detailLookupKey = `card(${detailIdLiteral})`;
                detailCard = detailCardMap[String(cardId)]
                    ?? resolveFromMap(detailData ? detailData[detailLookupKey] : undefined, detailCardMap)
                    ?? (detailData ? (detailData.card as CodecksEntity | undefined) : undefined)
                    ?? current;
                childCount = extractRelationEntities(detailCard, "childCards", detailCardMap).length;
            }
            catch (error)
            {
                return toStructuredErrorResult(format, "card-update-status", "api_error", toErrorMessage(error));
            }

            if (childCount > 0)
            {
                return toStructuredErrorResult(
                    format,
                    "card-update-status",
                    "validation_error",
                    "Hero cards cannot be started directly. Start or update a sub-card instead.",
                    {
                        cardId,
                        shortCode: shortCode || null,
                        title: String(detailCard?.title ?? title) || null,
                        childCount,
                    },
                );
            }
        }

        try
        {
            if (statusTarget.openContexts.has("review"))
            {
                return toStructuredErrorResult(
                    format,
                    "card-update-status",
                    "validation_error",
                    "Cannot change card status while the card has an open Review. Reply to or resolve the Review first.",
                    {
                        cardId,
                        shortCode: shortCode || null,
                        title: title || null,
                        blockedByContext: "review",
                    },
                );
            }

            await runDispatch("cards/update", {
                sessionId: generateSessionId(),
                id: cardId,
                status: normalizedStatus.code,
            });
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-update-status", "api_error", toErrorMessage(error));
        }

        const url = shortCode ? formatCardUrl(shortCode) : "";
        const lines = [
            "## Card Status Updated",
            "",
            `- Title: ${title || "(untitled)"}`,
            `- ID: ${cardId}`,
            `- Short Code: ${shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Status: ${normalizedStatus.code}`,
        ];

        return toStructuredResult(
            format,
            "card-update-status",
            lines.join("\n"),
            {
                cardId,
                shortCode: shortCode || null,
                url: url || null,
                status: normalizedStatus.code,
            },
        );
    },
});

// Hand writes must start from the complete target queue, not a search preview:
// setCardOrders replaces an ordered list, and a truncated page could drop existing cards.

export const card_add_to_hand = tool({
    description: "Append exactly one existing card to a named human's complete current Hand order. ORG needs an explicit human userId; PERSONAL defaults to own Hand. Refuses incomplete/changed order and verifies readback.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID or short code."),
        userId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Named human user ID; required for ORG."),
        format: outputFormatArg,
    },
    execute: (args) => mutateNamedHand("card-add-to-hand", args),
});

export const card_remove_from_hand = tool({
    description: "Remove exactly one verified card entry from a named human Hand without changing other entries or card assignment. ORG needs an explicit human userId; PERSONAL defaults to own Hand.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID or short code."),
        userId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Named human user ID; required for ORG."),
        format: outputFormatArg,
    },
    execute: (args) => mutateNamedHand("card-remove-from-hand", args),
});

export const card_update_effort = tool({
    description: "Update a Codecks card effort value.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        effort: tool.schema.number().describe("Effort value."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const resolved = await resolveCardForUpdate(args.cardId);
        if (!resolved)
        {
            return toStructuredErrorResult(format, "card-update-effort", "not_found", "Card not found.");
        }

        try
        {
            await runDispatch("cards/update", {
                sessionId: generateSessionId(),
                id: resolved.cardId,
                effort: args.effort,
            });
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-update-effort", "api_error", toErrorMessage(error));
        }

        const url = resolved.shortCode ? formatCardUrl(resolved.shortCode) : "";
        const lines = [
            "## Card Effort Updated",
            "",
            `- Title: ${resolved.title || "(untitled)"}`,
            `- ID: ${resolved.cardId}`,
            `- Short Code: ${resolved.shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Effort: ${args.effort}`,
        ];

        return toStructuredResult(
            format,
            "card-update-effort",
            lines.join("\n"),
            {
                cardId: resolved.cardId,
                shortCode: resolved.shortCode || null,
                url: url || null,
                effort: args.effort,
            },
        );
    },
});

export const card_update_priority = tool({
    description: "Update a Codecks card priority value.",
    args: {
        cardId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Card ID, short code, or URL."),
        priority: tool.schema.string().min(1).describe("Priority label (none, low, medium, high) or code (a, b, c)."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const normalized = normalizePriorityInput(String(args.priority ?? ""));
        if (!normalized)
        {
            return toStructuredErrorResult(
                format,
                "card-update-priority",
                "validation_error",
                "Priority must be one of: none, low, medium, high, a, b, c.",
            );
        }

        const resolved = await resolveCardForUpdate(args.cardId);
        if (!resolved)
        {
            return toStructuredErrorResult(format, "card-update-priority", "not_found", "Card not found.");
        }

        try
        {
            await runDispatch("cards/update", {
                sessionId: generateSessionId(),
                id: resolved.cardId,
                priority: normalized.code,
            });
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "card-update-priority", "api_error", toErrorMessage(error));
        }

        const url = resolved.shortCode ? formatCardUrl(resolved.shortCode) : "";
        const lines = [
            "## Card Priority Updated",
            "",
            `- Title: ${resolved.title || "(untitled)"}`,
            `- ID: ${resolved.cardId}`,
            `- Short Code: ${resolved.shortCode || "(n/a)"}`,
            `- URL: ${url || ""}`,
            `- Priority: ${normalized.label}`,
        ];

        return toStructuredResult(
            format,
            "card-update-priority",
            lines.join("\n"),
            {
                cardId: resolved.cardId,
                shortCode: resolved.shortCode || null,
                url: url || null,
                priority: normalized.label,
                priorityCode: normalized.code,
            },
        );
    },
});
