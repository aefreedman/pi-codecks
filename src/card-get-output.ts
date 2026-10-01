import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

/** Public v1 pilot limits: UTF-8 JSON bytes, Unicode code points, and array items. */
export const CARD_GET_LIMITS = { bytes: 65536, string: 2048, content: 32768, array: 25, candidates: 5 } as const;
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
const codes = ["validation_error", "not_found", "ambiguous_match", "incomplete_read", "conflict", "out_of_scope", "forbidden", "disabled_by_org", "caller_aborted", "rate_limit_queue_aborted", "request_timeout", "rate_limited", "scan_queue_full", "credential_rate_limited", "response_too_large", "invalid_response_stream", "file_error", "unsupported_token", "credential_profile_mismatch", "personal_token_required", "org_actor_unverified", "authentication_rejected", "account_mismatch", "missing_scope", "api_error", "output_contract_error", "output_too_large"] as const;
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
type ProjectionSchema = TSchema & { anyOf?: ProjectionSchema[]; const?: unknown; type?: string; properties?: Record<string, ProjectionSchema>; items?: ProjectionSchema; maxItems?: number; maxLength?: number };
function project(schema: ProjectionSchema, value: unknown, state: { complete: boolean }): unknown {
  if (value === undefined) return undefined;
  if (schema.anyOf) {
    if (value === null && schema.anyOf.some(s => s.type === "null")) return null;
    const selected = schema.anyOf.some(s => s.type === "null")
      ? schema.anyOf.find(s => s.type !== "null")
      : schema.anyOf.find(s => (s.const === undefined && s.type === typeof value) || Value.Check(s, value));
    if (!selected) throw Error("Invalid union");
    return project(selected, value, state);
  }
  if (schema.const !== undefined) {
    if (value !== schema.const) throw Error("Invalid literal");
    return value;
  }
  if (schema.type === "object") {
    const source = record(value);
    if (!source) throw Error("Invalid object");
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(schema.properties as Record<string, TSchema>)) {
      const item = project(child, source[key], state);
      if (item !== undefined) output[key] = item;
    }
    return output;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw Error("Invalid array");
    if (value.length > schema.maxItems) state.complete = false;
    return value.slice(0, schema.maxItems).map(item => project(schema.items, item, state));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") throw Error("Invalid string");
    const points = Array.from(value);
    if (points.length > schema.maxLength) state.complete = false;
    return points.slice(0, schema.maxLength).join("");
  }
  if (!Value.Check(schema, value)) throw Error("Invalid scalar");
  return value;
}
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
export { project as projectBoundedValue, codes as CODECKS_READ_ERROR_CODES };
