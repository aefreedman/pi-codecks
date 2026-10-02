import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CARD_GET_OUTPUT_SCHEMA, projectCardGetOutput, isCardGetOutput, cardGetContractError } from "../../card-get-output";
import { CODECKS_READ_ERROR_CODES, CODECKS_READ_LIMITS, projectBoundedValue } from "../../contracts/common";

export const CARD_GET_BATCH_LIMITS = { bytes: 2097152, items: 25, reference: 128, string: CODECKS_READ_LIMITS.string } as const;
const object = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const count = () => Type.Integer({ minimum: 0, maximum: CARD_GET_BATCH_LIMITS.items });
const errorSchema = object({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(code => Type.Literal(code))), message: Type.String({ maxLength: CARD_GET_BATCH_LIMITS.string }) });
const ref = { requestedRef: Type.String({ minLength: 1, maxLength: CARD_GET_BATCH_LIMITS.reference }) };
const itemSchema = Type.Union([
  object({ ...ref, status: Type.Literal("found"), card: CARD_GET_OUTPUT_SCHEMA.anyOf[0] }),
  object({ ...ref, status: Type.Literal("missing") }),
  object({ ...ref, status: Type.Literal("failed") }),
  object({ ...ref, status: Type.Literal("unqueried") }),
  object({ ...ref, status: Type.Literal("projection_error"), error: CARD_GET_OUTPUT_SCHEMA.anyOf[1] }),
]);
const dataSchema = object({
  requested: Type.Integer({ minimum: 1, maximum: CARD_GET_BATCH_LIMITS.items }),
  uniqueReferences: Type.Optional(Type.Integer({ minimum: 1, maximum: CARD_GET_BATCH_LIMITS.items })),
  // Source counts are absent on failed lookups, not fabricated zeroes.
  found: Type.Optional(count()), missing: Type.Optional(count()),
  projectedFound: count(), projectionErrors: count(),
  items: Type.Array(itemSchema, { minItems: 1, maxItems: CARD_GET_BATCH_LIMITS.items }),
});
const successDataSchema = object({ ...dataSchema.properties, uniqueReferences: Type.Integer({ minimum: 1, maximum: CARD_GET_BATCH_LIMITS.items }), found: count(), missing: count() });
const common = {
  schemaVersion: Type.Literal(1), action: Type.Literal("card_get_batch"),
  provenance: object({ source: Type.Literal("codecks"), contentTrust: Type.Literal("external") }),
  completeness: object({ read: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("unknown")]), projection: Type.Boolean() }),
};
export const CARD_GET_BATCH_OUTPUT_SCHEMA = Type.Union([
  object({ ...common, ok: Type.Literal(true), data: successDataSchema }),
  object({ ...common, ok: Type.Literal(false), error: errorSchema, data: Type.Optional(dataSchema) }),
]);
export type CardGetBatchOutput = Static<typeof CARD_GET_BATCH_OUTPUT_SCHEMA>;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const base = (read: "complete" | "incomplete" | "unknown", projection: boolean) => ({ schemaVersion: 1 as const, action: "card_get_batch" as const, provenance: { source: "codecks" as const, contentTrust: "external" as const }, completeness: { read, projection } });
export function cardGetBatchContractError(code: "output_contract_error" | "output_too_large" = "output_contract_error"): CardGetBatchOutput {
  return { ...base("unknown", false), ok: false, error: { code, message: code === "output_too_large" ? "Batch data exceeds the structured output byte budget." : "Codecks could not produce valid structured batch output." } } as CardGetBatchOutput;
}
export function hasCardGetBatchByteBudget(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= CARD_GET_BATCH_LIMITS.bytes; }
  catch { return false; }
}
export function isCardGetBatchOutput(value: unknown): value is CardGetBatchOutput {
  try {
    if (!Value.Check(CARD_GET_BATCH_OUTPUT_SCHEMA, value) || !hasCardGetBatchByteBudget(value)) return false;
    const data = record(record(value)?.data);
    return !data || (data.items as Record<string, unknown>[]).every(item => item.status === "found" ? isCardGetOutput(item.card) : item.status === "projection_error" ? isCardGetOutput(item.error) : true);
  } catch { return false; }
}
// Native reusable identities fail explicitly rather than becoming clipped references.
function hasOversizedIdentity(value: unknown): boolean {
  const source = record(value);
  if (!source) return Array.isArray(value) && value.some(hasOversizedIdentity);
  return Object.entries(source).some(([key, item]) => (["id", "cardId", "shortCode", "cardRef", "accountSeqRef", "url"].includes(key) && typeof item === "string" && Array.from(item).length > CODECKS_READ_LIMITS.string) || hasOversizedIdentity(item));
}

