import { Type } from "typebox";
import type { CodecksToolDefinition } from "../../pi/tool-definition";
import { outputFormatEnum, cardRefSchema, normalizeArgs, normalizeOutputFormatAlias, applyRunIdAliases, applyDeckIdAliases, applyMilestoneIdAliases } from "../../pi/input-primitives";
import { deck_get, milestone_list, milestone_get, run_list, run_get, user_lookup } from "./reads";
import { deck_update, milestone_update, run_update } from "./writes";

export const ENTITY_TOOL_DEFINITIONS: readonly CodecksToolDefinition[] = [
  { exportName: "deck_get", tool: deck_get, config: {
    parameters: Type.Object({
      deckId: Type.Optional(cardRefSchema),
      title: Type.Optional(Type.String({ description: "Exact visible Deck title." })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyDeckIdAliases(input);
      if (input.name !== undefined && input.title === undefined) input.title = input.name;
      return input;
    },
    promptSnippet: "Fetch one Codecks Deck and its current description.",
    promptGuidelines: [
      "Use codecks_deck_get to inspect a Deck description before editing; use codecks_deck_update only for an explicit description change.",
      "Numeric deckId values are deck account sequences, not card short codes. Titles must be exact visible titles.",
    ],
  } },
  { exportName: "deck_update", tool: deck_update, config: {
    parameters: Type.Object({
      deckId: cardRefSchema,
      description: Type.Optional(Type.String({ description: "Deck description. Use an empty string to clear." })),
      clearDescription: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyDeckIdAliases(input);
      if (input.clear_description !== undefined && input.clearDescription === undefined) input.clearDescription = input.clear_description;
      return input;
    },
    promptSnippet: "Update a Codecks deck description.",
    promptGuidelines: [
      "Use this tool to edit deck descriptions instead of raw dispatch.",
      "Numeric deckId values are deck account sequences, not card short codes.",
      "Deck descriptions map to decks/update description.",
      "Set clearDescription=true, or pass description as an empty string, to clear a deck description.",
    ],
  } },
  { exportName: "milestone_list", tool: milestone_list, config: {
    parameters: Type.Object({
      search: Type.Optional(Type.String({ description: "Optional text filter for milestone name, description, account sequence, or ID." })),
      includeDeleted: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.include_deleted !== undefined && input.includeDeleted === undefined) input.includeDeleted = input.include_deleted;
      return input;
    },
    promptSnippet: "List Codecks Milestones with optional text filtering.",
    promptGuidelines: [
      "Use codecks_milestone_list for milestone context instead of raw Codecks milestone queries.",
      "Use search for visible milestone names like Alpha; no-match results are successful empty lists.",
      "Use codecks_milestone_get when exactly one milestone must be inspected before editing or planning.",
    ],
  } },
  { exportName: "milestone_get", tool: milestone_get, config: {
    parameters: Type.Object({
      milestoneId: Type.Optional(cardRefSchema),
      title: Type.Optional(Type.String({ description: "Alias for milestoneId when searching by visible milestone name." })),
      includeDeleted: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.milestone_id !== undefined && input.milestoneId === undefined) input.milestoneId = input.milestone_id;
      if (input.milestone !== undefined && input.milestoneId === undefined) input.milestoneId = input.milestone;
      if (input.name !== undefined && input.title === undefined) input.title = input.name;
      if (input.include_deleted !== undefined && input.includeDeleted === undefined) input.includeDeleted = input.include_deleted;
      return input;
    },
    promptSnippet: "Fetch one Codecks Milestone by ID, account sequence, or name search.",
    promptGuidelines: [
      "Use codecks_milestone_get for milestone context and descriptions; avoid raw codecks_query milestone lookups.",
      "Numeric milestoneId values are milestone account sequences, not card short codes.",
      "Use codecks_milestone_update only when the user explicitly wants to edit a milestone description.",
    ],
  } },
  { exportName: "milestone_update", tool: milestone_update, config: {
    parameters: Type.Object({
      milestoneId: cardRefSchema,
      description: Type.Optional(Type.String({ description: "Milestone description. Use an empty string to clear." })),
      clearDescription: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyMilestoneIdAliases(input);
      if (input.clear_description !== undefined && input.clearDescription === undefined) input.clearDescription = input.clear_description;
      return input;
    },
    promptSnippet: "Update a Codecks Milestone description.",
    promptGuidelines: [
      "Use this tool to edit milestone descriptions instead of raw dispatch.",
      "Milestone descriptions map to milestones/update description.",
      "Set clearDescription=true, or pass description as an empty string, to clear a milestone description.",
    ],
  } },
  { exportName: "run_list", tool: run_list, config: {
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Optional partial custom label/date filter." })),
      includeDeleted: Type.Optional(Type.Boolean()),
      includeCompleted: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.include_deleted !== undefined && input.includeDeleted === undefined) input.includeDeleted = input.include_deleted;
      if (input.include_completed !== undefined && input.includeCompleted === undefined) input.includeCompleted = input.include_completed;
      return input;
    },
    promptSnippet: "List Codecks Runs using the underlying Sprint API model.",
    promptGuidelines: [
      "Use Run-facing language for users; Codecks API fields and dispatch paths use sprint/sprints internally.",
      "Use codecks_run_get when a specific run must be inspected before mutation.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  } },
  { exportName: "run_get", tool: run_get, config: {
    parameters: Type.Object({
      runId: Type.Optional(cardRefSchema),
      title: Type.Optional(Type.String({ description: "Partial custom label/date search if runId is not provided." })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyRunIdAliases(input);
      return input;
    },
    promptSnippet: "Fetch one Codecks Run using the underlying Sprint API model.",
    promptGuidelines: [
      "Use Run-facing language for users; Codecks API fields and dispatch paths use sprint/sprints internally.",
      "Numeric runId values refer to the Run/Sprint account sequence, not a card short code.",
    ],
  } },
  { exportName: "run_update", tool: run_update, config: {
    parameters: Type.Object({
      runId: cardRefSchema,
      customLabel: Type.Optional(Type.String({ description: "Run custom label. Maps to sprint.name." })),
      name: Type.Optional(Type.String({ description: "Alias for customLabel. Maps to sprint.name." })),
      clearCustomLabel: Type.Optional(Type.Boolean()),
      description: Type.Optional(Type.String({ description: "Run description. Maps to sprint.description." })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyRunIdAliases(input);
      if (input.custom_label !== undefined && input.customLabel === undefined) input.customLabel = input.custom_label;
      if (input.clear_custom_label !== undefined && input.clearCustomLabel === undefined) input.clearCustomLabel = input.clear_custom_label;
      return input;
    },
    promptSnippet: "Update a Codecks Run custom label or description.",
    promptGuidelines: [
      "Run custom labels map to sprints/updateSprint name; run descriptions map to sprints/updateSprint description.",
      "Set clearCustomLabel=true to clear a custom label instead of guessing an empty-string convention.",
    ],
  } },
  { exportName: "user_lookup", tool: user_lookup, config: {} },
];
