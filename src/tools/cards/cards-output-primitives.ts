import { Type, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { CODECKS_READ_ERROR_CODES, projectBoundedValue } from '../../contracts/common';
export const closed = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const string = (maxLength = 2048) => Type.String({ maxLength });
export const nullable = (schema: TSchema) => Type.Union([schema, Type.Null()]);
export const optional = (schema: TSchema) => Type.Optional(schema);
export const count = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const reference = () => Type.String({ minLength: 1, maxLength: 128, pattern: '^\\S+$' });
export const scalar = () => nullable(Type.Union([string(), Type.Number(), Type.Boolean()]));
export const errorSchema = closed({ code: Type.Union(CODECKS_READ_ERROR_CODES.map(code => Type.Literal(code))), message: string() });
export const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
export const pick = (source: Record<string, unknown> | undefined, keys: string[]) => Object.fromEntries(keys.filter(key => source?.[key] !== undefined).map(key => [key, source![key]]));
export function safeError(category: unknown, message: unknown) {
  return { code: CODECKS_READ_ERROR_CODES.includes(category as any) ? category : 'api_error', message };
}
/** Domain-local resource check. References must not turn into clipped identities. */
export function invalidIdentity(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(invalidIdentity);
  const source = record(value);
  return !!source && Object.entries(source).some(([key, item]) =>
    (['cardIds', 'draggedCardIds'].includes(key) && Array.isArray(item) && item.some(value => typeof value !== 'string' || value.length === 0 || /\s/.test(value) || Array.from(value).length > 128)) || (/^(?:id|cardId|activityId|resolvedCardId|targetId|requestedCardRef|shortCode|cardRef|accountSeqRef|actionKey|previewFingerprint|actualPreviewFingerprint|normalizedRequestedFingerprint|path|userId|actorId|sprintId|deckId|milestoneId|assigneeId|parentCardId)$/.test(key) && typeof item === 'string' && Array.from(item).length > (key === 'path' ? 2048 : 128)) || invalidIdentity(item));
}
export function byteBudget(value: unknown, bytes: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= bytes; } catch { return false; }
}
export function bounded(schema: TSchema, value: unknown, state: { complete: boolean }): Record<string, unknown> {
  if (invalidIdentity(value)) throw Error('Invalid identity');
  const output = projectBoundedValue(schema, value, state);
  if (!Value.Check(schema, output)) throw Error('Invalid output');
  return output as Record<string, unknown>;
}
