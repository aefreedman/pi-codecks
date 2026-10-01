import { Type } from "typebox";

export const ANY_PARAMETERS = Type.Object({}, { additionalProperties: true });
export const outputFormatEnum = Type.Union([Type.Literal("text"), Type.Literal("json")]);
export const cardSearchOutputModeEnum = Type.Union([Type.Literal("compact"), Type.Literal("detailed"), Type.Literal("counts")]);
export const cardRefSchema = Type.Union([Type.String(), Type.Number()]);
export const bulkCreateRecordSchema = Type.Object({
  correlationKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Opaque caller correlation key echoed in results; not an idempotency key." })),
  title: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  cardType: Type.Optional(Type.String()),
  deck: Type.Optional(cardRefSchema),
  milestone: Type.Optional(cardRefSchema),
  effort: Type.Optional(Type.Number()),
  priority: Type.Optional(Type.String()),
  assigneeId: Type.Optional(cardRefSchema),
  putOnHand: Type.Optional(Type.Boolean({ description: "PERSONAL own-hand creation only; ORG requires a separately verified explicit human hand target and is currently guarded." })),
  parentCardId: Type.Optional(cardRefSchema),
  tags: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
export const bulkUpdateRecordSchema = Type.Object({
  correlationKey: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Opaque caller correlation key echoed in results; not an idempotency key." })),
  cardId: cardRefSchema,
  title: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  cardType: Type.Optional(Type.String()),
  deck: Type.Optional(cardRefSchema),
  milestone: Type.Optional(cardRefSchema),
  assigneeId: Type.Optional(cardRefSchema),
  effort: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  clearDeck: Type.Optional(Type.Boolean({ description: "Unavailable: true rejects the entire batch before requests. Codecks returned HTTP 500 for deck removal; use the Codecks UI until the API contract is verified." })),
  clearMilestone: Type.Optional(Type.Boolean({ description: "Remove the milestone assignment." })),
  clearAssignee: Type.Optional(Type.Boolean({ description: "Remove the assignee only if the card has or is given a deck; unassigned and deckless is not allowed." })),
  clearEffort: Type.Optional(Type.Boolean({ description: "Clear the effort estimate." })),
  priority: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  runId: Type.Optional(cardRefSchema),
  clearRun: Type.Optional(Type.Boolean()),
  parentCardId: Type.Optional(cardRefSchema),
  clearParent: Type.Optional(Type.Boolean()),
  mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("prepend")])),
}, { additionalProperties: false });
export const LOCATION_VALUES = ["any", "deck", "milestone", "hand", "bookmarks"] as const;
export const locationEnum = Type.Union([
  Type.Literal("any"),
  Type.Literal("deck"),
  Type.Literal("milestone"),
  Type.Literal("hand"),
  Type.Literal("bookmarks"),
]);
export const resolvableContextEnum = Type.Union([
  Type.Literal("comment"),
  Type.Literal("review"),
  Type.Literal("block"),
  Type.Literal("blocker"),
]);
export const conversationContentSchema = Type.String({ minLength: 1 });
export const resolvableTargetParameters = {
  resolvableId: Type.Optional(cardRefSchema),
  cardId: Type.Optional(cardRefSchema),
  context: Type.Optional(resolvableContextEnum),
  format: Type.Optional(outputFormatEnum),
};
export const conversationCreateParameters = {
  cardId: cardRefSchema,
  content: conversationContentSchema,
  format: Type.Optional(outputFormatEnum),
};
export const CARD_REFERENCE_WRITE_GUIDELINES = [
  "In user-visible Codecks text, write card references as plain $123 tokens.",
  "Do not surround $123 with emphasis or code formatting such as **, *, _, ~~, backticks, or code fences.",
  "Markdown structure like # $123 and * $123 is okay because the $123 token itself stays plain.",
];

export const COMMENT_THREAD_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Do not open new comment threads for follow-up work, progress updates, or completion reports unless the user explicitly asks you to add a comment.",
  "Follow-up updates belong only in an existing open review thread; otherwise, report the update in chat and do not write to Codecks unless explicitly instructed.",
];

export const CORRECTIVE_FOLLOWUP_GUIDELINE =
  "When correcting an earlier review update, briefly state the earlier evidence or assumption, the new contradictory or limiting evidence, and the remaining validation gap; scope the conclusion to supported evidence and avoid calling the issue fixed or naming a root cause until evidence supports those claims.";

export const REVIEW_FOLLOWUP_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Codecks allows only one open review thread on a card.",
  "If there is an open/unresolved review and you need to report follow-up work or another update, reply to the existing review thread with codecks_card_reply_resolvable (cardId + context: \"review\", or resolvableId) instead of calling codecks_card_add_review or opening a comment thread.",
  "If there is no open review thread, report follow-up work in chat only unless the user explicitly asks you to add a Codecks comment/reply.",
  "Use codecks_card_list_resolvables when you need to inspect or identify the existing open review thread before replying.",
  CORRECTIVE_FOLLOWUP_GUIDELINE,
];

