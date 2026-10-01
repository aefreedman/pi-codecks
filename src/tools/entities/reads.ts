import { runQuery } from "../../runtime/transport";
import { formatShortCode } from "../../shared/card-reference";
import { extractRelationEntities, getEntityMap } from "../../shared/entity-maps";
import { fetchAccountMilestones, normalizeMilestoneSummary, renderLookupMessage, resolveMilestoneForUpdate } from "../../shared/entity-resolution";
import { blankToUndefined, relationQuery, unwrapData } from "../../shared/query";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { type RunLookupResult, fetchAccountRuns, getRunAccountSeq, getRunDateRange, getRunLabel, normalizeRunSummary, resolveRunForUpdate, runSummaryFields } from "../../shared/runs";
import { outputFormatArg } from "../../pi-tool-compat";
import { type CodecksEntity } from "../../shared/types";
import { formatMilestoneUrl } from "../../shared/urls";
import { tool } from "../../pi-tool-compat";
import { resolveDeckForGet, filterMilestonesBySearch, renderMilestoneListText } from "./helpers";

export const deck_get = tool({
    description: "Fetch one Codecks Deck and its current description by immutable ID, account sequence, or exact visible title.",
    args: {
        deckId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Deck immutable ID, account sequence, or exact visible title."),
        title: tool.schema.string().optional().describe("Alias for deckId when matching an exact visible Deck title."),
        format: tool.schema.enum(["text", "json"]).optional().describe("Output format. Defaults to json."),
    },
    async execute(args)
    {
        const format = args.format ?? "json";
        const lookupValue = blankToUndefined(args.deckId) ?? blankToUndefined(args.title);
        if (lookupValue === undefined)
        {
            return toStructuredErrorResult(format, "deck-get", "validation_error", "Provide deckId, account sequence, or exact title.");
        }
        try
        {
            const result = await resolveDeckForGet(lookupValue);
            if (result.kind !== "resolved")
            {
                return toStructuredErrorResult(format, "deck-get", result.kind === "ambiguous" ? "ambiguous_match" : "not_found", renderLookupMessage(result, String(lookupValue)));
            }
            const deck = result.deck;
            const data = {
                deckId: result.id,
                accountSeq: result.accountSeq ?? null,
                title: result.label,
                description: typeof deck.description === "string" ? deck.description : "",
                isDeleted: deck.isDeleted === true,
                status: typeof deck.status === "string" ? deck.status : null,
            };
            const text = [
                "## Codecks Deck",
                "",
                `- Deck: #${data.accountSeq ?? "?"} ${data.title}`,
                `- ID: ${data.deckId}`,
                `- Deleted: ${data.isDeleted ? "yes" : "no"}`,
                "",
                "Description",
                "-----------",
                data.description || "(empty)",
            ].join("\n");
            return toStructuredResult(format, "deck-get", text, data);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "deck-get", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }
    },
});

export const milestone_list = tool({
    description: "List Codecks Milestones with optional text filtering.",
    args: {
        search: tool.schema.string().optional().describe("Optional text filter for milestone name, description, account sequence, or ID."),
        includeDeleted: tool.schema.boolean().optional().describe("Include deleted milestones. Defaults to false."),
        limit: tool.schema.number().int().min(1).max(500).optional().describe("Maximum milestones to return. Defaults to 100."),
        format: tool.schema.enum(["text", "json"]).optional().describe("Output format. Defaults to json."),
    },
    async execute(args)
    {
        const format = args.format ?? "json";
        const includeDeleted = args.includeDeleted ?? false;
        const limit = args.limit ?? 100;

        try
        {
            const allMilestones = await fetchAccountMilestones();
            const filtered = filterMilestonesBySearch(
                allMilestones.filter((milestone) => includeDeleted || milestone.isDeleted !== true),
                args.search,
            ).slice(0, limit);
            const dataMilestones = filtered
                .map((milestone) => normalizeMilestoneSummary(milestone))
                .filter((milestone): milestone is Record<string, unknown> => milestone !== null);

            return toStructuredResult(
                format,
                "milestone-list",
                renderMilestoneListText(filtered, "Codecks Milestones"),
                {
                    search: args.search ?? null,
                    includeDeleted,
                    limit,
                    total: dataMilestones.length,
                    milestones: dataMilestones,
                },
                undefined,
                dataMilestones.length === 0 ? "Try a different search term, increase the limit, or set includeDeleted=true when looking for archived/deleted milestones." : undefined,
            );
        }
        catch (error)
        {
            const message = toErrorMessage(error);
            return toStructuredErrorResult(format, "milestone-list", classifyApiErrorCategory(message), message, getOperationErrorData(error));
        }
    },
});

