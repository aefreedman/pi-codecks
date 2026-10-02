import { CONVERSATION_READ_SCHEMAS, projectConversationReadOutput } from "./conversations-read-output";
import { CONVERSATION_WRITE_SCHEMAS, projectConversationWriteOutput } from "./conversations-write-output";
import { executeCardAddCommentPayload, executeCardAddReviewPayload, executeCardAddBlockerPayload, executeCardAddBlockPayload, executeCardReplyResolvablePayload, executeCardEditResolvableEntryPayload, executeCardCloseResolvablePayload, executeCardReopenResolvablePayload } from "./writes";
import { executeCardListResolvablesPayload, executeListOpenResolvableCardsPayload, executeListLoggedInUserActionableResolvablesPayload } from "./reads";
import { Type } from "typebox";
import type { CodecksToolDefinition } from "../../pi/tool-definition";
import { outputFormatEnum, cardRefSchema, resolvableContextEnum, conversationContentSchema, resolvableTargetParameters, conversationCreateParameters, CARD_REFERENCE_WRITE_GUIDELINES, COMMENT_THREAD_GUIDELINES, REVIEW_FOLLOWUP_GUIDELINES, RESOLVABLE_REPLY_GUIDELINES, RESOLVABLE_LIST_GUIDELINES, normalizeArgs, normalizeOutputFormatAlias, applyCardIdAliases, applyResolvableIdAliases, applyEntryIdAliases, applyContentAliases } from "../../pi/input-primitives";
import { card_add_comment, card_add_review, card_add_blocker, card_add_block, card_reply_resolvable, card_edit_resolvable_entry, card_close_resolvable, card_reopen_resolvable } from "./writes";
import { card_list_resolvables, list_open_resolvable_cards, list_logged_in_user_actionable_resolvables } from "./reads";
import { debug_logged_in_user_resolvable_participation, debug_logged_in_user_resolvables } from "./diagnostics";

