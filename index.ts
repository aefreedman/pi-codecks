import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as core from "./src/codecks-core";

type CoreTool = {
  description?: string;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
};

type ToolConfig = {
  parameters?: ReturnType<typeof Type.Object>;
  prepareArguments?: (args: unknown) => Record<string, unknown>;
  promptSnippet?: string;
  promptGuidelines?: string[];
};

const ANY_PARAMETERS = Type.Object({}, { additionalProperties: true });
const outputFormatEnum = Type.Union([Type.Literal("text"), Type.Literal("json")]);
const cardRefSchema = Type.Union([Type.String(), Type.Number()]);
const locationEnum = Type.Union([
  Type.Literal("any"),
  Type.Literal("deck"),
  Type.Literal("milestone"),
  Type.Literal("hand"),
  Type.Literal("bookmarks"),
]);
const resolvableContextEnum = Type.Union([
  Type.Literal("comment"),
  Type.Literal("review"),
  Type.Literal("block"),
  Type.Literal("blocker"),
]);
const conversationContentSchema = Type.String({ minLength: 1 });
const resolvableTargetParameters = {
  resolvableId: Type.Optional(cardRefSchema),
  cardId: Type.Optional(cardRefSchema),
  context: Type.Optional(resolvableContextEnum),
  format: Type.Optional(outputFormatEnum),
};
const conversationCreateParameters = {
  cardId: cardRefSchema,
  content: conversationContentSchema,
  format: Type.Optional(outputFormatEnum),
};
const CARD_REFERENCE_WRITE_GUIDELINES = [
  "In user-visible Codecks text, write card references as plain $123 tokens.",
  "Do not surround $123 with emphasis or code formatting such as **, *, _, ~~, backticks, or code fences.",
  "Markdown structure like # $123 and * $123 is okay because the $123 token itself stays plain.",
];

const COMMENT_THREAD_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Do not open new comment threads for follow-up work, progress updates, or completion reports unless the user explicitly asks you to add a comment.",
  "Follow-up updates belong only in an existing open review thread; otherwise, report the update in chat and do not write to Codecks unless explicitly instructed.",
];

const REVIEW_FOLLOWUP_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Codecks allows only one open review thread on a card.",
  "If there is an open/unresolved review and you need to report follow-up work or another update, reply to the existing review thread with codecks_card_reply_resolvable (cardId + context: \"review\", or resolvableId) instead of calling codecks_card_add_review or opening a comment thread.",
  "If there is no open review thread, report follow-up work in chat only unless the user explicitly asks you to add a Codecks comment/reply.",
  "Use codecks_card_list_resolvables when you need to inspect or identify the existing open review thread before replying.",
];

const RESOLVABLE_REPLY_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Use codecks_card_reply_resolvable to reply to an existing comment, review, or blocker thread; use codecks_card_add_comment only when explicitly opening a new comment thread.",
  "For a known thread, prefer resolvableId + content.",
  "For a known card with exactly one matching open thread, use cardId + context + content, for example context: \"comment\" or context: \"review\".",
  "If multiple open threads may match, call codecks_card_list_resolvables first and then reply by resolvableId.",
  "Cannot reply to closed resolvables; list with includeClosed when needed, reopen with codecks_card_reopen_resolvable, then reply.",
];

const RESOLVABLE_LIST_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Use codecks_card_list_resolvables to inspect existing comment, review, or blocker threads before replying when the resolvableId is unknown.",
  "Use contexts such as comment, review, block, or blocker to narrow results.",
  "Use includeClosed=true only when you need to inspect or reopen closed threads.",
];

const DEFAULT_CODECKS_EXPORTS = [
  "query",
  "dispatch",
  "card_search",
  "card_list_done_within_timeframe",
  "card_get_formatted",
  "card_get_vision_board",
  "card_create",
  "card_set_parent",
  "card_add_attachment",
  "card_update",
  "card_update_status",
  "card_add_comment",
  "card_add_review",
  "card_add_blocker",
  "card_add_block",
  "card_reply_resolvable",
  "card_edit_resolvable_entry",
  "card_close_resolvable",
  "card_reopen_resolvable",
  "card_list_resolvables",
  "list_open_resolvable_cards",
  "list_logged_in_user_actionable_resolvables",
  "card_update_effort",
  "card_update_priority",
  "user_lookup",
] as const;

const DEBUG_CODECKS_EXPORTS = [
  "debug_logged_in_user_resolvable_participation",
  "debug_logged_in_user_resolvables",
] as const;

const CODECKS_EXPORTS = [...DEFAULT_CODECKS_EXPORTS, ...DEBUG_CODECKS_EXPORTS] as const;
type CodecksExportName = (typeof CODECKS_EXPORTS)[number];
const ENABLE_DEBUG_TOOLS = /^(1|true|yes)$/i.test(
  process.env.CODECKS_ENABLE_DEBUG_TOOLS ?? process.env.PI_CODECKS_ENABLE_DEBUG_TOOLS ?? "",
);

