import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Value } from 'typebox/value';
import { CARD_TOOL_DEFINITIONS } from '../src/tools/cards/definitions.ts';
import { registerCodecksTool } from '../src/pi/register-tools.ts';
import { CARD_WRITE_ACTIONS, CARDS_WRITE_LIMITS, projectCardsWriteOutput, executeLegacyCardWrite, createCardWriteProducer } from '../src/tools/cards/cards-write-output.ts';
import { resetRateGate } from '../src/runtime/pacing.ts';
import { runWithAbortSignal, getOperationContext } from '../src/runtime/operation-context.ts';
import { useInertEnvironmentCredentialProvider } from './credential-test-environment.ts';
useInertEnvironmentCredentialProvider();
const original = globalThis.fetch;
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const definition = (name: string) => CARD_TOOL_DEFINITIONS.find(d => d.exportName === name)!;
const execute = (d: any, args: any, signal?: AbortSignal) => { let tool: any; registerCodecksTool({ registerTool(value: any) { tool = value; } } as any, d, 'fixture', false, () => 'PERSONAL'); return tool.execute('test', args, signal, undefined, { cwd: process.cwd() }); };
function fixture(options: { failure?: number | 'network'; drift?: boolean; readbackFailure?: boolean; storageFailure?: boolean; snapshotChange?: () => Promise<void> } = {}) {
 const requests: any[] = []; let hand = ['before']; let handReads = 0;
 globalThis.fetch = (async (url, init) => {
  assert.ok(getOperationContext(), 'native operations share canonical operation scope');
  const address = String(url);
  if(address.includes('/s3/sign')) { requests.push({ upload: 'sign' }); await options.snapshotChange?.(); return new Response(JSON.stringify({ signedUrl: 'https://storage.invalid/upload', fields: { key: 'fixture' }, publicUrl: 'https://storage.invalid/file' })); }
  if(address.includes('storage.invalid/upload')) { requests.push({ upload: 'storage' }); return new Response('', { status: options.storageFailure ? 503 : 200 }); }
  const body = JSON.parse(String(init?.body)); requests.push({ url: address.slice(address.indexOf('/dispatch/')), body });
  if(address.includes('/dispatch/')) {
   if(options.failure === 'network') throw Error('fixture network failure');
   if(typeof options.failure === 'number') return response({}, options.failure);
   if(address.endsWith('setCardOrders')) hand = body.cardIds;
   if(address.endsWith('removeCards')) hand = hand.filter(id => !body.cardIds.includes(id));
   return response({ cardId: 'created', accountSeq: 0 });
  }
  const q = body.query; const text = JSON.stringify(q); const entry = q._root?.[0]?.account?.[0]; const key = entry && Object.keys(entry)[0];
  if(text.includes('loggedInUser')) return response({ _root: { loggedInUser: { id: 'u', name: 'fixture' } } });
  if(text.includes('queueEntries(')) {
   handReads++;
   if(options.readbackFailure && handReads > 2) return response({}, 403);
   const members = options.drift && handReads === 2 ? ['drift'] : hand;
   return response({ _root: { account: { [key]: members } }, queueEntry: Object.fromEntries(members.map((id, i) => ['e'+i, { cardId: id, sortIndex: i, user: { id: 'u' } }])) });
  }
  return response({ _root: { account: { ...(key ? { [key]: ['c'] } : {}) } }, card: { c: { cardId: 'c', accountSeq: 0, title: 'fixture', content: 'fixture\nbody', status: 'not_started', isDoc: false, effort: 0, deck: { id: 'd', title: 'Deck' }, resolvables: [] } } });
 }) as typeof fetch;
 return { requests, setHand: (value: string[]) => { hand = value; handReads = 0; } };
}
const argsFor = (name: string, filePath: string) => ({ card_create: { title: 'Created', effort: 0, putOnHand: false }, card_set_parent: { cardId: 'seq:0' }, card_update_run: { cardId: 'seq:0', clearRun: true }, card_add_attachment: { cardId: 'seq:0', filePath }, card_update: { cardId: 'seq:0', title: '', tags: [] }, card_update_status: { cardId: 'seq:0', status: 'completed' }, card_add_to_hand: { cardId: 'seq:0' }, card_remove_from_hand: { cardId: 'seq:0' }, card_update_effort: { cardId: 'seq:0', effort: 0 }, card_update_priority: { cardId: 'seq:0', priority: 'none' } }[name]);
const stable = (requests: any[]) => requests.map(request => { const clone = structuredClone(request); if(clone.body) delete clone.body.sessionId; return clone; });
for(const name of CARD_WRITE_ACTIONS) test(`${name}: real direct native / legacy / canonical adapter parity and factual receipt`, async () => {
 const directory = await mkdtemp(join(process.cwd(), '.cards-structured-write-')); const filePath = join(directory, 'proof.txt'); await writeFile(filePath, 'fixture');
 const mock = fixture(); const d = definition(name); const args = argsFor(name, filePath)!;
 const prepare = () => { mock.requests.length = 0; mock.setHand(name === 'card_remove_from_hand' ? ['before','c'] : ['before']); };
 try {
  for(const format of ['text','json']) {
   prepare(); const native = await d.executePayload!({ ...args, format }); const dto: any = d.projectOutput!(native.payload); const expected = stable(mock.requests);
   assert.equal(dto.ok, true, JSON.stringify(dto)); assert.equal(Value.Check(d.outputSchema!, dto), true); assert.equal(dto.effects.certainty, 'dispatch_returned'); assert.equal(dto.effects.replay, 'not_authorized');
   prepare(); assert.equal(await d.tool.execute({ ...args, format }), native.text); assert.deepEqual(stable(mock.requests), expected);
   prepare(); const result = await execute(d, { ...args, format }); assert.equal(result.isError, false); assert.deepEqual(result.structuredContent, dto); assert.deepEqual(stable(mock.requests), expected);
   assert.equal(mock.requests.filter(request => request.url?.startsWith('/dispatch/')).length, 1);
   assert.equal(Value.Check(d.outputSchema!, { ...dto, arbitrary: true }), false);
   if(name === 'card_update_effort') assert.equal(dto.effects.requested.effort, 0);
   if(name === 'card_update_priority') assert.equal(dto.effects.requested.priority, null);
   if(name === 'card_update_run') assert.equal(dto.effects.requested.sprintId, null);
   if(name === 'card_set_parent') assert.equal(dto.effects.requested.parentCardId, null);
   if(name === 'card_create') { assert.equal(dto.effects.requested.putOnHand, false); assert.equal(dto.effects.identity.accountSeq, 0); }
   if(name.includes('_hand')) { assert.equal(dto.effects.hand.readbackConfirmed, true); assert.equal(dto.effects.readback, 'confirmed'); assert.equal(dto.effects.hand.drift, false); }
   if(name === 'card_add_attachment') { assert.equal(dto.effects.upload.storage, 'uploaded'); assert.equal(dto.effects.upload.registration, 'dispatch_returned'); assert.doesNotMatch(JSON.stringify(dto), /storage.invalid|signedUrl|fileUrl/); }
  }
 } finally { globalThis.fetch = original; resetRateGate(); await rm(directory, { recursive: true, force: true }); }
});
for(const name of CARD_WRITE_ACTIONS) test(`${name}: one post-send attempt, definite rejection versus unknown mutation without replay`, async () => {
 const directory = await mkdtemp(join(process.cwd(), '.cards-structured-error-')); const filePath = join(directory, 'proof.txt'); await writeFile(filePath, 'fixture');
 try {
  for(const failure of [400,503,'network'] as const) {
   const mock = fixture({ failure }); mock.setHand(name === 'card_remove_from_hand' ? ['before','c'] : ['before']);
   const result = await execute(definition(name), argsFor(name, filePath)); const dto = result.structuredContent;
   assert.equal(result.isError, true); assert.equal(dto.ok, false); assert.equal(dto.effects.certainty, failure === 400 ? 'definitely_rejected' : 'possibly_applied'); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 1); assert.equal(dto.effects.replay, 'not_authorized');
  }
 } finally { globalThis.fetch = original; resetRateGate(); await rm(directory, { recursive: true, force: true }); }
});
test('Hand baseline drift sends nothing; failed readback retains returned dispatch and explicit unconfirmed evidence', async () => {
 try {
  let mock = fixture({ drift: true }); let result = await execute(definition('card_add_to_hand'), { cardId: 'seq:0' }); assert.equal(result.isError, true); assert.equal(result.structuredContent.effects.certainty, 'definitely_unsent'); assert.equal(result.structuredContent.effects.hand.drift, true); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 0);
  mock = fixture({ readbackFailure: true }); result = await execute(definition('card_add_to_hand'), { cardId: 'seq:0' }); assert.equal(result.isError, true); assert.equal(result.structuredContent.effects.certainty, 'dispatch_returned'); assert.equal(result.structuredContent.effects.readback, 'unconfirmed'); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 1);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
test('attachment snapshot change/storage failure preserve actual phases without card registration', async () => {
 const directory = await mkdtemp(join(process.cwd(), '.cards-structured-upload-')); const filePath = join(directory, 'proof.txt'); await writeFile(filePath, 'fixture');
 try {
  for(const scenario of ['snapshot','storage']) {
   const mock = fixture(scenario === 'snapshot' ? { snapshotChange: () => writeFile(filePath, 'changed') } : { storageFailure: true });
   const result = await execute(definition('card_add_attachment'), { cardId: 'seq:0', filePath }); assert.equal(result.isError, true); assert.equal(result.structuredContent.effects.certainty, 'definitely_unsent'); assert.equal(result.structuredContent.effects.upload.signing, 'returned'); assert.equal(result.structuredContent.effects.upload.storage, scenario === 'snapshot' ? 'not_attempted' : 'possibly_uploaded'); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 0);
  }
 } finally { globalThis.fetch = original; resetRateGate(); await rm(directory, { recursive: true, force: true }); }
});
test('malformed/missing receipts, clipping and output-byte failure after a write never erase certainty or authorize replay', () => {
 for(const name of CARD_WRITE_ACTIONS) {
  const payload: any = { ok: true, action: name.replaceAll('_','-'), effects: { certainty: 'dispatch_returned', dispatchInvoked: true, replay: 'not_authorized', readback: 'not_performed', requested: { content: '😀'.repeat(32769) } } };
  let dto: any = projectCardsWriteOutput(payload); assert.equal(dto.ok, false); assert.equal(dto.error.code, 'output_too_large'); assert.equal(dto.effects.certainty, 'dispatch_returned'); assert.equal(dto.effects.replay, 'not_authorized');
  payload.effects.requested = { title: '😀'.repeat(2049), effort: 0, parentCardId: null, putOnHand: false };
  dto = projectCardsWriteOutput(payload); assert.equal(dto.ok, true); assert.equal(dto.projectionComplete, false); assert.equal(Array.from(dto.effects.requested.title).length, 2048); assert.equal(dto.effects.requested.effort, 0); assert.equal(dto.effects.requested.parentCardId, null); assert.equal(dto.effects.requested.putOnHand, false);
  payload.effects.targetId = 'x'.repeat(129); dto = projectCardsWriteOutput(payload); assert.equal(dto.ok, false); assert.equal(dto.effects.certainty, 'dispatch_returned');
  dto = projectCardsWriteOutput({ ok: true, action: name.replaceAll('_','-') }); assert.equal(dto.ok, false); assert.equal(dto.effects.certainty, 'possibly_applied'); assert.equal(Value.Check(definition(name).outputSchema!, dto), true);
 }
 const edge: any = { ok: true, action: 'card-update', effects: { certainty: 'dispatch_returned', dispatchInvoked: true, readback: 'not_performed', replay: 'not_authorized', requested: { content: '', title: '' } } };
 let remaining = CARDS_WRITE_LIMITS.bytes - Buffer.byteLength(JSON.stringify(projectCardsWriteOutput(edge)));
 edge.effects.requested.content = '😀'.repeat(Math.floor(remaining / 4));
 edge.effects.requested.title = 'x'.repeat(remaining % 4);
 const exact: any = projectCardsWriteOutput(edge); assert.equal(exact.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(exact)), CARDS_WRITE_LIMITS.bytes);
 edge.effects.requested.title += 'x'; const overflow: any = projectCardsWriteOutput(edge); assert.equal(overflow.error.code, 'output_too_large'); assert.equal(overflow.effects.certainty, 'dispatch_returned');
 const uploadFailure: any = projectCardsWriteOutput({ ...edge, action: 'card-add-attachment', effects: { ...edge.effects, targetId: 'x'.repeat(129), upload: { signing: 'returned', storage: 'uploaded', registration: 'dispatch_returned' }, hand: { before: [{ cardId: 'x'.repeat(129), sortIndex: 0 }], drift: false, readbackConfirmed: false } } });
 assert.equal(uploadFailure.ok, false); assert.equal(uploadFailure.effects.upload.storage, 'uploaded'); assert.equal(uploadFailure.effects.hand.previousEntryCount, 1); assert.equal(uploadFailure.effects.hand.drift, false);
 assert.equal(CARDS_WRITE_LIMITS.bytes, 65536);
});
for(const name of CARD_WRITE_ACTIONS.filter(name => !name.includes('_hand'))) test(`${name}: formerly escaping lookup failure retains legacy rejection identity but native seam returns an error receipt`, async () => {
 const originalError = new Error('synthetic lookup failed'); let calls = 0;
 globalThis.fetch = (async () => { calls++; throw originalError; }) as typeof fetch;
 const d = definition(name); const args = name === 'card_create' ? { title: 'fixture', deck: 'Deck' } : argsFor(name, 'not-reached.txt')!;
 try {
  await assert.rejects(() => d.tool.execute(args), error => error === originalError); assert.equal(calls, 1);
  const native = await d.executePayload!(args); const dto: any = d.projectOutput!(native.payload); assert.equal(dto.ok, false); assert.equal(dto.effects.certainty, 'definitely_unsent'); assert.equal(dto.effects.dispatchInvoked, false); assert.equal(calls, 2);
  const result = await execute(d, args); assert.equal(result.isError, true); assert.equal(result.structuredContent.effects.dispatchInvoked, false); assert.equal(calls, 3);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
test('attachment escaping filesystem/containment/snapshot errors preserve original legacy error while native phases remain bounded', async () => {
 const directory = await mkdtemp(join(tmpdir(), 'cards-outside-')); const outsideFile = join(directory, 'proof.txt'); await writeFile(outsideFile, 'fixture');
 const d = definition('card_add_attachment');
 try {
  for(const filePath of [outsideFile, join(process.cwd(), '.cards-missing-file')]) {
   fixture(); let captured: unknown; let invocations = 0;
   const operation = (args: any, onLegacyError?: (error: unknown) => void) => { invocations++; return (d.tool.executePayload as any)(args, (error: unknown) => { captured = error; onLegacyError?.(error); }); };
   await assert.rejects(() => executeLegacyCardWrite(operation, { cardId: 'seq:0', filePath }), error => error === captured); assert.equal(invocations, 1);
   const result = await execute(d, { cardId: 'seq:0', filePath }); assert.equal(result.isError, true); assert.equal(result.structuredContent.effects.certainty, 'definitely_unsent'); assert.equal(result.structuredContent.effects.dispatchInvoked, false);
  }
  const inside = await mkdtemp(join(process.cwd(), '.cards-escaping-snapshot-')); const insideFile = join(inside, 'proof.txt'); await writeFile(insideFile, 'original');
  try {
   fixture({ snapshotChange: () => writeFile(insideFile, 'changed') }); let captured: unknown;
   await assert.rejects(() => executeLegacyCardWrite((args, callback) => (d.tool.executePayload as any)(args, (error: unknown) => { captured = error; callback?.(error); }), { cardId: 'seq:0', filePath: insideFile }), error => error === captured);
  } finally { await rm(inside, { recursive: true, force: true }); }
 } finally { globalThis.fetch = original; resetRateGate(); await rm(directory, { recursive: true, force: true }); }
});
test('post-dispatch serialization exception preserves original legacy rejection and bounded native returned-effect receipt, without replay', async () => {
 const mock = fixture(); let captured: unknown; let invocations = 0;
 const operation = async (_args: any, onLegacyError?: (error: unknown) => void) => {
  invocations++;
  const producer = createCardWriteProducer(error => { captured = error; onLegacyError?.(error); });
  await producer.dispatch('cards/update', { id: 'c', effort: 0 });
  const cycle: any = {}; cycle.self = cycle;
  return producer.success('json', 'card-update', 'not serializable', cycle);
 };
 try {
  await assert.rejects(() => runWithAbortSignal(undefined, () => executeLegacyCardWrite(operation, {})), error => error === captured); assert.equal(invocations, 1); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 1);
  const native = await runWithAbortSignal(undefined, () => operation({})); const dto: any = projectCardsWriteOutput(native.payload); assert.equal(dto.ok, false); assert.equal(dto.error.code, 'output_contract_error'); assert.equal(dto.effects.certainty, 'dispatch_returned'); assert.equal(dto.effects.requested.effort, 0); assert.equal(invocations, 2); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 2);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
test('write contract failure independently retains bounded reconciliation keys, target/created identity and clears, without a second dispatch', async () => {
 const mock = fixture();
 try {
  const native = await runWithAbortSignal(undefined, async () => {
   const producer = createCardWriteProducer(); await producer.dispatch('cards/update', { id: 'c', effort: 0, parentCardId: null });
   producer.effects.actionKey = 'update:0:' + 'a'.repeat(64); producer.effects.identity = { cardId: 'created', accountSeq: 0 };
   (producer.effects.requested as any).content = '😀'.repeat(32768);
   return producer.success('text', 'card-update', 'legacy presentation', {});
  });
  let dto: any = projectCardsWriteOutput(native.payload); assert.equal(dto.ok, false); assert.equal(dto.error.code, 'output_too_large'); assert.equal(dto.effects.certainty, 'dispatch_returned'); assert.equal(dto.effects.actionKey, 'update:0:' + 'a'.repeat(64)); assert.equal(dto.effects.targetId, 'c'); assert.deepEqual(dto.effects.identity, { cardId: 'created', accountSeq: 0 }); assert.equal(dto.effects.requested.effort, 0); assert.equal(dto.effects.requested.parentCardId, null); assert.ok(dto.effects.omittedEvidence.includes('requested')); assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= CARDS_WRITE_LIMITS.bytes); assert.equal(Value.Check(definition('card_update').outputSchema!, dto), true); assert.equal(mock.requests.filter(value => value.url?.startsWith('/dispatch/')).length, 1); assert.equal(native.text, 'legacy presentation');
  const invalid: any = structuredClone(native.payload); invalid.effects.targetId = 'x'.repeat(129); invalid.effects.actionKey = 'x'.repeat(129); invalid.effects.identity.accountSeq = -1; invalid.effects.requested.cardIds = ['x'.repeat(129)];
  dto = projectCardsWriteOutput(invalid); assert.equal(dto.ok, false); assert.equal(dto.effects.targetId, undefined); assert.equal(dto.effects.actionKey, undefined); assert.equal(dto.effects.identity.cardId, 'created'); assert.equal(dto.effects.identity.accountSeq, undefined); assert.ok(dto.effects.omittedEvidence.includes('targetId')); assert.ok(dto.effects.omittedEvidence.includes('identity')); assert.equal(dto.effects.requested.cardIds, undefined); assert.equal(dto.effects.certainty, 'dispatch_returned'); assert.equal(Value.Check(definition('card_update').outputSchema!, dto), true);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
test('all single writes preserve pre-abort native error, zero physical dispatch and caught legacy error text branches', async () => {
 const directory = await mkdtemp(join(process.cwd(), '.cards-abort-fixture-')); const filePath = join(directory, 'proof.txt'); await writeFile(filePath, 'fixture');
 try {
  for(const name of CARD_WRITE_ACTIONS) {
   const mock = fixture(); const controller = new AbortController(); controller.abort();
   const result = await execute(definition(name), argsFor(name, filePath), controller.signal); assert.equal(result.isError, true); assert.equal(result.structuredContent.effects.dispatchInvoked, false); assert.equal(mock.requests.length, 0);
  }
  fixture({ failure: 400 }); const text = await definition('card_update_effort').tool.execute({ cardId: 'seq:0', effort: 0, format: 'json' }); assert.match(text, /"ok": false/);
 } finally { globalThis.fetch = original; resetRateGate(); await rm(directory, { recursive: true, force: true }); }
});