export const milestone_get = tool({
    description: "Fetch one Codecks Milestone by ID, account sequence, or name search.",
    args: {
        milestoneId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Milestone ID, account sequence, or name search."),
        title: tool.schema.string().optional().describe("Alias for milestoneId when searching by visible milestone name."),
        includeDeleted: tool.schema.boolean().optional().describe("Allow deleted milestones in lookup results. Defaults to false."),
        format: tool.schema.enum(["text", "json"]).optional().describe("Output format. Defaults to json."),
    },
    async execute(args)
    {
        const format = args.format ?? "json";
        const lookupValue = blankToUndefined(args.milestoneId) ?? blankToUndefined(args.title);
        if (lookupValue === undefined)
        {
            return toStructuredErrorResult(format, "milestone-get", "validation_error", "Provide milestoneId, account sequence, or title.");
        }

        try
        {
            const milestone = await resolveMilestoneForUpdate(lookupValue);
            if (milestone.kind !== "resolved")
            {
                return toStructuredErrorResult(
                    format,
                    "milestone-get",
                    milestone.kind === "ambiguous" ? "ambiguous_match" : "not_found",
                    renderLookupMessage(milestone, String(lookupValue ?? "")),
                );
            }
            if (milestone.milestone.isDeleted === true && args.includeDeleted !== true)
            {
                return toStructuredErrorResult(format, "milestone-get", "not_found", "Matched milestone is deleted. Pass includeDeleted=true to return deleted milestones.");
            }

            const accountSeq = milestone.accountSeq;
            const url = accountSeq !== undefined ? formatMilestoneUrl(accountSeq) : "";
            const text = [
                "## Codecks Milestone",
                "",
                `- Milestone: #${accountSeq ?? "?"} ${milestone.label}`,
                `- ID: ${milestone.id}`,
                ...(url ? [`- URL: ${url}`] : []),
                `- Deleted: ${milestone.milestone.isDeleted === true ? "yes" : "no"}`,
                "",
                "Description:",
                String(milestone.milestone.description ?? ""),
            ].join("\n");

            return toStructuredResult(
                format,
                "milestone-get",
                text,
                {
                    milestone: normalizeMilestoneSummary(milestone.milestone),
                },
            );
        }
        catch (error)
        {
            const message = toErrorMessage(error);
            return toStructuredErrorResult(format, "milestone-get", classifyApiErrorCategory(message), message, getOperationErrorData(error));
        }
    },
});

