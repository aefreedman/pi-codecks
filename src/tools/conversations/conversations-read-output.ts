import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CODECKS_READ_ERROR_CODES, projectBoundedValue } from "../../contracts/common";
import type { CodecksStructuredOutput } from "../../pi/tool-definition";
import { record } from "./conversations-dto-helpers";

export const CONVERSATION_READ_LIMITS = { bytes: 65536, string: 2048, content: 32768, identity: 128, threads: 500, entries: 50, cards: 500, items: 500, groups: 50 } as const;
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const optional = (schema: TSchema) => Type.Optional(Type.Union([schema, Type.Null()]));
const string = () => Type.String({ maxLength: CONVERSATION_READ_LIMITS.string });
const count = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const id = () => Type.String({ minLength: 1, maxLength: CONVERSATION_READ_LIMITS.identity, pattern: "^[A-Za-z0-9_-]+$" });
const actor = object({ id: Type.Optional(Type.Union([id(), count()])), name: optional(string()), fullName: optional(string()) });
const card = object({ cardId: optional(id()), accountSeq: optional(count()), title: optional(string()), status: optional(string()), derivedStatus: optional(string()) });
const entry = object({ entryId: optional(id()), content: optional(Type.String({ maxLength: CONVERSATION_READ_LIMITS.content })), version: optional(count()), createdAt: optional(string()), lastChangedAt: optional(string()), author: optional(actor) });
const threadProperties = { id: optional(id()), context: optional(string()), createdAt: optional(string()), isClosed: optional(Type.Boolean()), closedAt: optional(string()) };
const thread = object(threadProperties);
const detailedThread = object({ ...threadProperties, detailObserved: Type.Boolean(), sourceEntries: Type.Optional(count()), observedEntries: count(), entries: Type.Array(entry, { maxItems: CONVERSATION_READ_LIMITS.entries }) });
const grouped = Type.Array(object({ context: string(), sourceCards: count(), emittedCards: count(), cardIds: Type.Array(id(), { maxItems: CONVERSATION_READ_LIMITS.cards }) }), { maxItems: CONVERSATION_READ_LIMITS.groups });
const scan = { scanLimit: Type.Number({ minimum: 1, maximum: 5000 }), scannedCards: count(), sourceCardReferences: Type.Optional(count()), relationResolutionComplete: Type.Boolean(), scanLimitReached: Type.Optional(Type.Boolean()) };
const listFacts = object({ card, sourceThreadReferences: Type.Optional(count()), sourceThreads: count(), matchedThreads: count(), emittedThreads: count(), limit: Type.Number({ minimum: 1, maximum: 500 }), includeClosed: Type.Boolean(), threads: Type.Array(detailedThread, { maxItems: CONVERSATION_READ_LIMITS.threads }) });
const openFacts = object({ ...scan, matchedCards: count(), openResolvables: count(), emittedCards: count(), groups: grouped, cards: Type.Array(object({ ...card.properties, sourceThreads: count(), threads: Type.Array(thread, { maxItems: CONVERSATION_READ_LIMITS.threads }) }), { maxItems: CONVERSATION_READ_LIMITS.cards }) });
const actionableFacts = object({ ...scan, userId: id(), staleAfterHours: Type.Number({ minimum: 1, maximum: 720 }), actionableResolvableCount: count(), waitingOnUserCount: count(), resurfacedCount: count(), bubbleSummary: object({ unread: count(), read: count(), stale_review: count() }), groups: grouped, items: Type.Array(object({ card, thread, latestEntry: Type.Optional(entry), bucket: Type.Union([Type.Literal("new_activity"), Type.Literal("resurfaced")]), reason: string(), bubbleHeuristic: Type.Union([Type.Literal("unread"), Type.Literal("read"), Type.Literal("stale_review")]), latestActivityAt: optional(string()), latestEntryByLoggedInUser: Type.Boolean(), latestEntryByOtherUser: Type.Boolean(), latestEntryMentionsLoggedInUser: Type.Boolean(), participantSampleIncludesLoggedInUser: Type.Boolean() }), { maxItems: CONVERSATION_READ_LIMITS.items }) });
const error = object({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(value => Type.Literal(value))), message: string() });
const completeness = object({ read: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("unknown")]), projection: Type.Boolean() });
export const CONVERSATION_READ_ACTIONS = ["card_list_resolvables", "list_open_resolvable_cards", "list_logged_in_user_actionable_resolvables"] as const;
const factSchemas = { card_list_resolvables: listFacts, list_open_resolvable_cards: openFacts, list_logged_in_user_actionable_resolvables: actionableFacts };
function schema(action: typeof CONVERSATION_READ_ACTIONS[number]) {
  const common = { schemaVersion: Type.Literal(1), action: Type.Literal(action), provenance: object({ source: Type.Literal("codecks"), contentTrust: Type.Literal("external"), scope: Type.Literal(action === "card_list_resolvables" ? "card_relations" : "recent_visible_cards"), heuristic: Type.Literal(action === "list_logged_in_user_actionable_resolvables") }), completeness };
  const partial = object(Object.fromEntries(Object.entries(factSchemas[action].properties).map(([key, value]) => [key, Type.Optional(value)])));
  return Type.Union([object({ ...common, ok: Type.Literal(true), data: factSchemas[action] }), object({ ...common, ok: Type.Literal(false), error, data: Type.Optional(partial) })]);
}
export const CARD_LIST_RESOLVABLES_OUTPUT_SCHEMA = schema("card_list_resolvables");
export const LIST_OPEN_RESOLVABLE_CARDS_OUTPUT_SCHEMA = schema("list_open_resolvable_cards");
export const LIST_LOGGED_IN_USER_ACTIONABLE_RESOLVABLES_OUTPUT_SCHEMA = schema("list_logged_in_user_actionable_resolvables");
export const CONVERSATION_READ_SCHEMAS = { card_list_resolvables: CARD_LIST_RESOLVABLES_OUTPUT_SCHEMA, list_open_resolvable_cards: LIST_OPEN_RESOLVABLE_CARDS_OUTPUT_SCHEMA, list_logged_in_user_actionable_resolvables: LIST_LOGGED_IN_USER_ACTIONABLE_RESOLVABLES_OUTPUT_SCHEMA };
export function hasConversationReadByteBudget(value: unknown): boolean { try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= CONVERSATION_READ_LIMITS.bytes; } catch { return false; } }
// Identity fields are checked before the generic string projector can clip them.
export function validConversationIdentities(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(validConversationIdentities);
  const source = record(value); if (!source) return true;
  return Object.entries(source).every(([key, item]) => {
    if (["id", "cardId", "entryId", "resolvableId", "userId", "actorId", "cardIds"].includes(key)) {
      if (key === "cardIds") return Array.isArray(item) && item.every(v => Value.Check(id(), v));
      if (item !== undefined && item !== null && !Value.Check(Type.Union([id(), count()]), item)) return false;
    }
    return validConversationIdentities(item);
  });
}
function base(action: typeof CONVERSATION_READ_ACTIONS[number], read: unknown, projection: boolean) {
  return { schemaVersion: 1, action, provenance: { source: "codecks", contentTrust: "external", scope: action === "card_list_resolvables" ? "card_relations" : "recent_visible_cards", heuristic: action === "list_logged_in_user_actionable_resolvables" }, completeness: { read, projection } };
}
export function projectConversationReadOutput(action: typeof CONVERSATION_READ_ACTIONS[number], payload: unknown): CodecksStructuredOutput {
  const fail = (code = "output_contract_error"): CodecksStructuredOutput => ({ ...base(action, "unknown", false), ok: false, error: { code, message: code === "output_too_large" ? "Conversation data exceeds the structured output byte budget." : "Codecks could not produce valid structured conversation output." } });
  try {
    const source = record(payload);
    if (!source || source.action !== action || source.schemaVersion !== 1 || typeof source.ok !== "boolean" || !record(source.facts) || !validConversationIdentities(source.facts)) return fail();
    const state = { complete: true };
    const candidate = { ...base(action, source.read, true), ok: source.ok, data: source.facts, ...(source.ok ? {} : { error: source.error }) };
    const output = projectBoundedValue(CONVERSATION_READ_SCHEMAS[action], candidate, state) as CodecksStructuredOutput;
    (output.completeness as Record<string, unknown>).projection = state.complete;
    if (!Value.Check(CONVERSATION_READ_SCHEMAS[action], output)) return fail();
    if (!hasConversationReadByteBudget(output)) return fail("output_too_large");
    return output;
  } catch { return fail(); }
}
