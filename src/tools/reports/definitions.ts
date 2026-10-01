import { Type } from "typebox";
import type { CodecksToolDefinition } from "../../pi/tool-definition";
import { outputFormatEnum, normalizeArgs, normalizeOutputFormatAlias, applyRunStatsAliases } from "../../pi/input-primitives";
import { velocity_observations_update, velocity_report, run_delivered_effort, run_average_effort } from "./tools";

export const REPORT_TOOL_DEFINITIONS: readonly CodecksToolDefinition[] = [
  { exportName: "velocity_observations_update", tool: velocity_observations_update, config: {
    parameters: Type.Object({
      observationsPath: Type.String({ minLength: 1, description: "Caller-owned JSON cache path inside the active workspace." }),
      refreshMode: Type.Optional(Type.Union([Type.Literal("incremental"), Type.Literal("date_window"), Type.Literal("full")])),
      fromDate: Type.Optional(Type.String()),
      toDate: Type.Optional(Type.String()),
      overlapDays: Type.Optional(Type.Number({ minimum: 0, maximum: 365 })),
      scanLimit: Type.Optional(Type.Number({ minimum: 50, maximum: 10000 })),
      pageSize: Type.Optional(Type.Number({ minimum: 25, maximum: 500 })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.observations_path !== undefined && input.observationsPath === undefined) input.observationsPath = input.observations_path;
      if (input.refresh_mode !== undefined && input.refreshMode === undefined) input.refreshMode = input.refresh_mode;
      if (input.from_date !== undefined && input.fromDate === undefined) input.fromDate = input.from_date;
      if (input.to_date !== undefined && input.toDate === undefined) input.toDate = input.to_date;
      if (input.overlap_days !== undefined && input.overlapDays === undefined) input.overlapDays = input.overlap_days;
      if (input.scan_limit !== undefined && input.scanLimit === undefined) input.scanLimit = input.scan_limit;
      if (input.page_size !== undefined && input.pageSize === undefined) input.pageSize = input.page_size;
      return input;
    },
    promptSnippet: "Update a reusable factual Codecks velocity observation cache.",
    promptGuidelines: [
      "Use codecks_velocity_observations_update once before one or more codecks_velocity_report calls; it updates factual Run and delivered-card observations without applying analytical policy.",
      "Keep observationsPath caller-owned and inside the active workspace; incremental refresh uses a 10-day overlap by default.",
    ],
  } },
  { exportName: "velocity_report", tool: velocity_report, config: {
    parameters: Type.Object({
      observationsPath: Type.String({ minLength: 1, description: "Existing caller-owned observation cache path." }),
      preset: Type.Optional(Type.Union([Type.Literal("standard_velocity"), Type.Literal("none")])),
      measure: Type.Optional(Type.Union([Type.Literal("calendar_delivered"), Type.Literal("run_attributed")])),
      sprintConfig: Type.Optional(Type.String({ description: "Exact stable configuration id or unambiguous exact name." })),
      excludeDecks: Type.Optional(Type.Array(Type.String({ minLength: 1, description: "Stable deck id or unambiguous exact title to exclude from calendar-delivered reports." }))),
      user: Type.Optional(Type.String()),
      userId: Type.Optional(Type.String()),
      rosterPath: Type.Optional(Type.String()),
      team: Type.Optional(Type.String()),
      fromDate: Type.Optional(Type.String()),
      toDate: Type.Optional(Type.String()),
      excludeLabels: Type.Optional(Type.Array(Type.String())),
      additionalExcludeLabels: Type.Optional(Type.Array(Type.String())),
      dateExclusions: Type.Optional(Type.Array(Type.Any())),
      gapPolicy: Type.Optional(Type.Union([Type.Literal("include_zero"), Type.Literal("show_exclude_from_statistics"), Type.Literal("omit")])),
      partialPeriodPolicy: Type.Optional(Type.Union([Type.Literal("show_exclude"), Type.Literal("include")])),
      biweekly: Type.Optional(Type.Boolean()),
      biweeklyAnchor: Type.Optional(Type.String()),
      csvPath: Type.Optional(Type.String()),
      summaryMarkdownPath: Type.Optional(Type.String()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyRunStatsAliases(input);
      for (const [legacy, current] of [["observations_path", "observationsPath"], ["exclude_decks", "excludeDecks"], ["roster_path", "rosterPath"], ["from_date", "fromDate"], ["to_date", "toDate"], ["exclude_labels", "excludeLabels"], ["additional_exclude_labels", "additionalExcludeLabels"], ["date_exclusions", "dateExclusions"], ["gap_policy", "gapPolicy"], ["partial_period_policy", "partialPeriodPolicy"], ["biweekly_anchor", "biweeklyAnchor"], ["csv_path", "csvPath"], ["summary_markdown_path", "summaryMarkdownPath"]] as const) {
        if (input[legacy] !== undefined && input[current] === undefined) input[current] = input[legacy];
      }
      return input;
    },
    promptSnippet: "Build a provenance-rich velocity report from a reusable observation cache.",
    promptGuidelines: [
      "Call codecks_velocity_report only with an observationsPath previously updated by codecks_velocity_observations_update; report generation makes no Codecks requests.",
      "Use calendar_delivered for standard capacity reporting, and run_attributed only for Run snapshot attribution; inspect the expanded transformation manifest and missing-effort coverage.",
      "Use exact configuration ids when names are ambiguous. Mixed configurations are allowed within one organization and retain provenance.",
      "Use excludeDecks with stable ids or unambiguous exact titles to remove test/non-production cards from calendar-delivered reports; it is not valid for Run-attributed snapshots.",
      "csvPath and summaryMarkdownPath are independent workspace-contained outputs.",
    ],
  } },
  { exportName: "run_delivered_effort", tool: run_delivered_effort, config: {
    parameters: Type.Object({
      sprintConfig: Type.Optional(Type.String({ description: "Optional Run/Sprint config name/id filter, for example 'dive'." })),
      user: Type.Optional(Type.String({ description: "Optional user name to resolve from recent card assignees/creators. Use 'me' for the logged-in user." })),
      userId: Type.Optional(Type.String({ description: "Optional exact Codecks user id." })),
      completedRuns: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      includeCurrentStats: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyRunStatsAliases(input);
      return input;
    },
    promptSnippet: "Report cached delivered effort from Codecks Runs without querying every card.",
    promptGuidelines: [
      "Use Run-facing language for users; Codecks API fields use sprint/sprints internally.",
      "For completed Runs, this tool uses stats.finishStats instead of card-by-card recalculation.",
      "Use userId when known; user name lookup is derived from recent card assignees/creators.",
    ],
  } },
  { exportName: "run_average_effort", tool: run_average_effort, config: {
    parameters: Type.Object({
      sprintConfig: Type.Optional(Type.String({ description: "Optional Run/Sprint config name/id filter, for example 'dive'." })),
      user: Type.Optional(Type.String({ description: "Optional user name to resolve from recent card assignees/creators. Use 'me' for the logged-in user." })),
      userId: Type.Optional(Type.String({ description: "Optional exact Codecks user id." })),
      completedRuns: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      minDeliveredEffort: Type.Optional(Type.Number({ description: "Exclude runs with delivered effort below this value. Defaults to 1." })),
      excludeBelowEffort: Type.Optional(Type.Number({ description: "Alias for minDeliveredEffort." })),
      includeFilteredRuns: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyRunStatsAliases(input);
      if (input.min_delivered_effort !== undefined && input.minDeliveredEffort === undefined) input.minDeliveredEffort = input.min_delivered_effort;
      if (input.exclude_below_effort !== undefined && input.excludeBelowEffort === undefined) input.excludeBelowEffort = input.exclude_below_effort;
      if (input.effort_threshold !== undefined && input.minDeliveredEffort === undefined) input.minDeliveredEffort = input.effort_threshold;
      if (input.threshold !== undefined && input.minDeliveredEffort === undefined) input.minDeliveredEffort = input.threshold;
      if (input.include_filtered_runs !== undefined && input.includeFilteredRuns === undefined) input.includeFilteredRuns = input.include_filtered_runs;
      return input;
    },
    promptSnippet: "Average cached delivered effort across completed Codecks Runs, optionally filtering low-effort runs.",
    promptGuidelines: [
      "Use Run-facing language for users; Codecks API fields use sprint/sprints internally.",
      "This tool uses cached Run finishStats and does not query every card for effort math.",
      "minDeliveredEffort defaults to 1, which filters out zero-effort vacation/break Runs by default.",
    ],
  } },
];
