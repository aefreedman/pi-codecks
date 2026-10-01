import * as fs from "node:fs/promises";
import { tool, outputFormatArg } from "../../pi-tool-compat";
import { getBaseConfig } from "../../runtime/credentials";
import { getActiveWorkspaceRoot } from "../../runtime/operation-context";
import { fetchDoneTransitionEvents, type DoneTransitionEvent } from "../../shared/done-transitions";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { fetchAccountRuns, runSummaryFields } from "../../shared/runs";
import { DEFAULT_OVERLAP_DAYS, atomicWriteFile, assertDistinctPaths, buildVelocityCsv, buildVelocityMarkdown, buildVelocityReport, createDeliveredCardObservation, createRunObservation, isIsoDate, mergeObservationCache, parseVelocityRosterText, resolveWorkspacePath, validateObservationCache, type ObservationCache } from "../../velocity-observations";
import { fetchDeliveredEffortEntries, summarizeDeliveredEntries } from "./helpers";

export const velocity_observations_update = tool({
    description: "Update a caller-owned factual Codecks velocity observation cache without calculating statistics.",
    args: {
        observationsPath: tool.schema.string().describe("Caller-owned JSON cache path inside the active workspace."),
        refreshMode: tool.schema.enum(["incremental", "date_window", "full"]).optional().describe("Defaults to incremental; a missing cache uses full refresh."),
        fromDate: tool.schema.string().optional().describe("YYYY-MM-DD lower bound. Required for date_window."),
        toDate: tool.schema.string().optional().describe("YYYY-MM-DD upper bound. Defaults to today."),
        overlapDays: tool.schema.number().min(0).max(365).optional().describe("Incremental overlap; defaults to 10 days."),
        scanLimit: tool.schema.number().min(50).max(10000).optional().describe("Maximum activities scanned."),
        pageSize: tool.schema.number().min(25).max(500).optional().describe("Activities per request."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        if (typeof args.observationsPath !== "string" || !args.observationsPath.trim()) return toStructuredErrorResult(format, "velocity-observations-update", "validation_error", "observationsPath is required.");
        const requestedMode = String(args.refreshMode ?? "incremental");
        if (!["incremental", "date_window", "full"].includes(requestedMode)) return toStructuredErrorResult(format, "velocity-observations-update", "validation_error", "refreshMode must be incremental, date_window, or full.");
        if (args.fromDate !== undefined && !isIsoDate(args.fromDate)) return toStructuredErrorResult(format, "velocity-observations-update", "validation_error", "fromDate must be a real date in YYYY-MM-DD format.");
        if (args.toDate !== undefined && !isIsoDate(args.toDate)) return toStructuredErrorResult(format, "velocity-observations-update", "validation_error", "toDate must be a real date in YYYY-MM-DD format.");
        if (requestedMode === "date_window" && args.fromDate === undefined) return toStructuredErrorResult(format, "velocity-observations-update", "validation_error", "fromDate is required for date_window refresh mode.");

        try
        {
            const config = getBaseConfig();
            const path = await resolveWorkspacePath(getActiveWorkspaceRoot(), args.observationsPath, "output");
            let existing: ObservationCache | undefined;
            try {
                existing = validateObservationCache(JSON.parse(await fs.readFile(path, "utf8")), config.account, config.baseUrl);
                if ((existing.organization as typeof existing.organization & { profile?: string }).profile !== config.profileKey) throw new Error("Observation cache profile differs or has no profile provenance; use a separate cache path.");
            }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            // Effective visibility can change without token rotation: never merge stale rows.
            if (existing && requestedMode !== "full") throw new Error("Incremental observation cache reuse cannot verify unchanged project visibility; use a full refresh.");
            const mode: "full" | "incremental" | "date_window" = "full";
            const overlapDays = Math.max(0, Math.min(365, Math.floor(Number(args.overlapDays ?? DEFAULT_OVERLAP_DAYS))));
            const to = typeof args.toDate === "string" ? args.toDate : new Date().toISOString().slice(0, 10);
            const allRuns = await fetchAccountRuns(runSummaryFields);
            const completedRuns = allRuns.filter((run) => !run.isDeleted && Boolean(run.completedAt));
            const earliestRunStart = completedRuns.map((run) => String(run.startDate ?? "")).filter(isIsoDate).sort()[0];
            const from = typeof args.fromDate === "string" ? args.fromDate : earliestRunStart ?? to;
            if (from > to) return toStructuredErrorResult(format, "velocity-observations-update", "validation_error", "fromDate must not be after toDate.");

            const runObservations = completedRuns
                .filter((run) => { const completed = String(run.completedAt ?? "").slice(0, 10); return completed >= from && completed <= to; })
                .map((run) => createRunObservation(run));
            const scanLimit = Math.max(50, Math.min(10000, Math.floor(Number(args.scanLimit ?? 10000))));
            const pageSize = Math.max(25, Math.min(500, Math.floor(Number(args.pageSize ?? 250))));
            const fetched = await fetchDoneTransitionEvents({ sinceIso: `${from}T00:00:00.000Z`, until: new Date(`${to}T23:59:59.999Z`), scanLimit, pageSize });
            const latestByCard = new Map<string, DoneTransitionEvent>();
            for (const event of fetched.events) if (!latestByCard.has(event.cardId)) latestByCard.set(event.cardId, event);
            const cardObservations = [...latestByCard.values()].map((event) => createDeliveredCardObservation(event as unknown as Record<string, unknown>));
            const cache = mergeObservationCache({
                existing: undefined, account: config.account, baseUrl: config.baseUrl, now: new Date().toISOString(), mode, overlapDays, from, to,
                runs: runObservations, cards: cardObservations, scannedActivities: fetched.scannedActivities, scanLimit, scanLimitReached: fetched.scanLimitReached,
                warnings: completedRuns.some((run) => !isIsoDate(run.startDate) || !isIsoDate(run.endDate) || String(run.startDate) > String(run.endDate)) ? ["Completed Runs with missing, malformed, or reversed dates were preserved; unusable report periods remain unavailable."] : [],
            });
            (cache.organization as typeof cache.organization & { profile: string }).profile = config.profileKey;
            cache.refresh.warnings.push("Complete only within this token's visible projects; effective project permissions are not verifiable from this API snapshot.");
            await atomicWriteFile(path, `${JSON.stringify(cache, null, 2)}\n`, getActiveWorkspaceRoot());
            const lines = ["## Codecks Velocity Observation Cache Updated", "", `- Organization: ${config.account}`, `- Cache: ${path}`, `- Refresh: ${mode} (${from} to ${to}; overlap ${overlapDays} days)`, `- Run observations: ${runObservations.length}`, `- Delivered-card observations: ${cardObservations.length}`, `- Complete: ${cache.refresh.complete ? "yes" : "no"}`];
            return toStructuredResult(format, "velocity-observations-update", lines.join("\n"), { observationsPath: path, cache }, cache.refresh.warnings);
        }
        catch (error)
        {
            const message = toErrorMessage(error);
            const category = /workspace|path|file|cache|schema|organization/i.test(message) ? "file_error" : classifyApiErrorCategory(message);
            return toStructuredErrorResult(format, "velocity-observations-update", category, message);
        }
    },
});

export const velocity_report = tool({
    description: "Build a provenance-rich velocity report from an observation cache without querying Codecks.",
    args: {
        observationsPath: tool.schema.string().describe("Existing JSON observation cache path inside the workspace."),
        preset: tool.schema.enum(["standard_velocity", "none"]).optional().describe("Named, manifest-expanded preset."),
        measure: tool.schema.enum(["calendar_delivered", "run_attributed"]).optional().describe("Defaults to calendar_delivered."),
        sprintConfig: tool.schema.string().optional().describe("Exact configuration id or unambiguous exact name."),
        excludeDecks: tool.schema.array(tool.schema.string()).optional().describe("Stable deck ids or unambiguous exact deck titles to exclude from calendar-delivered reports."),
        user: tool.schema.string().optional().describe("Single-subject display name."),
        userId: tool.schema.string().optional().describe("Exact single-subject user id."),
        rosterPath: tool.schema.string().optional().describe("Optional separate JSON/simple-YAML roster."),
        team: tool.schema.string().optional().describe("Optional exact roster team."),
        fromDate: tool.schema.string().optional().describe("YYYY-MM-DD report lower bound."),
        toDate: tool.schema.string().optional().describe("YYYY-MM-DD report upper bound."),
        excludeLabels: tool.schema.array(tool.schema.string()).optional().describe("Replacement Run-label exclusions; [] disables defaults."),
        additionalExcludeLabels: tool.schema.array(tool.schema.string()).optional().describe("Additional Run-label exclusions."),
        dateExclusions: tool.schema.array(tool.schema.any()).optional().describe("Explicit organization/team/person date exclusions."),
        gapPolicy: tool.schema.enum(["include_zero", "show_exclude_from_statistics", "omit"]).optional().describe("Complete-gap policy."),
        partialPeriodPolicy: tool.schema.enum(["show_exclude", "include"]).optional().describe("Partial-boundary statistics policy."),
        biweekly: tool.schema.boolean().optional().describe("Include fixed biweekly periods."),
        biweeklyAnchor: tool.schema.string().optional().describe("Monday anchor; defaults to 1970-01-05."),
        csvPath: tool.schema.string().optional().describe("Independent CSV destination."),
        summaryMarkdownPath: tool.schema.string().optional().describe("Independent Markdown destination."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        if (typeof args.observationsPath !== "string" || !args.observationsPath.trim()) return toStructuredErrorResult(format, "velocity-report", "validation_error", "observationsPath is required; update it first with codecks_velocity_observations_update.");
        try
        {
            const workspace = getActiveWorkspaceRoot();
            const observationsPath = await resolveWorkspacePath(workspace, args.observationsPath, "input");
            const rosterPath = typeof args.rosterPath === "string" && args.rosterPath.trim() ? await resolveWorkspacePath(workspace, args.rosterPath, "input") : undefined;
            const csvPath = typeof args.csvPath === "string" && args.csvPath.trim() ? await resolveWorkspacePath(workspace, args.csvPath, "output") : undefined;
            const summaryMarkdownPath = typeof args.summaryMarkdownPath === "string" && args.summaryMarkdownPath.trim() ? await resolveWorkspacePath(workspace, args.summaryMarkdownPath, "output") : undefined;
            assertDistinctPaths([{ label: "observationsPath", path: observationsPath }, { label: "rosterPath", path: rosterPath }, { label: "csvPath", path: csvPath }, { label: "summaryMarkdownPath", path: summaryMarkdownPath }]);
            const config = getBaseConfig();
            const cache = validateObservationCache(JSON.parse(await fs.readFile(observationsPath, "utf8")), config.account, config.baseUrl);
            if ((cache.organization as typeof cache.organization & { profile?: string }).profile !== config.profileKey) throw new Error("Observation cache profile does not match the selected Codecks profile.");
            const roster = rosterPath ? parseVelocityRosterText(await fs.readFile(rosterPath, "utf8")) : undefined;
            const report = buildVelocityReport(cache, { ...args, roster });
            const outputs: Record<string, string> = {};
            if (csvPath) { await atomicWriteFile(csvPath, buildVelocityCsv(report, cache), workspace); outputs.csvPath = csvPath; }
            if (summaryMarkdownPath) { await atomicWriteFile(summaryMarkdownPath, buildVelocityMarkdown(report), workspace); outputs.summaryMarkdownPath = summaryMarkdownPath; }
            report.outputs = outputs;
            const lines = ["## Codecks Velocity Report", "", `- Observation cache: ${observationsPath}`, `- Measure: ${report.measure}`, `- Preset: ${report.preset} (${report.transformations.length} manifest entries)`, `- Date range: ${report.dateWindow.from} to ${report.dateWindow.to}`, `- Subjects: ${report.subjects.map((subject) => subject.name).join(", ")}`, `- CSV: ${outputs.csvPath ?? "not requested"}`, `- Markdown: ${outputs.summaryMarkdownPath ?? "not requested"}`, "", "| Subject | Sample weeks | Mean | P25 | P50 | P75 | Missing-data periods |", "|---|---:|---:|---:|---:|---:|---:|", ...report.subjects.map((subject) => `| ${subject.name.replaceAll("|", "\\|")} | ${subject.summary.sampleWeeks} | ${subject.summary.mean ?? "N/A"} | ${subject.summary.p25 ?? "N/A"} | ${subject.summary.p50 ?? "N/A"} | ${subject.summary.p75 ?? "N/A"} | ${subject.composition.missingData} |`)];
            return toStructuredResult(format, "velocity-report", lines.join("\n"), report, report.warnings);
        }
        catch (error)
        {
            const message = toErrorMessage(error);
            const category = /configuration.*ambiguous/i.test(message) ? "ambiguous_match" : /path|file|cache|workspace|schema/i.test(message) ? "file_error" : "validation_error";
            return toStructuredErrorResult(format, "velocity-report", category, message);
        }
    },
});

export const run_delivered_effort = tool({
    description: "Report delivered effort from cached Codecks Run/Sprint finishStats without querying every card.",
    args: {
        sprintConfig: tool.schema.string().optional().describe("Optional Run/Sprint config name/id filter, for example 'dive'."),
        user: tool.schema.string().optional().describe("Optional user name to resolve from recent card assignees/creators. Use 'me' for the logged-in user."),
        userId: tool.schema.string().optional().describe("Optional exact Codecks user id. Preferred over user name when known."),
        completedRuns: tool.schema.number().optional().describe("Number of completed runs to inspect. Defaults to 4."),
        limit: tool.schema.number().optional().describe("Alias for completedRuns."),
        includeCurrentStats: tool.schema.boolean().optional().describe("Also include current live stats for comparison. Defaults to false."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        let result: Awaited<ReturnType<typeof fetchDeliveredEffortEntries>>;
        try
        {
            result = await fetchDeliveredEffortEntries(args);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "run-delivered-effort", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if ("error" in result)
        {
            return toStructuredErrorResult(format, "run-delivered-effort", result.candidates ? "ambiguous_match" : "not_found", result.error, {
                candidates: result.candidates,
            });
        }

        const total = summarizeDeliveredEntries(result.entries);
        const scope = result.userId ? `User: ${result.userLabel ?? result.userId}` : "Whole run";
        const sprintConfig = String(args.sprintConfig ?? "").trim() || "any";
        const lines = [
            "## Run Delivered Effort",
            "",
            `- Scope: ${scope}`,
            `- Sprint Config: ${sprintConfig}`,
            `- Completed Runs Requested: ${result.completedRuns}`,
            `- Completed Runs Matched: ${result.totalMatchedCompletedRuns}`,
            `- Runs Returned: ${result.entries.length}`,
            `- Total Delivered Effort: ${total.effort}`,
            `- Total Done Cards: ${total.count}`,
            `- Total No-effort Done Cards: ${total.noEffort}`,
            "",
            "| Run | Label | Dates | Done Cards | Delivered Effort | No-effort Done |",
            "|---:|---|---|---:|---:|---:|",
            ...result.entries.map((entry) => `| ${entry.accountSeq ?? "?"} | ${entry.label} | ${entry.dateRange ?? "?"} | ${entry.delivered.count} | ${entry.delivered.effort} | ${entry.delivered.noEffort} |`),
        ];

        return toStructuredResult(
            format,
            "run-delivered-effort",
            lines.join("\n"),
            {
                scope: result.userId ? "user" : "run",
                userId: result.userId ?? null,
                userLabel: result.userLabel ?? null,
                sprintConfig,
                completedRuns: result.completedRuns,
                matchedCompletedRuns: result.totalMatchedCompletedRuns,
                returned: result.entries.length,
                totals: total,
                runs: result.entries,
            },
            result.warnings,
        );
    },
});

export const run_average_effort = tool({
    description: "Average cached delivered effort across completed Codecks Runs, with optional low-effort run filtering.",
    args: {
        sprintConfig: tool.schema.string().optional().describe("Optional Run/Sprint config name/id filter, for example 'dive'."),
        user: tool.schema.string().optional().describe("Optional user name to resolve from recent card assignees/creators. Use 'me' for the logged-in user."),
        userId: tool.schema.string().optional().describe("Optional exact Codecks user id. Preferred over user name when known."),
        completedRuns: tool.schema.number().optional().describe("Number of completed runs to inspect before threshold filtering. Defaults to 4."),
        limit: tool.schema.number().optional().describe("Alias for completedRuns."),
        minDeliveredEffort: tool.schema.number().optional().describe("Exclude runs with delivered effort below this value. Defaults to 1."),
        excludeBelowEffort: tool.schema.number().optional().describe("Alias for minDeliveredEffort."),
        includeFilteredRuns: tool.schema.boolean().optional().describe("Include filtered-out runs in the structured result. Defaults to true."),
        format: outputFormatArg,
    },
    async execute(args)
    {
        const format = args.format ?? "text";
        let result: Awaited<ReturnType<typeof fetchDeliveredEffortEntries>>;
        try
        {
            result = await fetchDeliveredEffortEntries(args);
        }
        catch (error)
        {
            return toStructuredErrorResult(format, "run-average-effort", classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
        }

        if ("error" in result)
        {
            return toStructuredErrorResult(format, "run-average-effort", result.candidates ? "ambiguous_match" : "not_found", result.error, {
                candidates: result.candidates,
            });
        }

        const threshold = Number(args.minDeliveredEffort ?? args.excludeBelowEffort ?? 1);
        const minDeliveredEffort = Number.isFinite(threshold) ? threshold : 1;
        const included = result.entries.filter((entry) => entry.delivered.effort >= minDeliveredEffort);
        const filtered = result.entries.filter((entry) => entry.delivered.effort < minDeliveredEffort);
        const totals = summarizeDeliveredEntries(included);
        const averageEffort = included.length > 0 ? totals.effort / included.length : 0;
        const averageDoneCards = included.length > 0 ? totals.count / included.length : 0;
        const scope = result.userId ? `User: ${result.userLabel ?? result.userId}` : "Whole run";
        const sprintConfig = String(args.sprintConfig ?? "").trim() || "any";
        const lines = [
            "## Run Average Effort",
            "",
            `- Scope: ${scope}`,
            `- Sprint Config: ${sprintConfig}`,
            `- Completed Runs Considered: ${result.entries.length}`,
            `- Minimum Delivered Effort: ${minDeliveredEffort}`,
            `- Runs Included: ${included.length}`,
            `- Runs Filtered Out: ${filtered.length}`,
            `- Average Delivered Effort: ${averageEffort}`,
            `- Total Delivered Effort: ${totals.effort}`,
            "",
            "| Run | Label | Dates | Delivered Effort | Included |",
            "|---:|---|---|---:|---|",
            ...result.entries.map((entry) => `| ${entry.accountSeq ?? "?"} | ${entry.label} | ${entry.dateRange ?? "?"} | ${entry.delivered.effort} | ${entry.delivered.effort >= minDeliveredEffort ? "yes" : "no"} |`),
        ];
        const includeFilteredRuns = args.includeFilteredRuns !== false;

        return toStructuredResult(
            format,
            "run-average-effort",
            lines.join("\n"),
            {
                scope: result.userId ? "user" : "run",
                userId: result.userId ?? null,
                userLabel: result.userLabel ?? null,
                sprintConfig,
                completedRuns: result.completedRuns,
                matchedCompletedRuns: result.totalMatchedCompletedRuns,
                consideredRuns: result.entries.length,
                minDeliveredEffort,
                includedRuns: included,
                ...(includeFilteredRuns ? { filteredRuns: filtered } : {}),
                filteredRunCount: filtered.length,
                totals,
                averageEffort,
                averageDoneCards,
            },
            result.warnings,
        );
    },
});
