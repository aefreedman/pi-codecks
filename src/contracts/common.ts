import { type TSchema } from "typebox";
import { Value } from "typebox/value";

/** Shared v1 UTF-8 JSON byte and Unicode code-point bounds. */
export const CODECKS_READ_LIMITS = { bytes: 65536, string: 2048 } as const;

/** Shared v1 read-contract vocabulary and schema-directed bounded projection. */
export const CODECKS_READ_ERROR_CODES = ["validation_error", "not_found", "ambiguous_match", "incomplete_read", "conflict", "out_of_scope", "forbidden", "disabled_by_org", "caller_aborted", "rate_limit_queue_aborted", "request_timeout", "rate_limited", "scan_queue_full", "credential_rate_limited", "response_too_large", "invalid_response_stream", "file_error", "unsupported_token", "credential_profile_mismatch", "personal_token_required", "org_actor_unverified", "authentication_rejected", "account_mismatch", "missing_scope", "api_error", "output_contract_error", "output_too_large"] as const;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export type ProjectionSchema = TSchema & { anyOf?: ProjectionSchema[]; const?: unknown; type?: string; properties?: Record<string, ProjectionSchema>; items?: ProjectionSchema; maxItems?: number; maxLength?: number };
export function projectBoundedValue(schema: ProjectionSchema, value: unknown, state: { complete: boolean }): unknown {
  if (value === undefined) return undefined;
  if (schema.anyOf) {
    if (value === null && schema.anyOf.some(s => s.type === "null")) return null;
    const objects = schema.anyOf.filter(s => s.type === "object");
    const source = record(value);
    // Object variants must select their literal discriminators BEFORE bounded clipping.
    // Full Value.Check would incorrectly reject otherwise projectable long fields.
    const selected = objects.length > 1 && source
      ? objects.find(s => {
          const literals = Object.entries(s.properties ?? {}).filter(([, child]) => child.const !== undefined);
          return literals.length > 0 && literals.every(([key, child]) => source[key] === child.const);
        })
      : schema.anyOf.some(s => s.type === "null")
        ? schema.anyOf.find(s => s.type !== "null")
        : schema.anyOf.find(s => (s.const === undefined && s.type === typeof value) || Value.Check(s, value));
    if (!selected) throw Error("Invalid union");
    return projectBoundedValue(selected, value, state);
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
      const item = projectBoundedValue(child, source[key], state);
      if (item !== undefined) output[key] = item;
    }
    return output;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw Error("Invalid array");
    if (value.length > schema.maxItems) state.complete = false;
    return value.slice(0, schema.maxItems).map(item => projectBoundedValue(schema.items, item, state));
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
