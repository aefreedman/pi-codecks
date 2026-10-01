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
    async execute(args)
    {
        const format = args.format ?? "text";
        const textErrors = validateMutationText([["description", args.description]]);
        if (textErrors.length > 0)
        {
            return toStructuredErrorResult(format, "deck-update", "validation_error", textErrors.join(" "), { indexedErrors: textErrors, requestsAttempted: 0 });
        }
        const hasDescription = args.description !== undefined;
        const shouldClearDescription = args.clearDescription === true;
        if (!hasDescription && !shouldClearDescription)
        {
            return toStructuredErrorResult(format, "deck-update", "validation_error", "Provide description or set clearDescription=true.");
        }
        if (hasDescription && !shouldClearDescription && typeof args.description !== "string")
        {
            return toStructuredErrorResult(format, "deck-update", "validation_error", "description must be a string. Use clearDescription=true or description: \"\" to clear.");
        }

        let deck: DeckLookupResult;
        try
        {
            deck = await resolveDeckForUpdate(args.deckId);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "deck-update", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (deck.kind !== "resolved")
        {
            return toStructuredErrorResult(
                format,
                "deck-update",
                deck.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                renderLookupMessage(deck, String(args.deckId ?? "")),
            );
        }

        const description = shouldClearDescription ? "" : String(args.description ?? "");
        try
        {
            await runDispatch("decks/update", {
                id: deck.id,
                description,
            });
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "deck-update", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const lines = [
            "## Deck Updated",
            "",
            `- Deck: #${deck.accountSeq ?? "?"} ${deck.label}`,
            `- ID: ${deck.id}`,
            `- Updated Fields: description`,
            `- Description Cleared: ${description.length === 0 ? "Yes" : "No"}`,
        ];

        return toStructuredResult(
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
    async execute(args)
    {
        const format = args.format ?? "text";
        const hasDescription = args.description !== undefined;
        const shouldClearDescription = args.clearDescription === true;
        if (!hasDescription && !shouldClearDescription)
        {
            return toStructuredErrorResult(format, "milestone-update", "validation_error", "Provide description or set clearDescription=true.");
        }
        if (hasDescription && !shouldClearDescription && typeof args.description !== "string")
        {
            return toStructuredErrorResult(format, "milestone-update", "validation_error", "description must be a string. Use clearDescription=true or description: \"\" to clear.");
        }

        let milestone: MilestoneLookupResult;
        try
        {
            milestone = await resolveMilestoneForUpdate(args.milestoneId);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "milestone-update", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (milestone.kind !== "resolved")
        {
            return toStructuredErrorResult(
                format,
                "milestone-update",
                milestone.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                renderLookupMessage(milestone, String(args.milestoneId ?? "")),
            );
        }

        const description = shouldClearDescription ? "" : String(args.description ?? "");
        try
        {
            await runDispatch("milestones/update", {
                id: milestone.id,
                description,
            });
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "milestone-update", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const accountSeq = milestone.accountSeq;
        const url = accountSeq !== undefined ? formatMilestoneUrl(accountSeq) : "";
        const lines = [
            "## Milestone Updated",
            "",
            `- Milestone: #${accountSeq ?? "?"} ${milestone.label}`,
            `- ID: ${milestone.id}`,
            `- URL: ${url || ""}`,
            `- Updated Fields: description`,
            `- Description Cleared: ${description.length === 0 ? "Yes" : "No"}`,
        ];

        return toStructuredResult(
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
    async execute(args)
    {
        const format = args.format ?? "text";
        const hasCustomLabel = args.customLabel !== undefined || args.name !== undefined || args.clearCustomLabel === true;
        const hasDescription = args.description !== undefined;
        if (!hasCustomLabel && !hasDescription)
        {
            return toStructuredErrorResult(format, "run-update", "validation_error", "Provide customLabel/name, clearCustomLabel=true, or description.");
        }

        let run: RunLookupResult | null;
        try
        {
            run = await resolveRunForUpdate(args.runId);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "run-update", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (!run)
        {
            return toStructuredErrorResult(format, "run-update", "not_found", "Run not found.");
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

        try
        {
            await runDispatch("sprints/updateSprint", payload);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "run-update", error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const updatedFields = Object.keys(payload).filter((key) => !["sessionId", "id"].includes(key));
        const lines = [
            "## Run Updated",
            "",
            `- Run: #${run.accountSeq ?? "?"} ${run.label}`,
            `- ID: ${run.runId}`,
            `- Updated Fields: ${updatedFields.join(", ")}`,
        ];

        return toStructuredResult(
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
    },
});
