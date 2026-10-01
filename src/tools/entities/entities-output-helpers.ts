import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { projectBoundedValue, CODECKS_READ_ERROR_CODES } from "../../contracts/common";
import type { CodecksStructuredOutput } from "../../pi/tool-definition";
import { formatMilestoneUrl, formatRunUrl } from "../../shared/urls";

export const ENTITY_OUTPUT_LIMITS = { bytes: 65536, string: 2048, description: 32768, entities: 500, users: 5000, cards: 500, identity: 128 } as const;
export const closed = (properties: Record<string, TSchema>) => Type.Object(properties, { additionalProperties: false });
export const text = (maxLength: number = ENTITY_OUTPUT_LIMITS.string) => Type.String({ maxLength });
export const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
export const optionalText = () => Type.Optional(nullable(text()));
// Nest multi-scalar alternatives inside nullable so the neutral projector chooses by scalar type.
export const identity = nullable(Type.Union([Type.String({ minLength: 1, maxLength: ENTITY_OUTPUT_LIMITS.identity }), Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })]));
export const sequence = nullable(Type.Union([Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), Type.String({ pattern: "^[0-9]+$", maxLength: 16 })]));
export const projectionSchema = closed({ complete: Type.Boolean() });
export const errorSchema = closed({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(code => Type.Literal(code))), message: text() });

/** Copy observed fields only: never renderer fallbacks or cached summary defaults. */
export function observeEntity(entity: Record<string, unknown>, kind: "deck" | "milestone" | "run" | "user" | "card"): Record<string, unknown> {
  const fields = kind === "deck" ? ["id", "accountSeq", "title", "name", "description", "isDeleted", "status"]
    : kind === "milestone" ? ["id", "accountSeq", "name", "title", "description", "date", "startDate", "color", "isGlobal", "handSyncEnabled", "isDeleted"]
    : kind === "run" ? ["id", "accountSeq", "name", "description", "startDate", "endDate", "isDeleted", "completedAt", "lockedAt", "sprintConfig"]
    : kind === "user" ? ["id", "name", "fullName"] : ["cardId", "accountSeq", "title", "status", "derivedStatus", "isDoc", "sprintId"];
  const facts: Record<string, unknown> = {};
  for (const key of fields) if (entity[key] !== undefined) facts[key] = entity[key];
  if (kind === "run" && facts.sprintConfig && typeof facts.sprintConfig === "object") {
    const config = facts.sprintConfig as Record<string, unknown>;
    facts.sprintConfig = Object.fromEntries(["id", "name", "color"].filter(k => config[k] !== undefined).map(k => [k, config[k]]));
  }
  const seq = typeof entity.accountSeq === "string" && /^\d+$/.test(entity.accountSeq) ? Number(entity.accountSeq) : entity.accountSeq;
  if ((kind === "run" || kind === "milestone") && typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0) {
    facts.reference = { accountSeq: seq, url: kind === "run" ? formatRunUrl(seq) : formatMilestoneUrl(seq) };
  }
  return facts;
}

function checkIdentities(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(checkIdentities); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "reference") {
      const reference = item as { accountSeq?: unknown; url?: unknown };
      if (!reference || typeof reference.accountSeq !== "number" || !Number.isSafeInteger(reference.accountSeq) || reference.accountSeq < 1 || typeof reference.url !== "string" || reference.url.length > 2048 || !/^https:\/\/[a-zA-Z0-9-]+\.codecks\.io\/(sprint|milestones)\/[1-9][0-9]*$/.test(reference.url) || !reference.url.endsWith(`/${reference.accountSeq}`)) throw Error("Invalid reusable reference");
    }
    if (["id", "cardId", "sprintId", "targetId"].includes(key) && !Value.Check(identity, item)) throw Error("Invalid identity");
    if (key === "accountSeq" && !Value.Check(sequence, item)) throw Error("Invalid sequence");
    checkIdentities(item);
  }
}
export function hasEntityByteBudget(value: unknown): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= ENTITY_OUTPUT_LIMITS.bytes; } catch { return false; }
}
export function projectEntityContract(schema: TSchema, payload: unknown, action: string, effect?: Record<string, unknown>): CodecksStructuredOutput {
  const failure = (code: string): CodecksStructuredOutput => ({ version: 1, action, ok: false, error: { code, message: code === "output_too_large" ? "Entity output exceeds its UTF-8 byte budget." : "Entity producer output does not conform to its contract." }, projection: { complete: false }, ...(effect ? { effect } : {}) });
  try {
    checkIdentities(payload);
    const source = payload as { ok?: unknown; data?: Record<string, unknown> };
    if (source?.ok === true && source.data) {
      const data = source.data;
      const validCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
      const rows = data.milestones ?? data.runs;
      if (rows !== undefined && (!Array.isArray(rows) || !validCount(data.sourceCount) || !validCount(data.filteredCount) || !validCount(data.emittedCount) || data.emittedCount !== rows.length || data.sourceCount < data.filteredCount || data.filteredCount < data.emittedCount || data.truncated !== (data.filteredCount > data.emittedCount))) throw Error("Invalid list counts");
      if (data.users !== undefined && (!Array.isArray(data.users) || !validCount(data.candidateCount) || !validCount(data.matchedCount) || !validCount(data.emittedCount) || data.matchedCount !== data.users.length || data.emittedCount !== data.users.length || data.candidateCount < data.matchedCount)) throw Error("Invalid sample counts");
      if (data.cards !== undefined && (!Array.isArray(data.cards) || (data.cardRelation === "observed" ? data.sourceCardCount !== data.cards.length : data.sourceCardCount !== undefined))) throw Error("Invalid relation counts");
    }
    const state = { complete: true };
    const result = projectBoundedValue(schema, payload, state) as CodecksStructuredOutput;
    result.projection = { complete: state.complete };
    if (result.ok && result.data && typeof result.data === "object") {
      const data = result.data as Record<string, unknown>;
      const rows = data.milestones ?? data.runs ?? data.users;
      if (Array.isArray(rows)) data.emittedCount = rows.length;
    }
    if (!Value.Check(schema, result)) return failure("output_contract_error");
    return hasEntityByteBudget(result) ? result : failure("output_too_large");
  } catch { return failure("output_contract_error"); }
}
