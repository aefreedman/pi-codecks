import { Type } from 'typebox';
import { closed, string, nullable, optional, count, reference, errorSchema, record, pick, safeError, bounded, byteBudget } from './cards-output-primitives';
import { runDispatch } from '../../runtime/transport';
import { getOperationContext } from '../../runtime/operation-context';
import { getOperationErrorData, sanitizeValue, toStructuredResult, toStructuredErrorResult, type OutputFormat, type ErrorCategory } from '../../shared/results';
import type { CodecksOperationPayload, CodecksStructuredOutput } from '../../pi/tool-definition';
export const CARDS_WRITE_LIMITS = { bytes: 65536, string: 2048, content: 32768, tags: 100, handEntries: 500 } as const;
export const CARD_WRITE_ACTIONS = ['card_create','card_set_parent','card_update_run','card_add_attachment','card_update','card_update_status','card_add_to_hand','card_remove_from_hand','card_update_effort','card_update_priority'] as const;
const id = () => nullable(Type.Union([reference(), Type.Number()]));
export const CARD_WRITE_REQUEST_SCHEMA = closed({ title: optional(nullable(string())), content: optional(nullable(string(CARDS_WRITE_LIMITS.content))), deckId: optional(id()), milestoneId: optional(id()), assigneeId: optional(id()), parentCardId: optional(id()), sprintId: optional(id()), effort: optional(nullable(Type.Number())), priority: optional(nullable(string())), status: optional(string()), isDoc: optional(Type.Boolean()), putOnHand: optional(Type.Boolean()), masterTags: optional(Type.Array(string(), { maxItems: CARDS_WRITE_LIMITS.tags })), cardIds: optional(Type.Array(reference(), { maxItems: CARDS_WRITE_LIMITS.handEntries })), draggedCardIds: optional(Type.Array(reference(), { maxItems: 1 })), userId: optional(id()) });
const certaintySchema = Type.Union(['definitely_unsent','definitely_rejected','dispatch_returned','possibly_applied'].map(value => Type.Literal(value)));
const uploadSchema = closed({ signing: Type.Union(['not_attempted','requested','returned','failed'].map(value => Type.Literal(value))), storage: Type.Union(['not_attempted','possibly_uploaded','uploaded'].map(value => Type.Literal(value))), registration: Type.Union(['not_attempted','possibly_applied','dispatch_returned','definitely_rejected','definitely_unsent'].map(value => Type.Literal(value))), fileName: optional(string()), size: optional(count()), type: optional(string()) });
const handEntrySchema = closed({ cardId: reference(), sortIndex: Type.Number() });
const handSchema = closed({ targetId: optional(id()), actorId: optional(id()), cardId: optional(reference()), before: optional(Type.Array(handEntrySchema, { maxItems: CARDS_WRITE_LIMITS.handEntries })), immediate: optional(Type.Array(handEntrySchema, { maxItems: CARDS_WRITE_LIMITS.handEntries })), after: optional(Type.Array(handEntrySchema, { maxItems: CARDS_WRITE_LIMITS.handEntries })), readbackConfirmed: optional(Type.Boolean()), drift: optional(Type.Boolean()), previousEntryCount: optional(count()), resultingEntryCount: optional(count()) });
const effectSchema = closed({ certainty: certaintySchema, readback: Type.Union(['not_performed','confirmed','unconfirmed'].map(value => Type.Literal(value))), replay: Type.Literal('not_authorized'), dispatchInvoked: Type.Boolean(), targetId: optional(id()), requested: optional(CARD_WRITE_REQUEST_SCHEMA), actionKey: optional(reference()), identity: optional(closed({ cardId: optional(reference()), accountSeq: optional(count()) })), upload: optional(uploadSchema), hand: optional(handSchema), omittedEvidence: optional(Type.Array(Type.Union(['targetId','actionKey','identity','requested','upload','hand','certainty','readback','dispatchInvoked'].map(value => Type.Literal(value))), { maxItems: 9 })) });
const schemas = Object.fromEntries(CARD_WRITE_ACTIONS.map(action => {
 const common = { schemaVersion: Type.Literal(1), action: Type.Literal(action), provenance: closed({ source: Type.Literal('codecks'), receipt: Type.Literal('operation_observations') }), projectionComplete: Type.Boolean(), effects: effectSchema };
 return [action, Type.Union([closed({ ...common, ok: Type.Literal(true), effects: closed({ ...effectSchema.properties, certainty: Type.Literal('dispatch_returned'), dispatchInvoked: Type.Literal(true) }) }), closed({ ...common, ok: Type.Literal(false), error: errorSchema })])];
}));
export const CARD_WRITE_OUTPUT_SCHEMAS = schemas;
/** Native operation-owned receipt collector; it delegates transport exactly once and never retries. */
export async function executeLegacyCardWrite(operation: (args: Record<string, any>, onLegacyError?: (error: unknown) => void) => Promise<CodecksOperationPayload>, args: Record<string, any>): Promise<string> {
 let escaped = false; let originalError: unknown;
 const result = await operation(args, error => { if (!escaped) { escaped = true; originalError = error; } });
 if (escaped) throw originalError;
 return result.text;
}
export function createCardWriteProducer(onLegacyError?: (error: unknown) => void) {
 const effects: Record<string, unknown> = { certainty: 'definitely_unsent', readback: 'not_performed', replay: 'not_authorized', dispatchInvoked: false };
 const dispatch: typeof runDispatch = async (...args) => {
   effects.dispatchInvoked = true;
   effects.requested = pick(args[1], Object.keys(CARD_WRITE_REQUEST_SCHEMA.properties));
   const dispatchedBefore = getOperationContext()?.requestsDispatched;
   const target = args[1].id ?? args[1].cardId; if (target !== undefined) effects.targetId = target;
   effects.certainty = 'possibly_applied';
   try { const response = await runDispatch(...args); effects.certainty = 'dispatch_returned'; if (record(effects.upload)) (effects.upload as Record<string, unknown>).registration = 'dispatch_returned'; return response; }
   catch (error) {
     const evidence = getOperationErrorData(error);
     effects.certainty = dispatchedBefore !== undefined && getOperationContext()?.requestsDispatched === dispatchedBefore ? 'definitely_unsent' : evidence.mutationCertainty === 'definitely_rejected' ? 'definitely_rejected' : evidence.requestSent === false || evidence.dispatchAttempt === 'not_sent' || evidence.dispatchAttempt === 'not_dispatched' ? 'definitely_unsent' : 'possibly_applied';
     if (record(effects.upload)) (effects.upload as Record<string, unknown>).registration = effects.certainty;
     throw error;
   }
 };
 const success = (format: OutputFormat, action: string, text: string, data: Record<string, unknown>, warnings?: string[], hint?: string): CodecksOperationPayload => {
   try { return { text: toStructuredResult(format, action, text, data, warnings, hint), payload: { ok: true, action, effects } }; }
   catch (error) { onLegacyError?.(error); return { text: 'Mutation presentation unavailable; reconcile observed effects before another write.', payload: { ok: false, action, error: { category: 'output_contract_error', message: 'Mutation presentation could not be serialized.' }, effects } }; }
 };
 const failure = (format: OutputFormat, action: string, category: ErrorCategory, message: string, data?: Record<string, unknown>): CodecksOperationPayload => {
   let text: string;
   try { text = toStructuredErrorResult(format, action, category, message, data); }
   catch (error) { onLegacyError?.(error); text = sanitizeValue(message); }
   return { text, payload: { ok: false, action, error: { category, message: sanitizeValue(message) }, effects } };
 };
 return { effects, dispatch, success, failure };
}
export function projectCardsWriteOutput(payload: unknown, expectedAction?: string): CodecksStructuredOutput {
 const native = record(payload); const name = typeof native?.action === 'string' ? native.action.replaceAll('-', '_') : ''; const action = expectedAction ?? (name in schemas ? name : 'card_update');
 const base = { schemaVersion: 1, action, provenance: { source: 'codecks', receipt: 'operation_observations' }, projectionComplete: false };
 // Contract failure preserves bounded effect evidence. Unknown/malformed effects NEVER prove unsent.
 const minimalEffects = () => {
   const evidence = record(native?.effects);
   const upload = record(evidence?.upload);
   const hand = record(evidence?.hand);
   const safeRef = (value: unknown) => (typeof value === 'string' && value.length > 0 && !/\s/.test(value) && Array.from(value).length <= 128) || (typeof value === 'number' && Number.isFinite(value)) ? value : undefined;
   const safeUpload = upload && typeof upload.signing === 'string' && typeof upload.storage === 'string' && typeof upload.registration === 'string' && ['not_attempted','requested','returned','failed'].includes(upload.signing) && ['not_attempted','possibly_uploaded','uploaded'].includes(upload.storage) && ['not_attempted','possibly_applied','dispatch_returned','definitely_rejected','definitely_unsent'].includes(upload.registration) ? pick(upload, ['signing','storage','registration']) : undefined;
   const safeHand = hand ? { ...(safeRef(hand.targetId) !== undefined ? { targetId: safeRef(hand.targetId) } : {}), ...(safeRef(hand.actorId) !== undefined ? { actorId: safeRef(hand.actorId) } : {}), ...(typeof hand.cardId === 'string' && safeRef(hand.cardId) !== undefined ? { cardId: hand.cardId } : {}), ...(typeof hand.drift === 'boolean' ? { drift: hand.drift } : {}), ...(typeof hand.readbackConfirmed === 'boolean' ? { readbackConfirmed: hand.readbackConfirmed } : {}), ...(Array.isArray(hand.before) ? { previousEntryCount: hand.before.length } : {}), ...(Array.isArray(hand.after) ? { resultingEntryCount: hand.after.length } : {}) } : undefined;
   const nativeIdentity = record(evidence?.identity);
   const identity = nativeIdentity ? { ...(typeof nativeIdentity.cardId === 'string' && safeRef(nativeIdentity.cardId) !== undefined ? { cardId: nativeIdentity.cardId } : {}), ...(typeof nativeIdentity.accountSeq === 'number' && Number.isSafeInteger(nativeIdentity.accountSeq) && nativeIdentity.accountSeq >= 0 ? { accountSeq: nativeIdentity.accountSeq } : {}) } : undefined;
   const requested: Record<string, unknown> = {}; let omittedRequested = false;
   const nativeRequested = record(evidence?.requested);
   if (nativeRequested) for (const [key, schema] of Object.entries(CARD_WRITE_REQUEST_SCHEMA.properties)) {
     if (nativeRequested[key] === undefined) continue;
     try { const state = { complete: true }; const field = bounded(closed({ [key]: schema }), { [key]: nativeRequested[key] }, state); if (state.complete && byteBudget(field, 4096)) Object.assign(requested, field); else omittedRequested = true; }
     catch { omittedRequested = true; }
   }
   const result: Record<string, unknown> = { ...(safeRef(evidence?.targetId) !== undefined ? { targetId: safeRef(evidence?.targetId) } : {}), ...(typeof evidence?.actionKey === 'string' && safeRef(evidence.actionKey) !== undefined ? { actionKey: evidence.actionKey } : {}), ...(identity ? { identity } : {}), ...(Object.keys(requested).length ? { requested } : {}), ...(safeUpload ? { upload: safeUpload } : {}), ...(safeHand ? { hand: safeHand } : {}), certainty: typeof evidence?.certainty === 'string' && ['definitely_unsent','definitely_rejected','dispatch_returned','possibly_applied'].includes(evidence.certainty) ? evidence.certainty : 'possibly_applied', readback: typeof evidence?.readback === 'string' && ['confirmed','not_performed','unconfirmed'].includes(evidence.readback) ? evidence.readback : 'unconfirmed', replay: 'not_authorized', dispatchInvoked: typeof evidence?.dispatchInvoked === 'boolean' ? evidence.dispatchInvoked : true };
   const omitted = ['targetId','actionKey','identity','requested','upload','hand','certainty','readback','dispatchInvoked'].filter(key => evidence?.[key] !== undefined && (result[key] === undefined || (key === 'requested' && omittedRequested) || (key === 'identity' && nativeIdentity && Object.keys(nativeIdentity).some(field => identity?.[field] === undefined)) || key === 'hand' || key === 'upload'));
   if (omitted.length) result.omittedEvidence = omitted;
   return result;
 };
 const failure = (code = 'output_contract_error'): CodecksStructuredOutput => {
   let effects: unknown = minimalEffects();
   try { const state = { complete: true }; const projected = bounded(effectSchema, native?.effects, state); if (byteBudget(projected, 49152)) effects = projected; } catch { /* bounded certainty above remains authoritative only to observed extent */ }
   const candidate = { ...base, ok: false, error: { code, message: 'Structured card mutation receipt unavailable; inspect effects and reconcile before another write.' }, effects };
   try { const result = bounded(schemas[action], candidate, { complete: true }); if (byteBudget(result, CARDS_WRITE_LIMITS.bytes)) return result as CodecksStructuredOutput; } catch { /* last-resort bounded certainty remains an error, never permission to replay */ }
   const compact = minimalEffects(); delete compact.requested; compact.omittedEvidence = [...new Set([...(compact.omittedEvidence as string[] ?? []), 'requested'])];
   const final = bounded(schemas[action], { ...candidate, effects: compact }, { complete: true });
   if (byteBudget(final, CARDS_WRITE_LIMITS.bytes)) return final as CodecksStructuredOutput;
   const terminal = bounded(schemas[action], { ...candidate, effects: pick(compact, ['certainty','readback','replay','dispatchInvoked','targetId','actionKey','identity','omittedEvidence']) }, { complete: true });
   if (!byteBudget(terminal, CARDS_WRITE_LIMITS.bytes)) throw Error('Bounded mutation fallback exceeds its byte ceiling.');
   return terminal as CodecksStructuredOutput;
 };
 try {
   if (!native || name !== action || !(name in schemas) || typeof native.ok !== 'boolean') return failure();
   const error = record(native.error); const state = { complete: true };
   const output = bounded(schemas[action], { ...base, ok: native.ok, projectionComplete: true, effects: native.effects, ...(!native.ok ? { error: safeError(error?.category, error?.message) } : {}) }, state);
   output.projectionComplete = state.complete;
   if (!byteBudget(output, CARDS_WRITE_LIMITS.bytes)) return failure('output_too_large');
   return output as CodecksStructuredOutput;
 } catch { return failure(); }
}