/** Pure native-result projection. Never parses text or makes requests. */
export function projectCardGetBatchOutput(payload: unknown): CardGetBatchOutput {
  try {
    const source = record(payload);
    if (!source || source.action !== "card-get-batch" || typeof source.ok !== "boolean") return cardGetBatchContractError();
    const native = record(source.ok ? source.data : source.error);
    if (!native) return cardGetBatchContractError();
    const state = { complete: true };
    let error: unknown;
    if (!source.ok) {
      if (typeof native.category !== "string" || typeof native.message !== "string") return cardGetBatchContractError();
      error = projectBoundedValue(errorSchema, { code: CODECKS_READ_ERROR_CODES.includes(native.category as typeof CODECKS_READ_ERROR_CODES[number]) ? native.category : "api_error", message: native.message }, state);
    }
    let data: unknown;
    if (native.items !== undefined) {
      if (!Array.isArray(native.items) || native.items.length < 1 || native.items.length > CARD_GET_BATCH_LIMITS.items || native.requested !== native.items.length) return cardGetBatchContractError();
      let found = 0, missing = 0, projectedFound = 0, projectionErrors = 0;
      const items = native.items.map(value => {
        const item = record(value);
        // Reusable input identities are never clipped.
        if (!item || typeof item.requestedRef !== "string" || !item.requestedRef || item.requestedRef.length > CARD_GET_BATCH_LIMITS.reference) throw Error("Invalid batch identity");
        if (item.status === "found" && source.ok) {
          found++;
          const card = hasOversizedIdentity(item.card) ? cardGetContractError() : projectCardGetOutput({ ok: true, action: "card-get", data: { card: item.card } });
          if (card.ok) {
            projectedFound++;
            if (!card.completeness.projection) state.complete = false;
            return { requestedRef: item.requestedRef, status: "found", card };
          }
          projectionErrors++;
          state.complete = false;
          return { requestedRef: item.requestedRef, status: "projection_error", error: card };
        }
        if (item.status === "missing" && source.ok) { missing++; return { requestedRef: item.requestedRef, status: "missing" }; }
        if (!source.ok && (item.status === "failed" || item.status === "unqueried")) return { requestedRef: item.requestedRef, status: item.status };
        throw Error("Invalid batch status");
      });
      if (source.ok && (native.complete !== true || native.found !== found || native.missing !== missing || !Number.isSafeInteger(native.uniqueReferences) || (native.uniqueReferences as number) < 1 || (native.uniqueReferences as number) > native.items.length)) return cardGetBatchContractError();
      data = { requested: native.requested, ...(source.ok ? { uniqueReferences: native.uniqueReferences, found, missing } : {}), projectedFound, projectionErrors, items };
      if (projectionErrors) error = { code: "output_contract_error", message: "One or more found cards could not be projected; inspect projection_error items." };
    } else if (source.ok) return cardGetBatchContractError();
    const output = { ...base(source.ok ? "complete" : native.complete === false ? "incomplete" : "unknown", state.complete), ok: !error, ...(error ? { error } : {}), ...(data ? { data } : {}) };
    if (!hasCardGetBatchByteBudget(output)) return cardGetBatchContractError("output_too_large");
    return isCardGetBatchOutput(output) ? output : cardGetBatchContractError();
  } catch { return cardGetBatchContractError(); }
}
