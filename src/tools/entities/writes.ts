import type { CodecksOperationPayload } from "../../pi/tool-definition";
import { withOperationContextIfMissing, getOperationContext } from "../../runtime/operation-context";
import { entityWriteSuccess, entityWriteError, entityEffect, failedEntityEffect } from "./entities-write-output";
import { validateMutationText } from "../../shared/mutation-text";
import { CodecksOperationError } from "../../runtime/operation-error";
import { runDispatch } from "../../runtime/transport";
import { type DeckLookupResult, type MilestoneLookupResult, renderLookupMessage, resolveDeckForUpdate, resolveMilestoneForUpdate } from "../../shared/entity-resolution";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { type RunLookupResult, resolveRunForUpdate } from "../../shared/runs";
import { generateSessionId } from "../../shared/session-id";
import { outputFormatArg } from "../../pi-tool-compat";
import { formatMilestoneUrl } from "../../shared/urls";
import { tool } from "../../pi-tool-compat";

export const deck_update = tool({
    description: "Update a Codecks deck description using decks/update.",
    args: {
        deckId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Deck ID, account sequence, or visible title."),
        description: tool.schema.string().optional().describe("Deck description. Use an empty string to clear."),
        clearDescription: tool.schema.boolean().optional().describe("Clear the deck description by setting description to an empty string."),
        format: outputFormatArg,
    },
    async execute(args): Promise<string>
    {
        return (await executeDeckUpdatePayload(args)).text;
    },
});

export const milestone_update = tool({
    description: "Update a Codecks Milestone description using milestones/update.",
    args: {
        milestoneId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Milestone ID, account sequence, or name search."),
        description: tool.schema.string().optional().describe("Milestone description. Use an empty string to clear."),
        clearDescription: tool.schema.boolean().optional().describe("Clear the milestone description by setting description to an empty string."),
        format: outputFormatArg,
    },
    async execute(args): Promise<string>
    {
        return (await executeMilestoneUpdatePayload(args)).text;
    },
});

export const run_update = tool({
    description: "Update a Codecks Run custom label or description using sprints/updateSprint.",
    args: {
        runId: tool.schema.union([tool.schema.string(), tool.schema.number()]).describe("Run/Sprint ID, account sequence, or label search."),
        customLabel: tool.schema.string().optional().describe("Run custom label. Maps to sprint.name."),
        name: tool.schema.string().optional().describe("Alias for customLabel. Maps to sprint.name."),
        clearCustomLabel: tool.schema.boolean().optional().describe("Clear the run custom label by setting name to null."),
        description: tool.schema.string().optional().describe("Run description. Maps to sprint.description."),
        format: outputFormatArg,
    },
    async execute(args): Promise<string>
    {
        return (await executeRunUpdatePayload(args)).text;
    },
});

