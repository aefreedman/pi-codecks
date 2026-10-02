import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { CODECKS_READ_ERROR_CODES, projectBoundedValue } from "../../contracts/common";
import type { CodecksStructuredOutput } from "../../pi/tool-definition";

export const REPORTS_READ_LIMITS = { bytes: 65536, string: 2048, runs: 500, warnings: 500 } as const;
export const obj = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
export const str = () => Type.String({ maxLength: REPORTS_READ_LIMITS.string });
export const ref = () => Type.String({ minLength: 1, maxLength: 2048, "x-reference": true });
export const num = () => Type.Number();
export const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
export const optional = (schema: TSchema) => Type.Optional(schema);
export const list = (schema: TSchema, maxItems = 500) => Type.Array(schema, { maxItems });
const stats = obj({ count: num(), effort: num(), noEffort: num() });
const observation = obj({ count: nullable(num()), effort: nullable(num()), noEffort: nullable(num()), effortStatus: Type.Union([Type.Literal("observed"), Type.Literal("missing_finish_stats"), Type.Literal("missing_done_bucket"), Type.Literal("missing_estimate")]) });
const rawScalar = Type.Union([nullable(num()), Type.Boolean()]);
const rawDone = nullable(obj({ count: optional(rawScalar), effort: optional(rawScalar), noEffort: optional(rawScalar) }));
const entry = obj({ rawDone: optional(rawDone), runId: optional(nullable(ref())), accountSeq: optional(nullable(Type.Integer({ minimum: 0 }))), customLabel: optional(nullable(str())), startDate: optional(nullable(str())), endDate: optional(nullable(str())), completedAt: optional(nullable(str())), finishStatsPresence: Type.Union([Type.Literal("missing"), Type.Literal("null"), Type.Literal("present")]), observedDone: observation, runWide: observation, current: optional(nullable(stats)), calculatedDelivered: stats, source: str() });
const shared = { visibility: Type.Literal("token_visible_account_runs_snapshot"), scope: Type.Union([Type.Literal("run"), Type.Literal("user")]), userId: nullable(ref()), userLabel: nullable(str()), sprintConfig: str(), completedRuns: num(), matchedCompletedRuns: num(), candidateRuns: num(), totals: stats, runs: list(entry), returned: num() };
export const REPORTS_ERROR_SCHEMA = obj({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(code => Type.Literal(code))), message: str(), candidates: optional(list(obj({ id: optional(nullable(ref())), name: optional(nullable(str())), fullName: optional(nullable(str())) }), 5)) });
export const REPORTS_COMPLETENESS_SCHEMA = obj({ projection: Type.Boolean() });
export function envelope(action: string, data: TSchema, effects?: TSchema) {
 const base = { schemaVersion: Type.Literal(1), action: Type.Literal(action), completeness: REPORTS_COMPLETENESS_SCHEMA, warnings: list(str()), ...(effects ? { effects } : {}) };
 return Type.Union([obj({ ...base, ok: Type.Literal(true), data }), obj({ ...base, ok: Type.Literal(false), error: REPORTS_ERROR_SCHEMA })]);
}
export const RUN_DELIVERED_OUTPUT_SCHEMA = envelope("run-delivered-effort", obj(shared));
export const RUN_AVERAGE_OUTPUT_SCHEMA = envelope("run-average-effort", obj({ ...shared, consideredRuns: num(), minDeliveredEffort: num(), includedRunCount: num(), filteredRunCount: num(), includedRuns: list(entry), filteredRuns: optional(list(entry)), averageEffort: num(), averageDoneCards: num() }));

// Identities and artifact references must fail rather than become clipped usable references.
function checkReferences(schema: any, value: any): void {
 if (value === undefined || value === null) return;
 if (schema["x-reference"] && (typeof value !== "string" || Array.from(value).length > schema.maxLength)) throw Error("Invalid reference");
 if (schema.anyOf) { for (const variant of schema.anyOf) { if (variant.type === "object" && value && typeof value === "object") { const literals = Object.entries(variant.properties ?? {}).filter(([, s]: any) => s.const !== undefined); if (literals.every(([k, s]: any) => value[k] === s.const)) checkReferences(variant, value); } else if (variant.type === typeof value) checkReferences(variant, value); } }
 if (schema.type === "object") for (const [key, child] of Object.entries(schema.properties)) checkReferences(child, value?.[key]);
 if (schema.type === "array" && Array.isArray(value)) for (const item of value) checkReferences(schema.items, item);
}
export function projectReportsOutput(schema: TSchema, action: string, native: unknown, bytes: number, effects?: Record<string, unknown>): CodecksStructuredOutput {
 let code = "output_contract_error";
 try {
  checkReferences(schema, native);
  const state = { complete: true };
  const result: any = projectBoundedValue(schema, native, state);
  result.completeness.projection = state.complete;
  if (!Value.Check(schema, result)) throw Error("Invalid producer data");
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > bytes) { code = "output_too_large"; throw Error("Output byte ceiling"); }
  return result as CodecksStructuredOutput;
 } catch {
  return { schemaVersion: 1, action, ok: false, completeness: { projection: false }, warnings: [], error: { code, message: code === "output_too_large" ? "Report output exceeds its UTF-8 byte ceiling." : "Report producer data failed its output contract." }, ...(effects ? { effects } : {}) };
 }
}
export const projectRunDeliveredOutput = (native: unknown) => projectReportsOutput(RUN_DELIVERED_OUTPUT_SCHEMA, "run-delivered-effort", native, REPORTS_READ_LIMITS.bytes);
export const projectRunAverageOutput = (native: unknown) => projectReportsOutput(RUN_AVERAGE_OUTPUT_SCHEMA, "run-average-effort", native, REPORTS_READ_LIMITS.bytes);
