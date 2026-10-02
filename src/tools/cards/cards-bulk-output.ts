import { Type } from 'typebox';
import { closed, string, nullable, optional, count, reference, errorSchema, record, safeError, bounded, byteBudget, pick } from './cards-output-primitives';
import { CARD_WRITE_REQUEST_SCHEMA } from './cards-write-output';
import type { CodecksStructuredOutput } from '../../pi/tool-definition';
export const CARDS_BULK_LIMITS = { bytes: 2097152, records: 100, string: 2048, events: 500 } as const;
const index = () => Type.Integer({ minimum: 0, maximum: 99 });
const fingerprint = () => Type.String({ pattern: '^[a-f0-9]{64}$', minLength: 64, maxLength: 64 });
const certainty = Type.Union(['not_dispatched','dispatch_returned','possibly_applied','definitely_rejected','definitely_unsent'].map(value => Type.Literal(value)));
const status = Type.Union(['preview','ready','created','updated','invalid','failed','indeterminate','definitely_unsent'].map(value => Type.Literal(value)));
const identitySchema = closed({ cardId: optional(nullable(reference())), accountSeq: optional(nullable(count())) });
const result = closed({ index: index(), correlationKey: optional(nullable(string(200))), actionKey: optional(reference()), normalizedRequestedFingerprint: optional(fingerprint()), status, certainty, requested: optional(CARD_WRITE_REQUEST_SCHEMA), targetId: optional(nullable(Type.Union([reference(), Type.Number()]))), updatedFields: optional(Type.Array(string(), { maxItems: 30 })), identity: optional(identitySchema), error: optional(errorSchema), replay: Type.Literal('not_authorized'), verificationState: optional(Type.Union(['not_applicable','not_performed'].map(value => Type.Literal(value)))), omittedEvidence: optional(Type.Array(string(64), { maxItems: 9 })) });
const range = nullable(closed({ startIndex: index(), endIndex: index() }));
const retryEvent = closed({ index: index(), retryAttempt: count(), retryAfterMs: Type.Number({ minimum: 0, maximum: 15000 }), retryAfterFormat: optional(Type.Union([Type.Literal('codecks_milliseconds'), Type.Literal('http_date')])) });
const rateEvent = closed({ ...retryEvent.properties, retryAttempted: Type.Boolean(), retryAfterMs: optional(retryEvent.properties.retryAfterMs), retryAfterParseStatus: optional(string()), retryAfterReason: optional(string()), reason: string() });
const metrics = closed({ elapsedMs: count(), physicalRequests: count(), normalizationRequests: count(), dispatchRequests: count(), uniqueRecordsAttempted: count(), localGateWaitMs: count(), serverCooldownWaitMs: count(), consecutive429: count(), maxConsecutive429: count(), serverRecoveryWaitBudgetMs: count(), retryEvents: Type.Array(retryEvent, { maxItems: CARDS_BULK_LIMITS.events }), rateLimitEvents: Type.Array(rateEvent, { maxItems: CARDS_BULK_LIMITS.events }), safeContinuationRange: range });
const artifact = Type.Union([closed({ path: string(), format: Type.Literal('json'), temporary: Type.Literal(true) }), closed({ unavailable: Type.Literal(true), reason: string() })]);
const metricsSummary = closed({ provenance: Type.Literal('native_metrics_and_derived_event_counts'), ...Object.fromEntries(['elapsedMs','physicalRequests','normalizationRequests','dispatchRequests','uniqueRecordsAttempted','localGateWaitMs','serverCooldownWaitMs','consecutive429','maxConsecutive429','serverRecoveryWaitBudgetMs','retryEventCount','rateLimitEventCount'].map(key => [key, optional(count())])), safeContinuationRange: optional(range), retainedRetryEvents: Type.Literal(0), retainedRateLimitEvents: Type.Literal(0), omittedRetryEvents: optional(count()), omittedRateLimitEvents: optional(count()), omittedDetail: Type.Literal(true) });
const data = closed({ dryRun: optional(Type.Boolean()), count: optional(Type.Integer({ minimum: 0, maximum: 100 })), created: optional(count()), updated: optional(count()), applied: optional(count()), failed: optional(count()), indeterminate: optional(count()), definitelyUnsent: optional(count()), pending: optional(count()), invalidRecordCount: optional(count()), complete: optional(Type.Boolean()), normalizationComplete: optional(Type.Boolean()), applyComplete: optional(nullable(Type.Boolean())), continueOnError: optional(Type.Boolean()), ambiguousMutationsRetried: optional(Type.Literal(false)), previewFingerprint: optional(fingerprint()), actualPreviewFingerprint: optional(fingerprint()), requestsAttempted: optional(count()), dispatchRequests: optional(count()), recordCount: optional(count()), metrics: optional(metrics), metricsSummary: optional(metricsSummary), omittedEvidence: optional(Type.Array(string(64), { maxItems: 16 })), omittedEvidenceCount: optional(count()), results: Type.Array(result, { maxItems: CARDS_BULK_LIMITS.records }), artifact: optional(artifact) });
const successData = closed({ ...data.properties, dryRun: Type.Boolean(), count: Type.Integer({ minimum: 1, maximum: 100 }), metrics, artifact });
function schema(action: string) {
 const common = { schemaVersion: Type.Literal(1), action: Type.Literal(action), provenance: closed({ source: Type.Literal('codecks'), receipt: Type.Literal('operation_observations') }), projectionComplete: Type.Boolean(), data };
 return Type.Union([closed({ ...common, ok: Type.Literal(true), data: successData }), closed({ ...common, ok: Type.Literal(false), error: errorSchema })]);
}
export const CARD_BULK_CREATE_OUTPUT_SCHEMA = schema('card_bulk_create');
export const CARD_BULK_UPDATE_OUTPUT_SCHEMA = schema('card_bulk_update');
/** Per-record DTO from native working records; no artifact read or rendered-text parsing. */
export function observeBulkResult(value: Record<string, unknown>, requested?: Record<string, unknown>, actionKey?: string) {
 const error = record(value.error);
 const uncertainty = error?.mutationCertainty === 'indeterminate' ? { status: 'indeterminate', certainty: 'possibly_applied' } : value.status === 'invalid' && value.certainty === undefined ? { certainty: 'not_dispatched' } : {};
 return { ...pick(value, ['index','correlationKey','actionKey','normalizedRequestedFingerprint','status','certainty','updatedFields','verificationState']), ...uncertainty, ...(actionKey ? { actionKey } : {}), requested, ...(record(value.target) ? { targetId: (value.target as Record<string, unknown>).cardId } : value.cardId !== undefined ? { targetId: value.cardId } : {}), ...(record(value.card) ? { identity: Object.fromEntries(Object.entries(pick(value.card as Record<string, unknown>, ['cardId','accountSeq'])).filter(([, field]) => field !== null)) } : {}), ...(error ? { error: safeError(error.category, error.message) } : {}), replay: 'not_authorized' };
}
export function projectCardsBulkOutput(payload: unknown, expectedAction?: string): CodecksStructuredOutput {
 const native = record(payload); const action = expectedAction ?? (native?.action === 'card-bulk-create' ? 'card_bulk_create' : 'card_bulk_update'); const schema = action === 'card_bulk_create' ? CARD_BULK_CREATE_OUTPUT_SCHEMA : CARD_BULK_UPDATE_OUTPUT_SCHEMA;
 const base = { schemaVersion: 1, action, provenance: { source: 'codecks', receipt: 'operation_observations' }, projectionComplete: false };
 const nativeData = record(native?.data ?? native?.error);
 const failure = (code = 'output_contract_error'): CodecksStructuredOutput => {
   const source = Array.isArray(nativeData?.results) ? nativeData.results.slice(0, 100) : [];
   const results = source.map((item, i) => {
     const value = record(item); const retained: Record<string, unknown> = {};
     const omitted: string[] = [];
     for (const key of ['correlationKey','actionKey','normalizedRequestedFingerprint','targetId','identity','requested','updatedFields','error','verificationState']) {
       if (value?.[key] === undefined) continue;
       if (key === 'identity' && record(value.identity)) {
         const identity: Record<string, unknown> = {}; let partial = false;
         for (const field of ['cardId','accountSeq']) if ((value.identity as Record<string, unknown>)[field] !== undefined) {
           try { const state = { complete: true }; const projected = bounded(closed({ [field]: identitySchema.properties[field] }), { [field]: (value.identity as Record<string, unknown>)[field] }, state); if (state.complete) Object.assign(identity, projected); else partial = true; } catch { partial = true; }
         }
         retained.identity = identity; if (partial) omitted.push('identity'); continue;
       }
       try { const state = { complete: true }; const field = bounded(closed({ [key]: result.properties[key] }), { [key]: value[key] }, state); if (state.complete && byteBudget(field, 4096)) Object.assign(retained, field); else omitted.push(key); } catch { omitted.push(key); }
     }
     return { index: i, status: typeof value?.status === 'string' && ['preview','ready','created','updated','invalid','failed','indeterminate','definitely_unsent'].includes(value.status) ? value.status : 'indeterminate', certainty: typeof value?.certainty === 'string' && ['not_dispatched','dispatch_returned','possibly_applied','definitely_rejected','definitely_unsent'].includes(value.certainty) ? value.certainty : 'possibly_applied', replay: 'not_authorized', ...retained, ...(omitted.length ? { omittedEvidence: omitted } : {}) };
   });
   let genuineArtifact: unknown;
   try { if (nativeData?.artifact) genuineArtifact = bounded(artifact, nativeData.artifact, { complete: true }); } catch { /* never invent a requested artifact */ }
   const retained: Record<string, unknown> = {}; const omitted: string[] = [];
   for (const key of ['dryRun','count','created','updated','applied','failed','indeterminate','definitelyUnsent','pending','invalidRecordCount','complete','normalizationComplete','applyComplete','continueOnError','ambiguousMutationsRetried','previewFingerprint','actualPreviewFingerprint','requestsAttempted','dispatchRequests','recordCount']) {
     if (nativeData?.[key] === undefined) continue;
     try { const state = { complete: true }; const field = bounded(closed({ [key]: data.properties[key] }), { [key]: nativeData[key] }, state); if (state.complete) Object.assign(retained, field); else omitted.push(key); } catch { omitted.push(key); }
   }
   const sourceMetrics = record(nativeData?.metrics);
   if (sourceMetrics) {
     try { const state = { complete: true }; const projected = bounded(metrics, sourceMetrics, state); if (state.complete && byteBudget(projected, 262144)) retained.metrics = projected; else omitted.push('metrics'); } catch { omitted.push('metrics'); }
     if (!retained.metrics) {
       const summary: Record<string, unknown> = { provenance: 'native_metrics_and_derived_event_counts', omittedDetail: true, retainedRetryEvents: 0, retainedRateLimitEvents: 0 };
       for (const key of Object.keys(metrics.properties)) if (key in sourceMetrics && !['retryEvents','rateLimitEvents','safeContinuationRange'].includes(key) && typeof sourceMetrics[key] === 'number' && Number.isSafeInteger(sourceMetrics[key]) && (sourceMetrics[key] as number) >= 0) summary[key] = sourceMetrics[key];
       for (const [key, target, omitted] of [['retryEvents','retryEventCount','omittedRetryEvents'],['rateLimitEvents','rateLimitEventCount','omittedRateLimitEvents']]) if (Array.isArray(sourceMetrics[key])) { summary[target] = (sourceMetrics[key] as unknown[]).length; summary[omitted] = (sourceMetrics[key] as unknown[]).length; }
       if (sourceMetrics.safeContinuationRange !== undefined) try { summary.safeContinuationRange = bounded(range, sourceMetrics.safeContinuationRange, { complete: true }); } catch { /* unavailable remains absent, never fabricated */ }
       retained.metricsSummary = summary;
     }
   }
   if (nativeData?.artifact !== undefined && !genuineArtifact) omitted.push('artifact');
   if (Array.isArray(nativeData?.results) && nativeData.results.length > source.length) omitted.push('results');
   const candidate = { ...base, ok: false, error: { code, message: 'Structured bulk receipt unavailable; inspect per-record effects and reconcile before another write.' }, data: { ...retained, results, ...(Array.isArray(nativeData?.results) ? { recordCount: nativeData.results.length } : {}), ...(genuineArtifact ? { artifact: genuineArtifact } : {}), ...(omitted.length ? { omittedEvidence: omitted, omittedEvidenceCount: omitted.length } : {}) } };
   const output = bounded(schema, candidate, { complete: true });
   if (byteBudget(output, CARDS_BULK_LIMITS.bytes)) return output as CodecksStructuredOutput;
   delete (candidate.data as Record<string, unknown>).metrics;
   candidate.data.omittedEvidence = [...new Set([...(candidate.data.omittedEvidence ?? []), 'metrics'])];
   const compact = bounded(schema, candidate, { complete: true });
   if (!byteBudget(compact, CARDS_BULK_LIMITS.bytes)) throw Error('Bounded bulk fallback exceeds its byte ceiling.');
   return compact as CodecksStructuredOutput;
 };
 try {
   if (!native || native.action !== action.replaceAll('_', '-') || !['card-bulk-create','card-bulk-update'].includes(String(native.action)) || typeof native.ok !== 'boolean' || !nativeData || !Array.isArray(nativeData.results) || nativeData.results.length > 100) return failure();
   if (nativeData.results.some((value, i) => record(value)?.index !== i)) return failure();
   if (native.ok && nativeData.count !== nativeData.results.length) return failure();
   if (native.ok && nativeData.dryRun === true && typeof nativeData.previewFingerprint !== 'string') return failure();
   const state = { complete: true }; const artifactFailed = record(nativeData.artifact)?.unavailable === true; const hasFailure = artifactFailed || nativeData.results.some(value => { const item = record(value); return !item || ['invalid','failed','indeterminate','definitely_unsent','ready'].includes(String(item.status)); });
   const error = native.ok ? artifactFailed ? { code: 'file_error', message: 'Bulk detail artifact could not be written; inspect indexed tracker outcomes before another write.' } : { code: 'api_error', message: 'One or more bulk records failed or were not dispatched; inspect indexed outcomes.' } : safeError(nativeData.category, nativeData.message);
   const output = bounded(schema, { ...base, projectionComplete: true, ok: native.ok && !hasFailure, data: nativeData, ...(!native.ok || hasFailure ? { error } : {}) }, state);
   output.projectionComplete = state.complete;
   if (!byteBudget(output, CARDS_BULK_LIMITS.bytes)) return failure('output_too_large');
   return output as CodecksStructuredOutput;
 } catch { return failure(); }
}