export const RESOLVABLE_REPLY_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Use codecks_card_reply_resolvable to reply to an existing comment, review, or blocker thread; use codecks_card_add_comment only when explicitly opening a new comment thread.",
  CORRECTIVE_FOLLOWUP_GUIDELINE,
  "For a known thread, prefer resolvableId + content.",
  "For a known card with exactly one matching open thread, use cardId + context + content, for example context: \"comment\" or context: \"review\".",
  "If multiple open threads may match, call codecks_card_list_resolvables first and then reply by resolvableId.",
  "Cannot reply to closed resolvables; list with includeClosed when needed, reopen with codecks_card_reopen_resolvable, then reply.",
];

export const RESOLVABLE_LIST_GUIDELINES = [
  ...CARD_REFERENCE_WRITE_GUIDELINES,
  "Use codecks_card_list_resolvables to inspect existing comment, review, or blocker threads before replying when the resolvableId is unknown.",
  "Use contexts such as comment, review, block, or blocker to narrow results.",
  "Use includeClosed=true only when you need to inspect or reopen closed threads.",
];

export function normalizeArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? { ...(args as Record<string, unknown>) } : {};
}

export function normalizeOutputFormatAlias(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.format === "string" && input.format.trim().toLowerCase() === "markdown") {
    input.format = "text";
  }
  return input;
}

export function normalizeCardLocationAliases(input: Record<string, unknown>): void {
  if (typeof input.location !== "string") return;
  const location = input.location.trim();
  if (!location) return;
  if ((LOCATION_VALUES as readonly string[]).includes(location)) return;
  if (input.deck !== undefined || input.milestone !== undefined) return;
  input.deck = location;
  delete input.location;
}

export function applyCardIdAliases(input: Record<string, unknown>): void {
  if (input.card_id !== undefined && input.cardId === undefined) input.cardId = input.card_id;
  if (input.card !== undefined && input.cardId === undefined) input.cardId = input.card;
  if (input.shortCode !== undefined && input.cardId === undefined) input.cardId = input.shortCode;
  if (input.short_code !== undefined && input.cardId === undefined) input.cardId = input.short_code;
}

export function applyResolvableIdAliases(input: Record<string, unknown>): void {
  if (input.resolvable_id !== undefined && input.resolvableId === undefined) input.resolvableId = input.resolvable_id;
  if (input.threadId !== undefined && input.resolvableId === undefined) input.resolvableId = input.threadId;
  if (input.thread_id !== undefined && input.resolvableId === undefined) input.resolvableId = input.thread_id;
}

export function applyEntryIdAliases(input: Record<string, unknown>): void {
  if (input.entry_id !== undefined && input.entryId === undefined) input.entryId = input.entry_id;
}

export function applyRunIdAliases(input: Record<string, unknown>): void {
  if (input.run_id !== undefined && input.runId === undefined) input.runId = input.run_id;
  if (input.sprint_id !== undefined && input.runId === undefined) input.runId = input.sprint_id;
  if (input.sprintId !== undefined && input.runId === undefined) input.runId = input.sprintId;
  if (input.run !== undefined && input.runId === undefined) input.runId = input.run;
  if (input.sprint !== undefined && input.runId === undefined) input.runId = input.sprint;
}

export function applyRunStatsAliases(input: Record<string, unknown>): void {
  if (input.sprint_config !== undefined && input.sprintConfig === undefined) input.sprintConfig = input.sprint_config;
  if (input.sprintConfigName !== undefined && input.sprintConfig === undefined) input.sprintConfig = input.sprintConfigName;
  if (input.sprint_config_name !== undefined && input.sprintConfig === undefined) input.sprintConfig = input.sprint_config_name;
  if (input.user_id !== undefined && input.userId === undefined) input.userId = input.user_id;
  if (input.completed_runs !== undefined && input.completedRuns === undefined) input.completedRuns = input.completed_runs;
  if (input.run_count !== undefined && input.completedRuns === undefined) input.completedRuns = input.run_count;
  if (input.include_current_stats !== undefined && input.includeCurrentStats === undefined) input.includeCurrentStats = input.include_current_stats;
}

export function applyDeckIdAliases(input: Record<string, unknown>): void {
  if (input.deck_id !== undefined && input.deckId === undefined) input.deckId = input.deck_id;
  if (input.deck !== undefined && input.deckId === undefined) input.deckId = input.deck;
}

export function applyMilestoneIdAliases(input: Record<string, unknown>): void {
  if (input.milestone_id !== undefined && input.milestoneId === undefined) input.milestoneId = input.milestone_id;
  if (input.milestone !== undefined && input.milestoneId === undefined) input.milestoneId = input.milestone;
}

export function applyContentAliases(input: Record<string, unknown>): void {
  if (input.message !== undefined && input.content === undefined) input.content = input.message;
  if (input.body !== undefined && input.content === undefined) input.content = input.body;
  if (input.reply !== undefined && input.content === undefined) input.content = input.reply;
  if (input.text !== undefined && input.content === undefined) input.content = input.text;
}