export const run_list = tool({
    description: "List Codecks Runs (Sprint API model) for the account.",
    args: {
        title: tool.schema.string().optional().describe("Optional partial custom label/date filter."),
        includeDeleted: tool.schema.boolean().optional().describe("Include deleted runs."),
        includeCompleted: tool.schema.boolean().optional().describe("Include completed runs."),
        limit: tool.schema.number().optional().describe("Maximum runs to return."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const limit = Math.max(1, Math.min(500, Math.floor(Number(args.limit ?? 50))));
        let runs: CodecksEntity[];
        try
        {
            runs = await fetchAccountRuns(runSummaryFields);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "run-list", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        const titleFilter = String(args.title ?? "").trim().toLowerCase();
        const filtered = runs
            .filter((run) => args.includeDeleted || !run.isDeleted)
            .filter((run) => args.includeCompleted || !run.completedAt)
            .filter((run) =>
            {
                if (!titleFilter)
                {
                    return true;
                }
                return getRunLabel(run).toLowerCase().includes(titleFilter)
                    || getRunDateRange(run).toLowerCase().includes(titleFilter)
                    || String(getRunAccountSeq(run) ?? "").includes(titleFilter);
            })
            .sort((left, right) => String(right.startDate ?? "").localeCompare(String(left.startDate ?? "")));
        const truncated = filtered.length > limit;
        const selected = filtered.slice(0, limit);
        const summaries = selected.map(normalizeRunSummary);
        const lines = [
            "## Codecks Runs",
            "",
            `- Matches: ${filtered.length}`,
            `- Returned: ${selected.length}`,
            ...(truncated ? [`- Truncated: Yes (limit ${limit})`] : []),
            "",
            ...summaries.map((run) => `- #${run.accountSeq ?? "?"} ${run.label} (${run.startDate ?? "?"} â†’ ${run.endDate ?? "?"})`),
        ];

        return toStructuredResult(
            format,
            "run-list",
            lines.join("\n"),
            {
                matches: filtered.length,
                returned: selected.length,
                truncated,
                runs: summaries,
            },
        );
    },
});

export const run_get = tool({
    description: "Fetch one Codecks Run using the Sprint API model.",
    args: {
        runId: tool.schema.union([tool.schema.string(), tool.schema.number()]).optional().describe("Run/Sprint ID, account sequence, or label search."),
        title: tool.schema.string().optional().describe("Partial custom label/date search if runId is not provided."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        const rawTarget = args.runId ?? args.title;
        if (rawTarget === undefined || String(rawTarget).trim() === "")
        {
            return toStructuredErrorResult(format, "run-get", "validation_error", "Provide runId or title.");
        }

        let run: RunLookupResult | null;
        try
        {
            run = await resolveRunForUpdate(rawTarget);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "run-get", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if (!run)
        {
            return toStructuredErrorResult(format, "run-get", "not_found", "Run not found.", { target: String(rawTarget) });
        }

        const summary = normalizeRunSummary(run.run);
        const cards = extractRelationEntities(run.run, "cards", {});
        const cardSummaries = cards.map((card) => ({
            cardId: card.cardId ?? null,
            shortCode: typeof card.accountSeq === "number" ? formatShortCode(card.accountSeq) : null,
            accountSeq: card.accountSeq ?? null,
            title: card.title ?? null,
            status: card.status ?? null,
        }));
        const lines = [
            "## Codecks Run",
            "",
            `- Run: #${summary.accountSeq ?? "?"} ${summary.label}`,
            `- ID: ${summary.runId ?? ""}`,
            `- Date Range: ${summary.dateRange ?? ""}`,
            `- Custom Label: ${summary.customLabel ?? "(none)"}`,
            `- Description: ${summary.description ?? "(none)"}`,
            `- Cards: ${cardSummaries.length}`,
        ];

        return toStructuredResult(
            format,
            "run-get",
            lines.join("\n"),
            {
                run: {
                    ...summary,
                    cards: cardSummaries,
                },
            },
        );
    },
});

export const user_lookup = tool({
    description: "Lookup Codecks user IDs by name (assignees/creators from recent cards).",
    args: {
        name: tool.schema.string().min(1).describe("User name to search for (partial, case-insensitive)."),
        limit: tool.schema.number().min(1).max(5000).optional().describe("Maximum number of recent cards to scan."),
    },
    async execute(args)
    {
        const queryText = String(args.name ?? "").trim();
        if (!queryText)
        {
            return "Provide a name to search for.";
        }

        const limit = args.limit ?? 200;
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("cards", { $limit: limit, $order: "-lastUpdatedAt" })]: [
                                { assignee: ["id", "name", "fullName"] },
                                { creator: ["id", "name", "fullName"] },
                            ],
                        },
                    ],
                },
            ],
        };

        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const userMap = getEntityMap(data, "user");
        const candidates = Object.values(userMap);
        const normalizedQuery = queryText.toLowerCase();
        const seen = new Set<string>();
        const matches = candidates
            .filter((user) =>
            {
                const name = String(user.name ?? "").toLowerCase();
                const fullName = String(user.fullName ?? "").toLowerCase();
                return name.includes(normalizedQuery) || fullName.includes(normalizedQuery);
            })
            .filter((user) =>
            {
                const idValue = user.id !== undefined ? String(user.id) : "";
                if (!idValue || seen.has(idValue))
                {
                    return false;
                }
                seen.add(idValue);
                return true;
            })
            .sort((left, right) =>
            {
                const leftName = String(left.fullName ?? left.name ?? "");
                const rightName = String(right.fullName ?? right.name ?? "");
                return leftName.localeCompare(rightName);
            });

        if (matches.length === 0)
        {
            return `No users matched "${queryText}" in recent card assignees/creators.`;
        }

        const lines = [
            "## User Lookup",
            "",
            `- Query: ${queryText}`,
            `- Scanned Cards: ${limit}`,
            `- Matches: ${matches.length}`,
            "",
            ...matches.map((user) =>
            {
                const fullName = String(user.fullName ?? "").trim();
                const name = String(user.name ?? "").trim();
                const displayName = fullName || name || "(unknown)";
                const alias = fullName && name && fullName !== name ? ` (name: ${name})` : "";
                const idValue = user.id !== undefined ? String(user.id) : "";
                return `- ${displayName}${alias} (id: ${idValue || "n/a"})`;
            }),
            "",
            "_Results are derived from recent card assignees/creators._",
        ];

        return lines.join("\n");
    },
});