const TOOL_CONFIG: Partial<Record<CodecksExportName, ToolConfig>> = {
  query: {
    parameters: Type.Object({
      query: Type.Any({ description: "Query object or JSON string." }),
    }),
  },
  dispatch: {
    parameters: Type.Object({
      path: Type.String({ description: "Dispatch path without /dispatch/, e.g. cards/create." }),
      payload: Type.Any({ description: "Payload object or JSON string." }),
      format: Type.Optional(outputFormatEnum),
    }),
  },
  card_search: {
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Partial title to match." })),
      cardCode: Type.Optional(Type.String({ description: "Short card code like $1e1." })),
      location: Type.Optional(locationEnum),
      deck: Type.Optional(cardRefSchema),
      milestone: Type.Optional(cardRefSchema),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 3000 })),
      includeArchived: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.card_code !== undefined && input.cardCode === undefined) input.cardCode = input.card_code;
      if (input.include_archived !== undefined && input.includeArchived === undefined) input.includeArchived = input.include_archived;
      return input;
    },
    promptSnippet: "Search Codecks cards by title, card code, and optional location filters.",
    promptGuidelines: [
      "For Codecks retrieval, prefer codecks_card_get_formatted when the user gave a specific card reference and codecks_card_search when you need disambiguation.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  },
  card_get_formatted: {
    parameters: Type.Object({
      cardId: Type.Optional(cardRefSchema),
      title: Type.Optional(Type.String({ description: "Partial title to match if cardId is not provided." })),
      location: Type.Optional(locationEnum),
      deck: Type.Optional(cardRefSchema),
      milestone: Type.Optional(cardRefSchema),
      includeArchived: Type.Optional(Type.Boolean()),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.id !== undefined && input.cardId === undefined) input.cardId = input.id;
      if (input.card_id !== undefined && input.cardId === undefined) input.cardId = input.card_id;
      if (input.card_id_or_code !== undefined && input.cardId === undefined) input.cardId = input.card_id_or_code;
      if (input.card !== undefined && input.cardId === undefined) input.cardId = input.card;
      if (input.shortCode !== undefined && input.cardId === undefined) input.cardId = input.shortCode;
      if (input.short_code !== undefined && input.cardId === undefined) input.cardId = input.short_code;
      if (input.include_archived !== undefined && input.includeArchived === undefined) input.includeArchived = input.include_archived;
      return input;
    },
    promptSnippet: "Fetch one Codecks card by cardId or by title/location and return a formatted summary.",
    promptGuidelines: [
      "Pass Codecks card identifiers as cardId.",
      "Treat bare numeric Codecks references like 387 as short-code card references and pass them as cardId, not as title or id.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  },
  card_get_vision_board: {
    parameters: Type.Object({
      cardId: cardRefSchema,
      includePayload: Type.Optional(Type.Boolean({ description: "Include raw query/payload content when available." })),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.id !== undefined && input.cardId === undefined) input.cardId = input.id;
      if (input.card_id !== undefined && input.cardId === undefined) input.cardId = input.card_id;
      if (input.card_id_or_code !== undefined && input.cardId === undefined) input.cardId = input.card_id_or_code;
      if (input.card !== undefined && input.cardId === undefined) input.cardId = input.card;
      if (input.shortCode !== undefined && input.cardId === undefined) input.cardId = input.shortCode;
      if (input.short_code !== undefined && input.cardId === undefined) input.cardId = input.short_code;
      if (input.include_payload !== undefined && input.includePayload === undefined) input.includePayload = input.include_payload;
      return input;
    },
    promptSnippet: "Fetch Codecks metadata for a vision board attached to a specific card.",
    promptGuidelines: [
      "Pass Codecks card identifiers as cardId.",
      "Use this tool for card-attached Codecks vision board inspection; it does not render external boards visually.",
      "Treat card-scoped vision board presence as the primary supported path; richer schema-level payload lookup is best-effort only.",
      "Keep includePayload=false unless you specifically need raw vision-board query/payload content.",
      "Valid format values are text or json. If you want a human-readable result, use text; do not invent markdown as a format value.",
    ],
  },
  card_create: {
    parameters: Type.Object({
      title: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      cardType: Type.Optional(Type.String()),
      deck: Type.Optional(cardRefSchema),
      milestone: Type.Optional(cardRefSchema),
      effort: Type.Optional(Type.Number()),
      priority: Type.Optional(Type.String()),
      assigneeId: Type.Optional(cardRefSchema),
      putOnHand: Type.Optional(Type.Boolean()),
      parentCardId: Type.Optional(cardRefSchema),
      tags: Type.Optional(Type.Array(Type.String())),
      format: Type.Optional(outputFormatEnum),
    }),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      if (input.card_type !== undefined && input.cardType === undefined) input.cardType = input.card_type;
      if (input.assignee_id !== undefined && input.assigneeId === undefined) input.assigneeId = input.assignee_id;
      if (input.put_on_hand !== undefined && input.putOnHand === undefined) input.putOnHand = input.put_on_hand;
      if (input.parent_card_id !== undefined && input.parentCardId === undefined) input.parentCardId = input.parent_card_id;
      return input;
    },
    promptGuidelines: CARD_REFERENCE_WRITE_GUIDELINES,
  },
  card_update: {
    promptGuidelines: CARD_REFERENCE_WRITE_GUIDELINES,
  },
  card_add_comment: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Open a new general comment thread on a Codecks card when explicitly requested.",
    promptGuidelines: COMMENT_THREAD_GUIDELINES,
  },
  card_add_review: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Open a new review thread on a Codecks card when explicitly requested.",
    promptGuidelines: REVIEW_FOLLOWUP_GUIDELINES,
  },
  card_add_blocker: {
    parameters: Type.Object(conversationCreateParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyCardIdAliases(input);
      applyContentAliases(input);
      return input;
    },
    promptSnippet: "Open a new blocker thread on a Codecks card.",
    promptGuidelines: CARD_REFERENCE_WRITE_GUIDELINES,
  },
  card_add_block: {
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
  },
  card_reply_resolvable: {
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
  },
  card_edit_resolvable_entry: {
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
  },
  card_close_resolvable: {
    parameters: Type.Object(resolvableTargetParameters),
    prepareArguments(args) {
      const input = normalizeOutputFormatAlias(normalizeArgs(args));
      applyResolvableIdAliases(input);
      applyCardIdAliases(input);
      return input;
    },
    promptSnippet: "Close an existing Codecks comment, review, or blocker thread.",
    promptGuidelines: RESOLVABLE_LIST_GUIDELINES,
  },
  card_reopen_resolvable: {
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
  },
  card_list_resolvables: {
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
  },
  list_open_resolvable_cards: {
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
  },
  list_logged_in_user_actionable_resolvables: {
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
  },
  debug_logged_in_user_resolvable_participation: {
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
  },
  debug_logged_in_user_resolvables: {
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
  },
};

