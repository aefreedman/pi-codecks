import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CODECKS_READ_ERROR_CODES, projectBoundedValue } from "../../contracts/common";
import type { CodecksStructuredOutput } from "../../pi/tool-definition";
import { record, type ConversationEffect } from "./conversations-dto-helpers";
import { validConversationIdentities } from "./conversations-read-output";

export const CONVERSATION_WRITE_LIMITS = { bytes: 16384, string: 2048, identity: 128 } as const;
export const CONVERSATION_WRITE_ACTIONS = ["card_add_comment", "card_add_review", "card_add_blocker", "card_add_block", "card_reply_resolvable", "card_edit_resolvable_entry", "card_close_resolvable", "card_reopen_resolvable"] as const;
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const id = () => Type.String({ minLength: 1, maxLength: CONVERSATION_WRITE_LIMITS.identity, pattern: "^[A-Za-z0-9_-]+$" });
const count = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullable = (value: TSchema) => Type.Optional(Type.Union([value, Type.Null()]));
const facts = object({ cardId: Type.Optional(id()), resolvableId: Type.Optional(id()), entryId: Type.Optional(id()), context: nullable(Type.String({ maxLength: CONVERSATION_WRITE_LIMITS.string })), actorId: Type.Optional(Type.Union([id(), count()])), isClosedBefore: nullable(Type.Boolean()), versionBefore: nullable(count()), expectedVersion: Type.Optional(Type.Number({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER })), contentDiffersBefore: Type.Optional(Type.Boolean()), isAlias: Type.Optional(Type.Boolean()) });
const effects: ConversationEffect[] = ["not_dispatched", "definitely_rejected", "dispatch_returned", "indeterminate"];
const effectSchema = Type.Union(effects.map(value => Type.Literal(value)));
function schema(action: typeof CONVERSATION_WRITE_ACTIONS[number]) {
  const common = { schemaVersion: Type.Literal(1), action: Type.Literal(action), provenance: object({ source: Type.Literal("codecks"), receipt: Type.Literal("dispatch_not_readback") }), effect: effectSchema, replayPermitted: Type.Literal(false), projectionComplete: Type.Boolean() };
  const target = action.startsWith("card_add_") ? "cardId" : action === "card_edit_resolvable_entry" ? "entryId" : "resolvableId";
  const successFacts = object({ ...facts.properties, [target]: id() });
  return Type.Union([object({ ...common, ok: Type.Literal(true), data: successFacts }), object({ ...common, ok: Type.Literal(false), error: object({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(value => Type.Literal(value))), message: Type.String({ maxLength: CONVERSATION_WRITE_LIMITS.string }) }), data: Type.Optional(facts) })]);
}
export const CARD_ADD_COMMENT_OUTPUT_SCHEMA = schema("card_add_comment");
export const CARD_ADD_REVIEW_OUTPUT_SCHEMA = schema("card_add_review");
export const CARD_ADD_BLOCKER_OUTPUT_SCHEMA = schema("card_add_blocker");
export const CARD_ADD_BLOCK_OUTPUT_SCHEMA = schema("card_add_block");
export const CARD_REPLY_RESOLVABLE_OUTPUT_SCHEMA = schema("card_reply_resolvable");
export const CARD_EDIT_RESOLVABLE_ENTRY_OUTPUT_SCHEMA = schema("card_edit_resolvable_entry");
export const CARD_CLOSE_RESOLVABLE_OUTPUT_SCHEMA = schema("card_close_resolvable");
export const CARD_REOPEN_RESOLVABLE_OUTPUT_SCHEMA = schema("card_reopen_resolvable");
export const CONVERSATION_WRITE_SCHEMAS = { card_add_comment: CARD_ADD_COMMENT_OUTPUT_SCHEMA, card_add_review: CARD_ADD_REVIEW_OUTPUT_SCHEMA, card_add_blocker: CARD_ADD_BLOCKER_OUTPUT_SCHEMA, card_add_block: CARD_ADD_BLOCK_OUTPUT_SCHEMA, card_reply_resolvable: CARD_REPLY_RESOLVABLE_OUTPUT_SCHEMA, card_edit_resolvable_entry: CARD_EDIT_RESOLVABLE_ENTRY_OUTPUT_SCHEMA, card_close_resolvable: CARD_CLOSE_RESOLVABLE_OUTPUT_SCHEMA, card_reopen_resolvable: CARD_REOPEN_RESOLVABLE_OUTPUT_SCHEMA };
export function hasConversationWriteByteBudget(value: unknown): boolean { try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= CONVERSATION_WRITE_LIMITS.bytes; } catch { return false; } }
/** Contract failure retains observed effect and only individually valid bounded facts. Never permits replay. */
export function projectConversationWriteOutput(action: typeof CONVERSATION_WRITE_ACTIONS[number], payload: unknown): CodecksStructuredOutput {
  const source = record(payload);
  // Missing/malformed evidence cannot prove definitely unsent.
  const effect = source && effects.includes(source.effect as ConversationEffect) ? source.effect : "indeterminate";
  const base = { schemaVersion: 1, action, provenance: { source: "codecks", receipt: "dispatch_not_readback" }, effect, replayPermitted: false };
  const fail = (code = "output_contract_error"): CodecksStructuredOutput => {
    const safe: Record<string, unknown> = {};
    const nativeFacts = record(source?.facts);
    for (const [key, fieldSchema] of Object.entries(facts.properties)) if (nativeFacts && Value.Check(fieldSchema, nativeFacts[key]) && nativeFacts[key] !== undefined) safe[key] = nativeFacts[key];
    return { ...base, ok: false, projectionComplete: false, error: { code, message: code === "output_too_large" ? "Conversation receipt exceeds the structured output byte budget; do not replay." : "Codecks could not produce a valid conversation receipt; do not replay." }, data: safe };
  };
  try {
    if (!source || source.action !== action || source.schemaVersion !== 1 || typeof source.ok !== "boolean" || !effects.includes(source.effect as ConversationEffect) || source.replayPermitted !== false || !record(source.facts) || !validConversationIdentities(source.facts)) return fail();
    if (source.ok && source.effect !== "dispatch_returned" && !(action === "card_edit_resolvable_entry" && source.effect === "not_dispatched" && record(source.facts)?.contentDiffersBefore === false)) return fail();
    const state = { complete: true };
    const candidate = { ...base, ok: source.ok, projectionComplete: true, data: source.facts, ...(source.ok ? {} : { error: source.error }) };
    const output = projectBoundedValue(CONVERSATION_WRITE_SCHEMAS[action], candidate, state) as CodecksStructuredOutput;
    output.projectionComplete = state.complete;
    if (!Value.Check(CONVERSATION_WRITE_SCHEMAS[action], output)) return fail();
    if (!hasConversationWriteByteBudget(output)) return fail("output_too_large");
    return output;
  } catch { return fail(); }
}