export const CONVERSATION_TOOL_DEFINITIONS: readonly CodecksToolDefinition[] = [
  { exportName: "card_add_comment", tool: card_add_comment, executePayload: executeCardAddCommentPayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_add_comment, projectOutput: payload => projectConversationWriteOutput("card_add_comment", payload), config: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Open a new general comment thread on a Codecks card when explicitly requested.",
    promptGuidelines: COMMENT_THREAD_GUIDELINES,
  } },
  { exportName: "card_add_review", tool: card_add_review, executePayload: executeCardAddReviewPayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_add_review, projectOutput: payload => projectConversationWriteOutput("card_add_review", payload), config: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Open a new review thread on a Codecks card when explicitly requested.",
    promptGuidelines: REVIEW_FOLLOWUP_GUIDELINES,
  } },
  { exportName: "card_add_blocker", tool: card_add_blocker, executePayload: executeCardAddBlockerPayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_add_blocker, projectOutput: payload => projectConversationWriteOutput("card_add_blocker", payload), config: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Open a new blocker thread on a Codecks card.",
    promptGuidelines: CARD_REFERENCE_WRITE_GUIDELINES,
  } },
  { exportName: "card_add_block", tool: card_add_block, executePayload: executeCardAddBlockPayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_add_block, projectOutput: payload => projectConversationWriteOutput("card_add_block", payload), config: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Deprecated alias for codecks_card_add_blocker.",
    promptGuidelines: [
      ...CARD_REFERENCE_WRITE_GUIDELINES,
      "Prefer codecks_card_add_blocker for new blocker threads; codecks_card_add_block is a deprecated alias.",
    ],
  } },
  { exportName: "card_reply_resolvable", tool: card_reply_resolvable, executePayload: executeCardReplyResolvablePayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_reply_resolvable, projectOutput: payload => projectConversationWriteOutput("card_reply_resolvable", payload), config: {
    parameters: Type.Object({
      resolvableId: Type.Optional(cardRefSchema),
      cardId: Type.Optional(cardRefSchema),
      context: Type.Optional(resolvableContextEnum),
      content: conversationContentSchema,
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyResolvableIdAliases(input);
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Reply to an existing Codecks comment, review, or blocker thread.",
    promptGuidelines: RESOLVABLE_REPLY_GUIDELINES,
  } },
  { exportName: "card_edit_resolvable_entry", tool: card_edit_resolvable_entry, executePayload: executeCardEditResolvableEntryPayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_edit_resolvable_entry, projectOutput: payload => projectConversationWriteOutput("card_edit_resolvable_entry", payload), config: {
    parameters: Type.Object({
      entryId: cardRefSchema,
      content: conversationContentSchema,
      expectedVersion: Type.Optional(Type.Number()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyEntryIdAliases(input);
      applyContentAliases(input);
      if (input.expected_version !== undefined && input.expectedVersion === undefined) input.expectedVersion = input.expected_version;
      return input;
    },
    promptSnippet: "Edit an existing Codecks conversation entry authored by the current user.",
    promptGuidelines: CARD_REFERENCE_WRITE_GUIDELINES,
  } },
  { exportName: "card_close_resolvable", tool: card_close_resolvable, executePayload: executeCardCloseResolvablePayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_close_resolvable, projectOutput: payload => projectConversationWriteOutput("card_close_resolvable", payload), config: {
    parameters: Type.Object(resolvableTargetParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyResolvableIdAliases(input);
      applyCardIdAliases(input);
      return input;
    },
    promptSnippet: "Close an existing Codecks comment, review, or blocker thread.",
    promptGuidelines: RESOLVABLE_LIST_GUIDELINES,
  } },
  { exportName: "card_reopen_resolvable", tool: card_reopen_resolvable, executePayload: executeCardReopenResolvablePayload, outputSchema: CONVERSATION_WRITE_SCHEMAS.card_reopen_resolvable, projectOutput: payload => projectConversationWriteOutput("card_reopen_resolvable", payload), config: {
    parameters: Type.Object({
      resolvableId: cardRefSchema,
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyResolvableIdAliases(input);
      return input;
    },
    promptSnippet: "Reopen a closed Codecks comment, review, or blocker thread by resolvableId.",
    promptGuidelines: RESOLVABLE_LIST_GUIDELINES,
  } },
  { exportName: "card_list_resolvables", tool: card_list_resolvables, executePayload: executeCardListResolvablesPayload, outputSchema: CONVERSATION_READ_SCHEMAS.card_list_resolvables, projectOutput: payload => projectConversationReadOutput("card_list_resolvables", payload), config: {
    parameters: Type.Object({
      cardId: cardRefSchema,
      contexts: Type.Optional(Type.Array(Type.String({ description: "Optional list of contexts to include (comment, review, block/blocker)." }))),
      includeClosed: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      if (input.include_closed !== undefined && input.includeClosed === undefined) input.includeClosed = input.include_closed;
      return input;
    },
    promptSnippet: "List Codecks card conversation threads (comments, reviews, blockers).",
    promptGuidelines: RESOLVABLE_LIST_GUIDELINES,
  } },
  { exportName: "list_open_resolvable_cards", tool: list_open_resolvable_cards, executePayload: executeListOpenResolvableCardsPayload, outputSchema: CONVERSATION_READ_SCHEMAS.list_open_resolvable_cards, projectOutput: payload => projectConversationReadOutput("list_open_resolvable_cards", payload), config: {
    parameters: Type.Object({
      contexts: Type.Optional(Type.Array(Type.String({ description: "Optional list of contexts to include (comment, review, block/blocker)." }))),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      scanLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000 })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.scan_limit !== undefined && input.scanLimit === undefined) input.scanLimit = input.scan_limit;
      return input;
    },
    promptSnippet: "List cards across the account that currently have open resolvables, grouped by context.",
    promptGuidelines: [
      "Prefer this tool when the user wants the web-UI-style list of cards that have open resolvables.",
      "This tool is rate-limit-friendly because it scans recent cards in one account-level query and groups results client-side.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  } },
  { exportName: "list_logged_in_user_actionable_resolvables", tool: list_logged_in_user_actionable_resolvables, executePayload: executeListLoggedInUserActionableResolvablesPayload, outputSchema: CONVERSATION_READ_SCHEMAS.list_logged_in_user_actionable_resolvables, projectOutput: payload => projectConversationReadOutput("list_logged_in_user_actionable_resolvables", payload), config: {
    parameters: Type.Object({
      contexts: Type.Optional(Type.Array(Type.String({ description: "Optional list of contexts to include (comment, review, block/blocker)." }))),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
      scanLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      staleAfterHours: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 30 })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.scan_limit !== undefined && input.scanLimit === undefined) input.scanLimit = input.scan_limit;
      if (input.stale_after_hours !== undefined && input.staleAfterHours === undefined) input.staleAfterHours = input.stale_after_hours;
      return input;
    },
    promptSnippet: "List open resolvables that are heuristically attention-worthy for the logged-in user.",
    promptGuidelines: [
      "Use this tool when you want a practical approximation of the logged-in user's attention-worthy resolvable list.",
      "This tool combines latest-activity turn-taking with a stale-thread resurfacing heuristic instead of exact unread/snooze state.",
      "Prefer moderate scan limits to stay comfortably under the 40 requests / 5 seconds API limit.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  } },
  { exportName: "debug_logged_in_user_resolvable_participation", tool: debug_logged_in_user_resolvable_participation, config: {
    parameters: Type.Object({
      scanLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      detailLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      relationProbeLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      staleAfterHours: Type.Optional(Type.Number({ minimum: 1, maximum: 24 * 30 })),
      probeResolvableRelations: Type.Optional(Type.Array(Type.String({ description: "Optional sample resolvable relation names to probe individually." }))),
      probeResolvableFields: Type.Optional(Type.Array(Type.String({ description: "Optional sample resolvable scalar fields to probe individually." }))),
      includePayload: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.scan_limit !== undefined && input.scanLimit === undefined) input.scanLimit = input.scan_limit;
      if (input.detail_limit !== undefined && input.detailLimit === undefined) input.detailLimit = input.detail_limit;
      if (input.relation_probe_limit !== undefined && input.relationProbeLimit === undefined) input.relationProbeLimit = input.relation_probe_limit;
      if (input.stale_after_hours !== undefined && input.staleAfterHours === undefined) input.staleAfterHours = input.stale_after_hours;
      if (input.probe_resolvable_relations !== undefined && input.probeResolvableRelations === undefined) input.probeResolvableRelations = input.probe_resolvable_relations;
      if (input.probe_resolvable_fields !== undefined && input.probeResolvableFields === undefined) input.probeResolvableFields = input.probe_resolvable_fields;
      if (input.include_payload !== undefined && input.includePayload === undefined) input.includePayload = input.include_payload;
      return input;
    },
    promptSnippet: "Probe participant/subscription/opt-out signals for logged-in-user attention-worthy resolvables and estimate bubble states.",
    promptGuidelines: [
      "Use this diagnostic tool when you need to investigate participant, subscription, or opt-out behavior on attention-worthy resolvables.",
      "This tool also emits lightweight bubble-state heuristics such as unread, read, and stale_review.",
      "Prefer small probe lists and moderate scan limits to stay comfortably under the 40 requests / 5 seconds API limit.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  } },
  { exportName: "debug_logged_in_user_resolvables", tool: debug_logged_in_user_resolvables, config: {
    parameters: Type.Object({
      scanLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
      detailLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      relationProbeLimit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      probeRelations: Type.Optional(Type.Array(Type.String({ description: "Optional loggedInUser relation names to probe individually." }))),
      probeFields: Type.Optional(Type.Array(Type.String({ description: "Optional scalar field names to probe individually on a sample resolvable." }))),
      includePayload: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.scan_limit !== undefined && input.scanLimit === undefined) input.scanLimit = input.scan_limit;
      if (input.detail_limit !== undefined && input.detailLimit === undefined) input.detailLimit = input.detail_limit;
      if (input.relation_probe_limit !== undefined && input.relationProbeLimit === undefined) input.relationProbeLimit = input.relation_probe_limit;
      if (input.probe_relations !== undefined && input.probeRelations === undefined) input.probeRelations = input.probe_relations;
      if (input.probe_fields !== undefined && input.probeFields === undefined) input.probeFields = input.probe_fields;
      if (input.include_payload !== undefined && input.includePayload === undefined) input.includePayload = input.include_payload;
      return input;
    },
    promptSnippet: "Probe logged-in-user resolvable inbox state, including likely unread/snooze surfaces and thread metadata.",
    promptGuidelines: [
      "Use this diagnostic tool when you need to reverse-engineer the web UI's per-user resolvable inbox behavior.",
      "Prefer small probe lists and moderate scan limits to stay comfortably under the 40 requests / 5 seconds API limit.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  } },
];