function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
}

function normalizeOutputFormatAlias(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.format === "string" && input.format.trim().toLowerCase() === "markdown") {
    input.format = "text";
  }
  return input;
}

function applyCardIdAliases(input: Record<string, unknown>): void {
  if (input.card_id !== undefined && input.cardId === undefined) input.cardId = input.card_id;
  if (input.card !== undefined && input.cardId === undefined) input.cardId = input.card;
  if (input.shortCode !== undefined && input.cardId === undefined) input.cardId = input.shortCode;
  if (input.short_code !== undefined && input.cardId === undefined) input.cardId = input.short_code;
}

function applyResolvableIdAliases(input: Record<string, unknown>): void {
  if (input.resolvable_id !== undefined && input.resolvableId === undefined) input.resolvableId = input.resolvable_id;
  if (input.threadId !== undefined && input.resolvableId === undefined) input.resolvableId = input.threadId;
  if (input.thread_id !== undefined && input.resolvableId === undefined) input.resolvableId = input.thread_id;
}

function applyEntryIdAliases(input: Record<string, unknown>): void {
  if (input.entry_id !== undefined && input.entryId === undefined) input.entryId = input.entry_id;
}

function applyContentAliases(input: Record<string, unknown>): void {
  if (input.message !== undefined && input.content === undefined) input.content = input.message;
  if (input.body !== undefined && input.content === undefined) input.content = input.body;
  if (input.reply !== undefined && input.content === undefined) input.content = input.reply;
  if (input.text !== undefined && input.content === undefined) input.content = input.text;
}

function toToolName(exportName: string): string {
  return `codecks_${exportName}`;
}

function toText(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  return JSON.stringify(result, null, 2);
}

function getCoreTool(exportName: string): CoreTool {
  const candidate = (core as Record<string, unknown>)[exportName] as CoreTool | undefined;
  if (!candidate || typeof candidate.execute !== "function") {
    throw new Error(`Missing Codecks core tool export '${exportName}'.`);
  }
  return candidate;
}

export default function codecksTools(pi: ExtensionAPI) {
  const enabledExports = ENABLE_DEBUG_TOOLS ? CODECKS_EXPORTS : DEFAULT_CODECKS_EXPORTS;

  for (const exportName of enabledExports) {
    const coreTool = getCoreTool(exportName);
    const config = TOOL_CONFIG[exportName] ?? {};
    pi.registerTool({
      name: toToolName(exportName),
      label: toToolName(exportName),
      description: coreTool.description ?? toToolName(exportName),
      promptSnippet: config.promptSnippet,
      promptGuidelines: config.promptGuidelines,
      parameters: config.parameters ?? ANY_PARAMETERS,
      prepareArguments: config.prepareArguments,
      async execute(_toolCallId, params, signal) {
        const normalizedParams = (params ?? {}) as Record<string, unknown>;
        const result = await core.runWithAbortSignal(signal, async () => coreTool.execute(normalizedParams));
        const text = toText(result);
        return {
          content: [{ type: "text", text }],
          details: {
            exportName,
            rawResult: result,
          },
        };
      },
    });
  }
}
