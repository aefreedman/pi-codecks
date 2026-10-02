import { CODECKS_READ_LIMITS, projectBoundedValue as project, CODECKS_READ_ERROR_CODES as codes, type ProjectionSchema } from "./contracts/common";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** Public v1 pilot limits: UTF-8 JSON bytes, Unicode code points, and array items. */
export const CARD_GET_LIMITS = { ...CODECKS_READ_LIMITS, content: 32768, array: 25, candidates: 5 } as const;
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const str = (maxLength: number = CARD_GET_LIMITS.string) => Type.String({ maxLength });
const optional = <T extends TSchema>(schema: T) => Type.Optional(nullable(schema));
const strings = (names: string[]) => Object.fromEntries(names.map(name => [name, optional(str())]));
const identity = { ...strings(["cardId", "shortCode", "cardRef", "accountSeqRef", "url", "title", "status", "derivedStatus", "cardType"]), accountSeq: optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), isDoc: optional(Type.Boolean()) };
const related = object(identity);
const user = object(strings(["id", "name", "fullName"]));
const deck = object({ ...strings(["id", "title"]), accountSeq: optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) });
const milestone = object({ ...strings(["id", "name", "title", "description", "date", "startDate", "color", "url"]), accountSeq: optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), isGlobal: optional(Type.Boolean()), handSyncEnabled: optional(Type.Boolean()), isDeleted: optional(Type.Boolean()) });
const cardSchema = object({
  ...identity, ...strings(["visibility", "priority", "dueDate", "lastUpdatedAt"]),
  content: optional(str(CARD_GET_LIMITS.content)), contentTrust: Type.Literal("external"),
  effort: optional(Type.Number()), tags: optional(Type.Array(str(), { maxItems: CARD_GET_LIMITS.array })),
  deck: optional(deck), milestone: optional(milestone), assignee: optional(user), creator: optional(user),
  parentCard: optional(related), childCards: optional(Type.Array(related, { maxItems: CARD_GET_LIMITS.array })),
});
const candidate = object({ ...identity, ...strings(["deck", "milestone", "assignee"]) });
const common = {
  schemaVersion: Type.Literal(1), action: Type.Literal("card_get"),
  provenance: object({ source: Type.Literal("codecks"), contentTrust: Type.Literal("external") }),
  completeness: object({ read: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("unknown")]), projection: Type.Boolean() }),
};
export const CARD_GET_OUTPUT_SCHEMA = Type.Union([
  object({ ...common, ok: Type.Literal(true), card: cardSchema }),
  object({ ...common, ok: Type.Literal(false), error: object({ code: Type.Union(codes.map(code => Type.Literal(code))), message: str() }),
    evidence: Type.Optional(object({ ...strings(["recoveryHint", "suggestedCardRef"]), candidates: Type.Optional(Type.Array(candidate, { maxItems: CARD_GET_LIMITS.candidates })) })) }),
]);
export type CardGetOutput = Static<typeof CARD_GET_OUTPUT_SCHEMA>;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const base = (read: "complete" | "incomplete" | "unknown", projection = true) => ({ schemaVersion: 1 as const, action: "card_get" as const, provenance: { source: "codecks" as const, contentTrust: "external" as const }, completeness: { read, projection } });
export function cardGetContractError(code: "output_contract_error" | "output_too_large" = "output_contract_error"): CardGetOutput {
  return { ...base("unknown", false), ok: false, error: { code, message: code === "output_too_large" ? "Card data exceeds the structured output byte budget." : "Codecks could not produce valid structured card output." } } as CardGetOutput;
}
export function isCardGetOutput(value: unknown): value is CardGetOutput {
  try { return Value.Check(CARD_GET_OUTPUT_SCHEMA, value) && Buffer.byteLength(JSON.stringify(value), "utf8") <= CARD_GET_LIMITS.bytes; }
  catch { return false; }
}

/** Schema-directed allowlist projection, never a spread of renderer details or transport data. */
export function projectCardGetOutput(payload: unknown): CardGetOutput {
  try {
    const source = record(payload);
    if (!source || source.action !== "card-get" || typeof source.ok !== "boolean") return cardGetContractError();
    const state = { complete: true };
    let output: unknown;
    if (source.ok) {
      const card = project(cardSchema, record(source.data)?.card, state);
      output = { ...base("complete", state.complete), ok: true, card };
    } else {
      const error = record(source.error);
      if (!error || typeof error.message !== "string" || typeof error.category !== "string") return cardGetContractError();
      const code = codes.includes(error.category as typeof codes[number]) ? error.category : "api_error";
      const evidenceSchema = (CARD_GET_OUTPUT_SCHEMA.anyOf[1] as ProjectionSchema).properties.evidence;
      const evidence = project(evidenceSchema, error, state) as Record<string, unknown>;
      const message = project(str(), error.message, state);
      output = { ...base(code === "incomplete_read" || error.complete === false ? "incomplete" : "unknown", state.complete), ok: false, error: { code, message }, ...(Object.keys(evidence).length ? { evidence } : {}) };
    }
    if (Buffer.byteLength(JSON.stringify(output), "utf8") > CARD_GET_LIMITS.bytes) return cardGetContractError("output_too_large");
    return isCardGetOutput(output) ? output : cardGetContractError();
  } catch { return cardGetContractError(); }
}

// Shared bounded allowlist primitive; card-get schema and projection are unchanged.
export { projectBoundedValue, CODECKS_READ_ERROR_CODES } from "./contracts/common";
