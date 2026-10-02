import { Type } from "typebox";
import { Value } from "typebox/value";
import { sanitizeValue } from "../../shared/results";
import { closed, text, nullable, identity, projectionSchema, errorSchema, projectEntityContract } from "./entities-output-helpers";
import { CodecksOperationError } from "../../runtime/operation-error";
export type EntityWriteAction = "deck-update" | "milestone-update" | "run-update";
export const ENTITY_EFFECT_SCHEMA = closed({ certainty: Type.Union([Type.Literal("not_dispatched"), Type.Literal("definitely_rejected"), Type.Literal("dispatch_returned"), Type.Literal("indeterminate")]), readback: Type.Literal(false), replaySafe: Type.Literal(false), targetId: Type.Optional(identity) });
export const ENTITY_WRITE_SCHEMAS = Object.fromEntries((["deck-update", "milestone-update", "run-update"] as const).map(action => {
  const base = { version: Type.Literal(1), action: Type.Literal(action), effect: ENTITY_EFFECT_SCHEMA, projection: projectionSchema };
  const requested = action === "run-update" ? Type.Object({ name: Type.Optional(nullable(text())), description: Type.Optional(text(32768)) }, { additionalProperties: false, minProperties: 1 }) : closed({ description: text(32768) });
  return [action, Type.Union([
    closed({ ...base, effect: closed({ certainty: Type.Literal("dispatch_returned"), readback: Type.Literal(false), replaySafe: Type.Literal(false), targetId: Type.Optional(identity) }), ok: Type.Literal(true), data: closed({ targetId: identity, requested, updatedFields: Type.Array(Type.Union([Type.Literal("name"), Type.Literal("description")]), { minItems: 1, maxItems: 2, uniqueItems: true }), descriptionCleared: Type.Optional(Type.Boolean()), customLabelCleared: Type.Optional(Type.Boolean()) }) }),
    closed({ ...base, ok: Type.Literal(false), error: errorSchema }),
  ])];
})) as unknown as Record<EntityWriteAction, ReturnType<typeof Type.Union>>;
export const DECK_UPDATE_OUTPUT_SCHEMA = ENTITY_WRITE_SCHEMAS["deck-update"];
export const MILESTONE_UPDATE_OUTPUT_SCHEMA = ENTITY_WRITE_SCHEMAS["milestone-update"];
export const RUN_UPDATE_OUTPUT_SCHEMA = ENTITY_WRITE_SCHEMAS["run-update"];
export function entityEffect(certainty: string, targetId?: unknown): Record<string, unknown> {
  return { certainty, readback: false, replaySafe: false, ...(targetId !== undefined && Value.Check(identity, targetId) ? { targetId } : {}) };
}
/** Only canonical transport certainty evidence is consumed, never arbitrary error data. */
export function failedEntityEffect(error: unknown, targetId: unknown, before: number, after: number): Record<string, unknown> {
  const certainty = error instanceof CodecksOperationError ? error.details.mutationCertainty : undefined;
  return entityEffect(certainty === "definitely_rejected" ? "definitely_rejected" : certainty === "indeterminate" || after > before ? "indeterminate" : "not_dispatched", targetId);
}
export function projectEntityWriteOutput(action: EntityWriteAction, payload: unknown) {
  try {
    const candidate = payload && typeof payload === "object" ? (payload as Record<string, unknown>).effect : undefined;
    const effect = Value.Check(ENTITY_EFFECT_SCHEMA, candidate) ? candidate as Record<string, unknown> : entityEffect("indeterminate");
    return projectEntityContract(ENTITY_WRITE_SCHEMAS[action], payload, action, effect);
  } catch {
    return projectEntityContract(ENTITY_WRITE_SCHEMAS[action], undefined, action, entityEffect("indeterminate"));
  }
}
export const entityWriteSuccess = (action: EntityWriteAction, data: Record<string, unknown>, effect: Record<string, unknown>) => ({ version: 1, action, ok: true, data, effect, projection: { complete: true } });
export const entityWriteError = (action: EntityWriteAction, code: string, message: string, effect: Record<string, unknown>) => ({ version: 1, action, ok: false, error: { code, message: sanitizeValue(message) }, effect, projection: { complete: true } });
