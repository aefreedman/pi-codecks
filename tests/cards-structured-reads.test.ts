import assert from 'node:assert/strict';
import test from 'node:test';
import { Value } from 'typebox/value';
import { CARD_TOOL_DEFINITIONS } from '../src/tools/cards/definitions.ts';
import { registerCodecksTool } from '../src/pi/register-tools.ts';
import { projectCardsReadOutput, CARDS_READ_LIMITS } from '../src/tools/cards/cards-read-output.ts';
import { resetRateGate } from '../src/runtime/pacing.ts';
import { useInertEnvironmentCredentialProvider } from './credential-test-environment.ts';
useInertEnvironmentCredentialProvider();
const names = ['card_list_missing_effort','card_list_done_within_timeframe','card_get_vision_board'];
const definition = (name: string) => CARD_TOOL_DEFINITIONS.find(value => value.exportName === name)!;
const registered = (d: any) => { let result: any; registerCodecksTool({ registerTool(value: any) { result = value; } } as any, d, 'fixture', false, () => 'PERSONAL'); return result; };
const execute = (d: any, args: any, signal?: AbortSignal) => registered(d).execute('test', args, signal, undefined, { cwd: process.cwd() });
const original = globalThis.fetch;
const response = (data: unknown) => new Response(JSON.stringify({ data }));
const fields = { cardId: 'c', accountSeq: 0, title: '', content: '', status: 'not_started', effort: null, isDoc: false, visibility: 'default', 'count:childCards': 0 };
function fixture() {
 const requests: any[] = [];
 globalThis.fetch = (async (_url, init) => {
  const body = JSON.parse(String(init?.body)); requests.push(body); const q = body.query; const text = JSON.stringify(q);
  const accountEntry = q._root?.[0]?.account?.[0]; const relation = accountEntry && Object.keys(accountEntry)[0];
  if (text.includes('activities(')) return response({ _root: { account: { [relation]: ['a'] } }, activity: { a: { id: 'a', createdAt: '2026-04-28T01:00:00Z', type: 'card_update', data: { diff: { status: [null, 'done'] } }, card: 'c', changer: null } }, card: { c: { ...fields, title: null, derivedStatus: null } } });
  if (text.includes('feature') || text.includes('capabilit')) return response({ _root: { account: { visionBoardEnabled: false } } });
  return response({ _root: { account: { ...(relation ? { [relation]: ['c'] } : {}), visionBoardEnabled: false } }, card: { c: { ...fields, visionBoard: null } } });
 }) as typeof fetch;
 return requests;
}
for(const name of names) test(`${name}: direct native and canonical registered execution preserve legacy presentation and exact queries`, async () => {
 const requests = fixture(); const d = definition(name);
 const args = name === 'card_list_done_within_timeframe' ? { since: '2026-04-28T00:00:00Z', until: '2026-04-29T00:00:00Z' } : name === 'card_get_vision_board' ? { cardId: 'seq:0' } : {};
 try {
  for(const format of ['text','json']) {
   requests.length = 0;
   const native = await d.executePayload!({ ...args, format }); const expected = requests.splice(0);
   const dto: any = d.projectOutput!(native.payload); assert.equal(dto.ok, true, JSON.stringify(dto)); assert.equal(Value.Check(d.outputSchema!, dto), true);
   const legacy = await d.tool.execute({ ...args, format }); assert.equal(legacy, native.text); assert.deepEqual(requests.splice(0), expected);
   const result = await execute(d, { ...args, format }); assert.equal(result.isError, false); assert.deepEqual(result.structuredContent, dto); assert.deepEqual(requests.splice(0), expected);
   assert.equal(Value.Check(d.outputSchema!, { ...dto, extra: true }), false);
   if(name === 'card_list_missing_effort') { assert.equal(dto.data.eligibleCards[0].card.effort, null); assert.equal(dto.data.eligibleCards[0].card.isDoc, false); assert.equal(dto.data.eligibleCards[0].card.accountSeq, 0); assert.equal(Object.hasOwn(dto.data.eligibleCards[0].card, 'priority'), false); }
   if(name === 'card_list_done_within_timeframe') { assert.equal(dto.data.items[0].card.title, null); assert.equal(dto.data.items[0].changer, null); assert.equal(dto.data.items[0].transition.from, null); assert.equal(dto.data.sourceEvents, 1); }
   if(name === 'card_get_vision_board') { assert.equal(dto.data.visionBoard, null); assert.equal(Object.hasOwn(dto.data, 'payload'), false); }
  }
 } finally { globalThis.fetch = original; resetRateGate(); }
});
for(const name of names) test(`${name}: declared native errors, missing/malformed output and registered one-invocation failure`, async () => {
 const d = definition(name); let calls = 0;
 for(const category of ['validation_error','not_found','ambiguous_match','incomplete_read','forbidden','caller_aborted','api_error']) {
  const seam = async () => { calls++; return { text: 'legacy failure', payload: { ok: false, action: name.replaceAll('_','-'), error: { category, message: 'fixture' } } }; };
  const result = await execute({ ...d, executePayload: seam }, {}); assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, category); assert.equal(Value.Check(d.outputSchema!, result.structuredContent), true);
 }
 assert.equal(calls, 7);
 for(const payload of [undefined, {}, { ok: true, action: name.replaceAll('_','-'), data: {} }]) {
  const result = await execute({ ...d, executePayload: async () => ({ text: 'misleading', payload }) }, {}); assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'output_contract_error');
 }
});
test('missing-effort partial scan differs from emission and complete-empty; UTF-8 clipping/overflow and bad identities fail safely', async () => {
 const requests = fixture(); const d = definition(names[0]);
 try {
  const native = await d.executePayload!({ scanLimit: 1, pageSize: 1 }); const partial: any = projectCardsReadOutput(native.payload); assert.equal(partial.ok, true); assert.equal(partial.completeness.read, 'incomplete'); assert.equal(requests.length, 1);
  const source: any = structuredClone(native.payload); source.data.eligibleCards[0].card.title = '😀'.repeat(2049);
  const clipped: any = projectCardsReadOutput(source); assert.equal(clipped.ok, true); assert.equal(clipped.completeness.projection, false); assert.equal(Array.from(clipped.data.eligibleCards[0].card.title).length, 2048);
  source.data.eligibleCards[0].card.cardId = 'x'.repeat(129); assert.equal((projectCardsReadOutput(source) as any).error.code, 'output_contract_error');
  source.data.eligibleCards[0].card.cardId = 'c'; source.data.eligibleCards = Array(20).fill(source.data.eligibleCards[0]); source.data.returnedEligibleCards = 20; source.data.eligibleCount = 20; source.data.scanned = 20;
  assert.equal((projectCardsReadOutput(source) as any).error.code, 'output_too_large');
  globalThis.fetch = (async (_url, init) => { const q = JSON.parse(String(init?.body)).query; const key = Object.keys(q._root[0].account[0])[0]; return response({ _root: { account: { [key]: [] } } }); }) as typeof fetch;
  const empty: any = projectCardsReadOutput((await d.executePayload!({})).payload); assert.equal(empty.ok, true); assert.equal(empty.completeness.read, 'complete'); assert.equal(empty.data.eligibleCount, 0);
  const controller = new AbortController(); controller.abort(); const aborted = await execute(d, {}, controller.signal); assert.equal(aborted.isError, true);
  const edge: any = structuredClone(native.payload);
  edge.complete = true; edge.emissionComplete = true;
  edge.data.scanned = 40; edge.data.scannedCards = 40; edge.data.scanLimit = 100; edge.data.eligibleCount = 40; edge.data.returnedEligibleCards = 40;
  edge.data.eligibleCards = Array.from({ length: 40 }, () => ({ card: { cardId: 'c', title: '' }, exclusionReasons: [] }));
  let remaining = CARDS_READ_LIMITS.bytes - Buffer.byteLength(JSON.stringify(projectCardsReadOutput(edge)));
  for(const row of edge.data.eligibleCards) { const amount = Math.min(2048, remaining); row.card.title = 'x'.repeat(amount); remaining -= amount; }
  assert.equal(remaining, 0);
  const exact: any = projectCardsReadOutput(edge); assert.equal(exact.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(exact)), CARDS_READ_LIMITS.bytes);
  edge.data.eligibleCards.find((row: any) => row.card.title.length < 2048).card.title += 'x';
  assert.equal((projectCardsReadOutput(edge) as any).error.code, 'output_too_large');
  assert.equal(CARDS_READ_LIMITS.bytes, 65536);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
test('done-history retains occurrence-specific raw facts, dedupe/source/emitted counts and current-versus-historical status', async () => {
 const requests: any[] = [];
 globalThis.fetch = (async (_url, init) => {
  const q = JSON.parse(String(init?.body)).query; requests.push(q); const key = Object.keys(q._root[0].account[0])[0];
  return response({ _root: { account: { [key]: ['new','old'] } }, activity: { new: { id: 'new', createdAt: '2026-04-28T02:00:00Z', data: { diff: { status: ['started',' DONE '] } }, card: 'c', changer: null }, old: { id: 'old', createdAt: '2026-04-28T01:00:00Z', data: { diff: { status: [null,'done'] } }, card: 'c' } }, card: { c: { cardId: 'c', title: null, status: 'not_started', effort: 0 } } });
 }) as typeof fetch;
 try {
  const d = definition('card_list_done_within_timeframe'); const args = { since: '2026-04-28T00:00:00Z', until: '2026-04-29T00:00:00Z', mode: 'events', limit: 1 };
  let result = await execute(d, args); let dto = result.structuredContent; assert.equal(dto.ok, true); assert.equal(dto.data.sourceEvents, 2); assert.equal(dto.data.filteredEvents, 2); assert.equal(dto.data.matches, 2); assert.equal(dto.data.returned, 1); assert.equal(dto.completeness.emission, false); assert.equal(dto.data.items[0].activityId, 'new'); assert.equal(dto.data.items[0].transition.to, ' DONE '); assert.equal(dto.data.items[0].card.status, 'not_started');
  result = await execute(d, { ...args, mode: 'cards' }); dto = result.structuredContent; assert.equal(dto.data.sourceEvents, 2); assert.equal(dto.data.matches, 1); assert.equal(dto.completeness.emission, true); assert.equal(requests.length, 2);
  result = await execute(d, { ...args, limit: 2 }); dto = result.structuredContent; assert.equal(dto.data.items[1].relations.changer, 'missing'); assert.equal(dto.data.items[0].relations.changer, 'null'); assert.equal(requests.length, 3);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
test('vision native metadata preserves absent/null/falsy; includePayload remains exclusively legacy and malformed presence is unknown', async () => {
 const requests: any[] = []; let presence: unknown = 'board';
 globalThis.fetch = (async (_url, init) => {
  const q = JSON.parse(String(init?.body)).query; requests.push(q); const text = JSON.stringify(q); const entry = q._root?.[0]?.account?.[0]; const key = entry && Object.keys(entry)[0];
  if(text.includes('visionBoardQueries(')) return response({ _root: { account: { [key]: ['query'] } }, visionBoardQuery: { query: { type: false, createdAt: null, isStale: false, query: 'raw legacy only', payload: { arbitrary: 'never a DTO' }, card: 'c' } } });
  if(Object.keys(q).some(key => key.startsWith('visionBoard('))) return response({ visionBoard: { board: { accountSeq: 0, isDeleted: false, creator: { id: 'u', name: null } } } });
  if(text.includes('visionBoardEnabled')) return response({ _root: { account: { visionBoardEnabled: false } } });
  return response({ _root: { account: { [key]: ['c'] } }, card: { c: { cardId: 'c', accountSeq: 0, visionBoard: presence } } });
 }) as typeof fetch;
 try {
  const d = definition('card_get_vision_board'); const result = await execute(d, { cardId: 'seq:0', includePayload: true, format: 'json' }); const dto = result.structuredContent;
  assert.equal(dto.ok, true); assert.equal(dto.data.visionBoard.accountSeq, 0); assert.equal(dto.data.visionBoard.isDeleted, false); assert.equal(dto.data.visionBoard.creator.name, null); assert.equal(Object.hasOwn(dto.data.visionBoard, 'createdAt'), false); assert.equal(dto.data.queries[0].type, false); assert.equal(dto.data.queries[0].createdAt, null); assert.equal(dto.data.queries[0].isStale, false); assert.equal(Object.hasOwn(dto.data.queries[0], 'lastUsedAt'), false); assert.doesNotMatch(JSON.stringify(dto), /raw legacy only|arbitrary|payload/); assert.match(result.content[0].text, /raw legacy only/); assert.equal(requests.length, 4);
  for(const value of [undefined, false]) { presence = value; const result = await execute(d, { cardId: 'seq:0' }); assert.equal(result.structuredContent.data.status, 'unknown'); assert.equal(result.structuredContent.completeness.read, 'unknown'); if(value === false) assert.equal(result.structuredContent.data.referenceObservation, false); }
 } finally { globalThis.fetch = original; resetRateGate(); }
});
