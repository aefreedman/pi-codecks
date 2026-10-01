import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CODECKS_READ_LIMITS, projectBoundedValue, CODECKS_READ_ERROR_CODES } from "./contracts/common";

export const CARD_SEARCH_LIMITS = { ...CODECKS_READ_LIMITS, rows: 3000, facets: 3000, tags: 3000 } as const;
const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const str = () => Type.String({ maxLength: CARD_SEARCH_LIMITS.string });
const opt = (s: TSchema) => Type.Optional(Type.Union([s, Type.Null()]));
const strings = (keys: string[]) => Object.fromEntries(keys.map(k => [k, opt(str())]));
const count = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const relation = obj({ ...strings(["id", "cardId", "title", "name", "fullName"]), accountSeq: opt(count()) });
const row = obj({ ...strings(["cardId", "shortCode", "cardRef", "accountSeqRef", "url", "title", "status", "derivedStatus", "visibility", "priority", "lastUpdatedAt", "dueDate"]), accountSeq: opt(count()), isDoc: opt(Type.Boolean()), effort: opt(Type.Number()), childCount: opt(count()), tags: opt(Type.Array(str(), { maxItems: CARD_SEARCH_LIMITS.tags })), deck: opt(relation), milestone: opt(relation), assignee: opt(relation), parentCard: opt(relation) });
const criteria = obj({ ...strings(["title", "text", "searchIn", "cardCode", "location", "outputMode"]), ...Object.fromEntries(["deck", "milestone", "userId"].map(k => [k, opt(Type.Union([str(), Type.Number()]))])), ...Object.fromEntries(["limit", "scanLimit", "pageSize"].map(k => [k, opt(count())])), includeArchived: opt(Type.Boolean()), includeDone: opt(Type.Boolean()) });
const metrics = { scannedCards: opt(count()), scanLimit: opt(count()), pageSize: opt(count()), requestsAttempted: opt(count()), queueWaitMs: opt(Type.Number({ minimum: 0 })), elapsedMs: opt(Type.Number({ minimum: 0 })), scanLimitReached: opt(Type.Boolean()) };
// Facets describe legacy aggregate buckets (including inferred/unknown buckets), not field observations.
const facetFields = ["status", "derivedStatus", "deck", "milestone", "assignee", "effort", "priority", "cardType"] as const;
const facet = obj({ field: Type.Union(facetFields.map(field => Type.Literal(field))), value: str(), count: count() });
const dataSchema = obj({ matches: count(), rawMatches: count(), returnedCards: count(), outputMode: Type.Union([Type.Literal("compact"), Type.Literal("detailed"), Type.Literal("counts")]), visibility: Type.Literal("token_visible_projects_only"), ...metrics, truncated: opt(Type.Boolean()), truncatedByOutputLimit: opt(Type.Boolean()), criteria, cards: Type.Optional(Type.Array(row, { maxItems: CARD_SEARCH_LIMITS.rows })), sampleCards: Type.Optional(Type.Array(row, { maxItems: 10 })), facets: Type.Optional(Type.Array(facet, { maxItems: CARD_SEARCH_LIMITS.facets })), facetBucketCount: Type.Optional(count()), facetSemantics: Type.Optional(Type.Literal("legacy_inferred_buckets")), emittedRows: count(), rowsExhaustive: Type.Boolean() });
const common = { schemaVersion: Type.Literal(1), action: Type.Literal("card_search"), provenance: obj({ source: Type.Literal("codecks"), contentTrust: Type.Literal("external") }), completeness: obj({ read: Type.Union([Type.Literal("complete"), Type.Literal("incomplete"), Type.Literal("unknown")]), projection: Type.Boolean() }) };
const evidence = obj({ ...metrics, criteria: Type.Optional(criteria), recoveryHint: opt(str()) });
export const CARD_SEARCH_OUTPUT_SCHEMA = Type.Union([obj({ ...common, ok: Type.Literal(true), data: dataSchema }), obj({ ...common, ok: Type.Literal(false), error: obj({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(c => Type.Literal(c))), message: str() }), evidence: Type.Optional(evidence) })]);
export type CardSearchOutput = Static<typeof CARD_SEARCH_OUTPUT_SCHEMA>;
const record = (v: unknown): Record<string, any> | undefined => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : undefined;
const base = (read: "complete" | "incomplete" | "unknown", projection = true) => ({ schemaVersion: 1, action: "card_search", provenance: { source: "codecks", contentTrust: "external" }, completeness: { read, projection } });
export function cardSearchContractError(code: "output_contract_error" | "output_too_large" = "output_contract_error"): CardSearchOutput {
  return { ...base("unknown", false), ok: false, error: { code, message: code === "output_too_large" ? "Search data exceeds the structured output byte budget." : "Codecks could not produce valid structured search output." } } as CardSearchOutput;
}
export function isCardSearchOutput(value: unknown): value is CardSearchOutput {
  try { return Value.Check(CARD_SEARCH_OUTPUT_SCHEMA, value) && Buffer.byteLength(JSON.stringify(value), "utf8") <= CARD_SEARCH_LIMITS.bytes; } catch { return false; }
}
export function projectCardSearchOutput(payload: unknown): CardSearchOutput {
  try {
    const source = record(payload);
    if (!source || source.action !== "card-search" || typeof source.ok !== "boolean") return cardSearchContractError();
    const state = { complete: true };
    let output: unknown;
    if (source.ok) {
      const native = record(source.data);
      if (!native || typeof native.complete !== "boolean") return cardSearchContractError();
      const rows = native.outputMode === "counts" ? native.sampleCards ?? native.cards : native.cards;
      if (!Array.isArray(rows)) return cardSearchContractError();
      const facets = native.facets === undefined ? undefined : Object.entries(record(native.facets) ?? (() => { throw Error("Invalid facets"); })()).flatMap(([field, buckets]) => {
        if (!facetFields.includes(field as typeof facetFields[number]) || !record(buckets)) throw Error("Invalid facets");
        return Object.entries(buckets).map(([value, count]) => ({ field, value, count }));
      });
      const data = projectBoundedValue(dataSchema, { ...native, ...(facets ? { facets, facetBucketCount: facets.length, facetSemantics: "legacy_inferred_buckets" } : {}), emittedRows: rows.length, rowsExhaustive: false }, state) as Record<string, any>;
      data.emittedRows = (data.cards ?? data.sampleCards ?? []).length;
      data.rowsExhaustive = native.outputMode === "detailed" && native.complete && !native.truncated && native.matches === data.emittedRows && native.rawMatches === native.matches && native.returnedCards === data.emittedRows && state.complete;
      output = { ...base(native.complete ? "complete" : "incomplete", state.complete), ok: true, data };
    } else {
      const error = record(source.error);
      if (!error || typeof error.category !== "string" || typeof error.message !== "string") return cardSearchContractError();
      const code = CODECKS_READ_ERROR_CODES.includes(error.category as any) ? error.category : "api_error";
      const safeEvidence = projectBoundedValue(evidence, error, state) as Record<string, unknown>;
      output = { ...base(error.complete === false || code === "incomplete_read" ? "incomplete" : "unknown", state.complete), ok: false, error: { code, message: projectBoundedValue(str(), error.message, state) }, ...(Object.keys(safeEvidence).length ? { evidence: safeEvidence } : {}) };
      (output as any).completeness.projection = state.complete;
    }
    if (Buffer.byteLength(JSON.stringify(output), "utf8") > CARD_SEARCH_LIMITS.bytes) return cardSearchContractError("output_too_large");
    return isCardSearchOutput(output) ? output : cardSearchContractError();
  } catch { return cardSearchContractError(); }
}
