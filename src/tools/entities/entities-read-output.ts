import { Type } from "typebox";
import { sanitizeValue } from "../../shared/results";
import { closed, text, nullable, optionalText, identity, sequence, projectionSchema, errorSchema, ENTITY_OUTPUT_LIMITS, projectEntityContract } from "./entities-output-helpers";
export { ENTITY_OUTPUT_LIMITS, hasEntityByteBudget } from "./entities-output-helpers";
const common = { id: Type.Optional(identity), accountSeq: Type.Optional(sequence), name: optionalText(), title: optionalText(), description: Type.Optional(nullable(text(ENTITY_OUTPUT_LIMITS.description))), isDeleted: Type.Optional(nullable(Type.Boolean())) };
const reference = Type.Optional(closed({ accountSeq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), url: Type.String({ maxLength: 2048, pattern: "^https://[a-zA-Z0-9-]+\\.codecks\\.io/(sprint|milestones)/[1-9][0-9]*$" }) }));
export const DECK_FACT_SCHEMA = closed({ ...common, status: optionalText() });
export const MILESTONE_FACT_SCHEMA = closed({ ...common, date: optionalText(), startDate: optionalText(), color: optionalText(), isGlobal: Type.Optional(nullable(Type.Boolean())), handSyncEnabled: Type.Optional(nullable(Type.Boolean())), reference });
export const RUN_CARD_FACT_SCHEMA = closed({ cardId: Type.Optional(identity), accountSeq: Type.Optional(sequence), title: optionalText(), status: optionalText(), derivedStatus: optionalText(), isDoc: Type.Optional(nullable(Type.Boolean())), sprintId: Type.Optional(identity) });
export const RUN_FACT_SCHEMA = closed({ ...common, startDate: optionalText(), endDate: optionalText(), completedAt: optionalText(), lockedAt: optionalText(), reference, sprintConfig: Type.Optional(Type.Union([closed({ id: Type.Optional(identity), name: optionalText(), color: optionalText() }), identity])) });
export const USER_FACT_SCHEMA = closed({ id: identity, name: optionalText(), fullName: optionalText() });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const listEvidence = { sourceCount: count, filteredCount: count, emittedCount: count, truncated: Type.Boolean() };
const dataSchemas = {
  "deck-get": closed({ deck: DECK_FACT_SCHEMA }),
  "milestone-get": closed({ milestone: MILESTONE_FACT_SCHEMA }),
  "milestone-list": closed({ ...listEvidence, milestones: Type.Array(MILESTONE_FACT_SCHEMA, { maxItems: ENTITY_OUTPUT_LIMITS.entities }) }),
  "run-list": closed({ ...listEvidence, runs: Type.Array(RUN_FACT_SCHEMA, { maxItems: ENTITY_OUTPUT_LIMITS.entities }) }),
  "run-get": closed({ run: RUN_FACT_SCHEMA, cards: Type.Array(RUN_CARD_FACT_SCHEMA, { maxItems: ENTITY_OUTPUT_LIMITS.cards }), sourceCardCount: Type.Optional(count), cardRelation: Type.Union([Type.Literal("observed"), Type.Literal("unavailable")]) }),
  "user-lookup": closed({ query: text(), requestedScanLimit: count, candidateCount: count, matchedCount: count, emittedCount: count, users: Type.Array(USER_FACT_SCHEMA, { maxItems: ENTITY_OUTPUT_LIMITS.users }) }),
};
export type EntityReadAction = keyof typeof dataSchemas;
export const ENTITY_READ_SCHEMAS = Object.fromEntries(Object.entries(dataSchemas).map(([action, data]) => {
  const base = { version: Type.Literal(1), action: Type.Literal(action), projection: projectionSchema };
  return [action, Type.Union([
    closed({ ...base, ok: Type.Literal(true), data, provenance: closed({ scope: Type.Literal(action === "user-lookup" ? "recent-card-assignees-creators" : "token-visible-entities"), exhaustive: Type.Literal(false), sourceCompleteness: Type.Literal("unverified") }) }),
    closed({ ...base, ok: Type.Literal(false), error: errorSchema }),
  ])];
})) as unknown as Record<EntityReadAction, ReturnType<typeof Type.Union>>;
export const DECK_GET_OUTPUT_SCHEMA = ENTITY_READ_SCHEMAS["deck-get"];
export const MILESTONE_GET_OUTPUT_SCHEMA = ENTITY_READ_SCHEMAS["milestone-get"];
export const MILESTONE_LIST_OUTPUT_SCHEMA = ENTITY_READ_SCHEMAS["milestone-list"];
export const RUN_LIST_OUTPUT_SCHEMA = ENTITY_READ_SCHEMAS["run-list"];
export const RUN_GET_OUTPUT_SCHEMA = ENTITY_READ_SCHEMAS["run-get"];
export const USER_LOOKUP_OUTPUT_SCHEMA = ENTITY_READ_SCHEMAS["user-lookup"];
export const projectEntityReadOutput = (action: EntityReadAction, payload: unknown) => projectEntityContract(ENTITY_READ_SCHEMAS[action], payload, action);
export const entityReadSuccess = (action: EntityReadAction, data: Record<string, unknown>) => ({ version: 1, action, ok: true, data, provenance: { scope: action === "user-lookup" ? "recent-card-assignees-creators" : "token-visible-entities", exhaustive: false, sourceCompleteness: "unverified" }, projection: { complete: true } });
export const entityReadError = (action: EntityReadAction, code: string, message: string) => ({ version: 1, action, ok: false, error: { code, message: sanitizeValue(message) }, projection: { complete: true } });
