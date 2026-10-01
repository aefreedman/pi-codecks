import { Type } from 'typebox';
import { closed, string, nullable, optional, count, reference, scalar, errorSchema, record, safeError, bounded, byteBudget } from './cards-output-primitives';
import type { CodecksStructuredOutput } from '../../pi/tool-definition';
export const CARDS_READ_LIMITS = { bytes: 65536, string: 2048, rows: 3000, queries: 500, reasons: 16 } as const;
const facts = closed({ cardId: optional(reference()), accountSeq: optional(nullable(count())), title: optional(scalar()), status: optional(scalar()), derivedStatus: optional(scalar()), visibility: optional(scalar()), effort: optional(scalar()), isDoc: optional(scalar()), priority: optional(scalar()), sprintId: optional(nullable(reference())), shortCode: optional(reference()), cardRef: optional(reference()), accountSeqRef: optional(reference()) });
const person = closed({ id: optional(nullable(Type.Union([reference(), Type.Number()]))), name: optional(scalar()), fullName: optional(scalar()) });
const relationState = Type.Union(['missing', 'null', 'resolved', 'unresolved'].map(value => Type.Literal(value)));
const event = closed({ activityId: reference(), cardId: reference(), doneAt: string(), fromStatus: string(), toStatus: Type.Literal('done'), activity: closed({ id: optional(scalar()), createdAt: optional(scalar()), type: optional(scalar()) }), transition: closed(Object.fromEntries(['from','old','previous','to','new','next'].map(key => [key, optional(scalar())]))), card: optional(nullable(facts)), changer: optional(nullable(person)), assignee: optional(nullable(person)), deck: optional(nullable(closed({ id: optional(nullable(Type.Union([reference(), Type.Number()]))), title: optional(scalar()), accountSeq: optional(nullable(count())) }))), relations: closed({ card: relationState, changer: relationState, assignee: relationState, deck: relationState }) });
const missingRow = closed({ card: facts, exclusionReasons: Type.Array(string(), { maxItems: CARDS_READ_LIMITS.reasons }) });
const missingData = closed({ visibility: Type.Literal('token_visible_projects_only'), scanned: count(), scannedCards: optional(count()), scanLimit: optional(count()), pageSize: optional(nullable(count())), scanLimitReached: optional(Type.Boolean()), outputLimit: count(), eligibleCount: count(), excludedCount: count(), returnedEligibleCards: count(), returnedExcludedCards: count(), eligibleCards: Type.Array(missingRow, { maxItems: CARDS_READ_LIMITS.rows }), excludedCards: optional(Type.Array(missingRow, { maxItems: CARDS_READ_LIMITS.rows })) });
const doneData = closed({ since: string(), until: string(), mode: Type.Union([Type.Literal('cards'), Type.Literal('events')]), includeArchived: Type.Boolean(), sourceEvents: count(), filteredEvents: count(), matches: count(), returned: count(), scannedActivities: count(), scanLimit: count(), limit: count(), scanLimitReached: Type.Boolean(), truncatedByLimit: Type.Boolean(), items: Type.Array(event, { maxItems: CARDS_READ_LIMITS.rows }) });
const boardData = closed({ requestedCardRef: reference(), resolvedCardId: reference(), status: Type.Union(['available','absent','unsupported','unknown'].map(value => Type.Literal(value))), source: string(), relationState: Type.Union(['missing','null','reference','invalid'].map(value => Type.Literal(value))), referenceObservation: optional(scalar()), capabilities: closed({ visionBoardEnabled: optional(Type.Boolean()) }), visionBoard: optional(nullable(closed({ id: reference(), accountSeq: optional(scalar()), createdAt: optional(scalar()), isDeleted: optional(scalar()), creator: optional(nullable(person)) }))), queryCount: count(), queries: Type.Array(closed({ type: optional(scalar()), createdAt: optional(scalar()), lastUsedAt: optional(scalar()), isStale: optional(scalar()) }), { maxItems: CARDS_READ_LIMITS.queries }) });
const completeness = closed({ read: Type.Union(['complete','incomplete','unknown'].map(value => Type.Literal(value))), projection: Type.Boolean(), emission: Type.Boolean() });
function schema(action: string, data: typeof missingData | typeof doneData | typeof boardData) {
 const common = { schemaVersion: Type.Literal(1), action: Type.Literal(action), provenance: closed({ source: Type.Literal('codecks'), contentTrust: Type.Literal('external'), scope: Type.Literal('token_visible_projects_only') }), completeness, warnings: optional(Type.Array(string(), { maxItems: 16 })) };
 return Type.Union([closed({ ...common, ok: Type.Literal(true), data }), closed({ ...common, ok: Type.Literal(false), error: errorSchema, evidence: optional(closed({ scannedCards: optional(count()), scannedActivities: optional(count()), complete: optional(Type.Boolean()) })) })]);
}
export const CARD_MISSING_EFFORT_OUTPUT_SCHEMA = schema('card_list_missing_effort', missingData);
export const CARD_DONE_TIMEFRAME_OUTPUT_SCHEMA = schema('card_list_done_within_timeframe', doneData);
export const CARD_VISION_BOARD_OUTPUT_SCHEMA = schema('card_get_vision_board', boardData);
const schemas = { 'card-list-missing-effort': CARD_MISSING_EFFORT_OUTPUT_SCHEMA, 'card-list-done-within-timeframe': CARD_DONE_TIMEFRAME_OUTPUT_SCHEMA, 'card-get-vision-board': CARD_VISION_BOARD_OUTPUT_SCHEMA };
export function projectCardsReadOutput(payload: unknown, expectedAction?: string): CodecksStructuredOutput {
 const native = record(payload); const action = typeof native?.action === 'string' && native.action in schemas ? native.action : 'card-list-missing-effort';
 const selected = expectedAction?.replaceAll('_', '-') ?? action;
 const schema = schemas[selected] ?? schemas[action];
 const base = { schemaVersion: 1, action: selected.replaceAll('-', '_'), provenance: { source: 'codecks', contentTrust: 'external', scope: 'token_visible_projects_only' }, completeness: { read: 'unknown', projection: false, emission: false } };
 const failure = (code = 'output_contract_error') => {
   const observations = record(native?.data ?? native?.error);
   const complete = native?.complete ?? observations?.complete;
   const evidence = Object.fromEntries(['scannedCards','scannedActivities'].filter(key => typeof observations?.[key] === 'number' && Number.isSafeInteger(observations[key]) && (observations[key] as number) >= 0).map(key => [key, observations![key]]));
   return { ...base, completeness: { read: complete === true ? 'complete' : complete === false ? 'incomplete' : 'unknown', emission: native?.emissionComplete === true, projection: false }, ok: false, error: { code, message: code === 'output_too_large' ? 'Card read output exceeds its UTF-8 byte budget.' : 'Codecks could not produce valid structured card read output.' }, ...(Object.keys(evidence).length ? { evidence } : {}) } as CodecksStructuredOutput;
 };
 try {
   if (!native || native.action !== selected || !(typeof native.action === 'string' && native.action in schemas) || typeof native.ok !== 'boolean') return failure();
   const data = record(native.ok ? native.data : native.error); if (!data) return failure();
   if (native.ok && selected === 'card-list-missing-effort') {
     if (!Array.isArray(data.eligibleCards) || data.returnedEligibleCards !== data.eligibleCards.length || (data.excludedCards !== undefined && (!Array.isArray(data.excludedCards) || data.returnedExcludedCards !== data.excludedCards.length)) || (data.excludedCards === undefined && data.returnedExcludedCards !== 0) || data.scanned !== (data.eligibleCount as number) + (data.excludedCount as number) || (data.returnedEligibleCards as number) > (data.eligibleCount as number) || (data.returnedExcludedCards as number) > (data.excludedCount as number)) return failure();
   }
   if (native.ok && selected === 'card-list-done-within-timeframe' && (!Array.isArray(data.items) || data.returned !== data.items.length || (data.returned as number) > (data.matches as number) || (data.matches as number) > (data.filteredEvents as number) || (data.filteredEvents as number) > (data.sourceEvents as number))) return failure();
   if (native.ok && selected === 'card-get-vision-board' && (!Array.isArray(data.queries) || data.queryCount !== data.queries.length)) return failure();
   const state = { complete: true };
   const complete = native.complete ?? data.complete;
   const read = complete === true ? 'complete' : complete === false ? 'incomplete' : 'unknown';
   const output = bounded(schema, { ...base, ok: native.ok, completeness: { read, projection: true, emission: native.emissionComplete === true }, ...(native.ok ? { data } : { error: safeError(data.category, data.message), evidence: data }), warnings: native.warnings }, state);
   (output.completeness as Record<string, unknown>).projection = state.complete;
   if (!byteBudget(output, CARDS_READ_LIMITS.bytes)) return failure('output_too_large');
   return output as CodecksStructuredOutput;
 } catch { return failure(); }
}