export async function executeDeckUpdatePayload(args: Record<string, any>): Promise<CodecksOperationPayload> {
    return withOperationContextIfMissing(async () => {
        let facts: Record<string, unknown> = {};
        let effect = entityEffect("not_dispatched");
        let beforeDispatch = 0;
        const success = (...values: Parameters<typeof toStructuredResult>): CodecksOperationPayload => ({ text: toStructuredResult(...values), payload: entityWriteSuccess("deck-update", facts, effect) });
        const failure = (...values: Parameters<typeof toStructuredErrorResult>): CodecksOperationPayload => ({ text: toStructuredErrorResult(...values), payload: entityWriteError("deck-update", values[2], values[3], effect) });
        const format = args.format ?? "text";
        const textErrors = validateMutationText([["description", args.description]]);
        if (textErrors.length > 0)
        {
            return failure(format, "deck-update", "validation_error", textErrors.join(" "), { indexedErrors: textErrors, requestsAttempted: 0 });
        }
        const hasDescription = args.description !== undefined;
        const shouldClearDescription = args.clearDescription === true;
        if (!hasDescription && !shouldClearDescription)
        {
            return failure(format, "deck-update", "validation_error", "Provide description or set clearDescription=true.");
        }
        if (hasDescription && !shouldClearDescription && typeof args.description !== "string")
        {
            return failure(format, "deck-update", "validation_error", "description must be a string. Use clearDescription=true or description: \"\" to clear.");
        }

        let deck: DeckLookupResult;
        try
        {
            deck = await resolveDeckForUpdate(args.deckId);
        }
        catch (error)
        {
            return failure(format, "deck-update", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (deck.kind !== "resolved")
        {
            return failure(
                format,
                "deck-update",
                deck.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                renderLookupMessage(deck, String(args.deckId ?? "")),
            );
        }

        const description = shouldClearDescription ? "" : String(args.description ?? "");
        facts = { targetId: deck.id, requested: { description }, updatedFields: ["description"], descriptionCleared: description.length === 0 };
        beforeDispatch = getOperationContext()?.requestsDispatched ?? 0;
        effect = entityEffect("not_dispatched", deck.id);
        try
        {
            await runDispatch("decks/update", {
                id: deck.id,
                description,
            });
        }
        catch (error)
        {
            effect = failedEntityEffect(error, deck.id, beforeDispatch, getOperationContext()?.requestsDispatched ?? 0);
            return failure(format, "deck-update", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        effect = entityEffect("dispatch_returned", deck.id);
        const lines = [
            "## Deck Updated",
            "",
            `- Deck: #${deck.accountSeq ?? "?"} ${deck.label}`,
            `- ID: ${deck.id}`,
            `- Updated Fields: description`,
            `- Description Cleared: ${description.length === 0 ? "Yes" : "No"}`,
        ];

        return success(
            format,
            "deck-update",
            lines.join("\n"),
            {
                deckId: deck.id,
                accountSeq: deck.accountSeq ?? null,
                title: deck.label,
                updatedFields: ["description"],
                description,
                descriptionCleared: description.length === 0,
            },
        );
    });
}

export async function executeMilestoneUpdatePayload(args: Record<string, any>): Promise<CodecksOperationPayload> {
    return withOperationContextIfMissing(async () => {
        let facts: Record<string, unknown> = {};
        let effect = entityEffect("not_dispatched");
        let beforeDispatch = 0;
        const success = (...values: Parameters<typeof toStructuredResult>): CodecksOperationPayload => ({ text: toStructuredResult(...values), payload: entityWriteSuccess("milestone-update", facts, effect) });
        const failure = (...values: Parameters<typeof toStructuredErrorResult>): CodecksOperationPayload => ({ text: toStructuredErrorResult(...values), payload: entityWriteError("milestone-update", values[2], values[3], effect) });
        const format = args.format ?? "text";
        const hasDescription = args.description !== undefined;
        const shouldClearDescription = args.clearDescription === true;
        if (!hasDescription && !shouldClearDescription)
        {
            return failure(format, "milestone-update", "validation_error", "Provide description or set clearDescription=true.");
        }
        if (hasDescription && !shouldClearDescription && typeof args.description !== "string")
        {
            return failure(format, "milestone-update", "validation_error", "description must be a string. Use clearDescription=true or description: \"\" to clear.");
        }

        let milestone: MilestoneLookupResult;
        try
        {
            milestone = await resolveMilestoneForUpdate(args.milestoneId);
        }
        catch (error)
        {
            return failure(format, "milestone-update", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (milestone.kind !== "resolved")
        {
            return failure(
                format,
                "milestone-update",
                milestone.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                renderLookupMessage(milestone, String(args.milestoneId ?? "")),
            );
        }

        const description = shouldClearDescription ? "" : String(args.description ?? "");
        facts = { targetId: milestone.id, requested: { description }, updatedFields: ["description"], descriptionCleared: description.length === 0 };
        beforeDispatch = getOperationContext()?.requestsDispatched ?? 0;
        effect = entityEffect("not_dispatched", milestone.id);
        try
        {
            await runDispatch("milestones/update", {
                id: milestone.id,
                description,
            });
        }
        catch (error)
        {
            effect = failedEntityEffect(error, milestone.id, beforeDispatch, getOperationContext()?.requestsDispatched ?? 0);
            return failure(format, "milestone-update", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const accountSeq = milestone.accountSeq;
        const url = accountSeq !== undefined ? formatMilestoneUrl(accountSeq) : "";
        effect = entityEffect("dispatch_returned", milestone.id);
        const lines = [
            "## Milestone Updated",
            "",
            `- Milestone: #${accountSeq ?? "?"} ${milestone.label}`,
            `- ID: ${milestone.id}`,
            `- URL: ${url || ""}`,
            `- Updated Fields: description`,
            `- Description Cleared: ${description.length === 0 ? "Yes" : "No"}`,
        ];

        return success(
            format,
            "milestone-update",
            lines.join("\n"),
            {
                milestoneId: milestone.id,
                accountSeq: accountSeq ?? null,
                name: milestone.label,
                url: url || null,
                updatedFields: ["description"],
                description,
                descriptionCleared: description.length === 0,
            },
        );
    });
}

export async function executeRunUpdatePayload(args: Record<string, any>): Promise<CodecksOperationPayload> {
    return withOperationContextIfMissing(async () => {
        let facts: Record<string, unknown> = {};
        let effect = entityEffect("not_dispatched");
        let beforeDispatch = 0;
        const success = (...values: Parameters<typeof toStructuredResult>): CodecksOperationPayload => ({ text: toStructuredResult(...values), payload: entityWriteSuccess("run-update", facts, effect) });
        const failure = (...values: Parameters<typeof toStructuredErrorResult>): CodecksOperationPayload => ({ text: toStructuredErrorResult(...values), payload: entityWriteError("run-update", values[2], values[3], effect) });
        const format = args.format ?? "text";
        const hasCustomLabel = args.customLabel !== undefined || args.name !== undefined || args.clearCustomLabel === true;
        const hasDescription = args.description !== undefined;
        if (!hasCustomLabel && !hasDescription)
        {
            return failure(format, "run-update", "validation_error", "Provide customLabel/name, clearCustomLabel=true, or description.");
        }

        let run: RunLookupResult | null;
        try
        {
            run = await resolveRunForUpdate(args.runId);
        }
        catch (error)
        {
            return failure(format, "run-update", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (!run)
        {
            return failure(format, "run-update", "not_found", "Run not found.");
        }

        const payload: Record<string, unknown> = {
            sessionId: generateSessionId(),
            id: run.runId,
        };
        if (args.description !== undefined)
        {
            payload.description = args.description;
        }
        if (args.clearCustomLabel === true)
        {
            payload.name = null;
        }
        else if (args.customLabel !== undefined || args.name !== undefined)
        {
            payload.name = args.customLabel ?? args.name ?? null;
        }

        facts = { targetId: run.runId, requested: { ...(hasDescription ? { description: payload.description } : {}), ...(hasCustomLabel ? { name: payload.name } : {}) }, updatedFields: Object.keys(payload).filter(k => !["sessionId", "id"].includes(k)), ...(hasDescription ? { descriptionCleared: payload.description === "" } : {}), ...(hasCustomLabel ? { customLabelCleared: payload.name === null } : {}) };
        beforeDispatch = getOperationContext()?.requestsDispatched ?? 0;
        effect = entityEffect("not_dispatched", run.runId);
        try
        {
            await runDispatch("sprints/updateSprint", payload);
        }
        catch (error)
        {
            effect = failedEntityEffect(error, run.runId, beforeDispatch, getOperationContext()?.requestsDispatched ?? 0);
            return failure(format, "run-update", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const updatedFields = Object.keys(payload).filter((key) => !["sessionId", "id"].includes(key));
        effect = entityEffect("dispatch_returned", run.runId);
        const lines = [
            "## Run Updated",
            "",
            `- Run: #${run.accountSeq ?? "?"} ${run.label}`,
            `- ID: ${run.runId}`,
            `- Updated Fields: ${updatedFields.join(", ")}`,
        ];

        return success(
            format,
            "run-update",
            lines.join("\n"),
            {
                runId: run.runId,
                sprintId: run.runId,
                accountSeq: run.accountSeq ?? null,
                updatedFields,
                customLabel: hasCustomLabel ? (payload.name ?? null) : undefined,
                description: hasDescription ? payload.description : undefined,
            },
        );
    });
}
