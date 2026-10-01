import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { Value } from 'typebox/value';
import { CARD_TOOL_DEFINITIONS } from '../src/tools/cards/definitions.ts';
import { registerCodecksTool } from '../src/pi/register-tools.ts';
import { CARDS_BULK_LIMITS, projectCardsBulkOutput } from '../src/tools/cards/cards-bulk-output.ts';
import { resetRateGate } from '../src/runtime/pacing.ts';
import { useInertEnvironmentCredentialProvider } from './credential-test-environment.ts';
useInertEnvironmentCredentialProvider();
const original = globalThis.fetch;
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status });
const definition = (name: string) => CARD_TOOL_DEFINITIONS.find(value => value.exportName === name)!;
const execute = (d: any, args: any, signal?: AbortSignal, onUpdate?: (value: any) => void) => { let tool: any; registerCodecksTool({ registerTool(value: any) { tool = value; } } as any, d, 'fixture', false, () => 'PERSONAL'); return tool.execute('test', args, signal, onUpdate, { cwd: process.cwd() }); };
const artifacts: string[] = [];
function fixture(failure?: number | 'network') {
 const requests: any[] = []; let dispatch = 0;
 globalThis.fetch = (async (url, init) => {
  const body = JSON.parse(String(init?.body)); requests.push({ url: String(url).includes('/dispatch/') ? String(url).split('/dispatch/')[1] : 'query', body });
  if(String(url).includes('/dispatch/')) { dispatch++; if(dispatch === 2 && failure) { if(failure === 'network') throw Error('fixture network failure'); return response({}, failure); } return response({ cardId: 'created'+dispatch, accountSeq: dispatch }); }
  const q = body.query; if(JSON.stringify(q).includes('loggedInUser')) return response({ _root: { loggedInUser: { id: 'u', name: 'fixture' } } });
  const entry = q._root?.[0]?.account?.[0]; const key = entry && Object.keys(entry)[0];
  return response({ _root: { account: { ...(key ? { [key]: ['c'] } : {}) } }, card: { c: { cardId: 'c', accountSeq: 0, title: '', content: '', effort: 0, isDoc: false, status: 'not_started', deck: { id: 'd', title: 'Deck' }, childCards: [], masterTags: [] } } });
 }) as typeof fetch;
 return requests;
}
const argsFor = (name: string) => name === 'card_bulk_create' ? { cards: [0,1,2].map(i => ({ title: 'fixture'+i, correlationKey: 'row'+i, effort: 0, putOnHand: false })) } : { updates: [0,1,2].map(i => ({ cardId: 'seq:0', correlationKey: 'row'+i, effort: i, clearRun: true, tags: [] })) };
const legacyData = (text: string) => JSON.parse(text.match(/```json\s*([\s\S]*?)```/)![1]).data;
function remember(dto: any) { const artifact = dto.data?.artifact; if(artifact?.path) artifacts.push(artifact.path); }
const clean = async () => { for(const path of artifacts.splice(0)) await rm(dirname(path), { recursive: true, force: true }); };
for(const name of ['card_bulk_create','card_bulk_update']) test(`${name}: preview and apply preserve fingerprints, full indexed rows, one invocation and genuine artifact`, async () => {
 const requests = fixture(); const d = definition(name); const args = argsFor(name);
 try {
  const native = await d.executePayload!({ ...args, format: 'json' }); const preview: any = d.projectOutput!(native.payload); remember(preview);
  assert.equal(preview.ok, true, JSON.stringify(preview)); assert.equal(Value.Check(d.outputSchema!, preview), true); assert.equal(preview.data.results.length, 3); assert.deepEqual(preview.data.results.map((r: any) => r.status), ['preview','preview','preview']);
  assert.match(preview.data.previewFingerprint, /^[a-f0-9]{64}$/); assert.equal(requests.filter(r => r.url !== 'query').length, 0);
  const artifact = JSON.parse(await readFile(preview.data.artifact.path, 'utf8')); assert.equal(artifact.results.length, 3); assert.equal(artifact.previewFingerprint, preview.data.previewFingerprint);
  assert.deepEqual(legacyData(native.text).results, [], 'legacy compact preview remains unchanged');
  assert.equal(preview.data.results[0].requested.effort, 0); assert.equal(preview.data.results[0].requested[name === 'card_bulk_create' ? 'putOnHand' : 'sprintId'], name === 'card_bulk_create' ? false : null);
  requests.length = 0;
  const result = await execute(d, { ...args, dryRun: true, format: 'text' }); const registered = result.structuredContent; remember(registered); assert.equal(result.isError, false); assert.equal(registered.data.previewFingerprint, preview.data.previewFingerprint); assert.equal(registered.data.results.length, 3); assert.equal(requests.filter(r => r.url !== 'query').length, 0); assert.match(result.content[0].text, /Bulk Card/);
  requests.length = 0;
  const progress: any[] = [];
  const applied = await execute(d, { ...args, dryRun: false, expectedPreviewFingerprint: preview.data.previewFingerprint, format: 'json' }, undefined, value => progress.push(value));
  assert.ok(progress.length > 0); assert.equal(progress.at(-1).details.progress.stage, 'completed'); assert.ok(progress.every(value => value.structuredContent === undefined && Buffer.byteLength(JSON.stringify(value)) < 4096)); assert.ok(progress.every(value => !/normalizedRequested|signedUrl|arbitrary/.test(JSON.stringify(value)))); const dto = applied.structuredContent; remember(dto);
  assert.equal(applied.isError, false, JSON.stringify(dto)); assert.equal(dto.data.results.length, 3); assert.equal(requests.filter(r => r.url !== 'query').length, 3); assert.deepEqual(dto.data.results.map((r: any) => r.certainty), Array(3).fill('dispatch_returned')); assert.ok(dto.data.results.every((r: any) => typeof r.actionKey === 'string'));
  const written = JSON.parse(await readFile(dto.data.artifact.path, 'utf8')); assert.deepEqual(written.results.map((r: any) => r.status), dto.data.results.map((r: any) => r.status));
  assert.equal(Value.Check(d.outputSchema!, { ...dto, private: true }), false);
  const bodies = requests.filter(r => r.url !== 'query').map(r => r.body); if(name === 'card_bulk_update') assert.ok(bodies.every(body => typeof body.sessionId === 'string')); if(name === 'card_bulk_update') { assert.ok(bodies.every(body => body.sprintId === null && Array.isArray(body.masterTags))); }
 } finally { globalThis.fetch = original; resetRateGate(); await clean(); }
});
for(const name of ['card_bulk_create','card_bulk_update']) test(`${name}: bad fingerprint zero dispatch; mixed failure stays native error with definitely-unsent trailing rows`, async () => {
 const d = definition(name); const args = argsFor(name);
 try {
  let requests = fixture(); const preview: any = d.projectOutput!((await d.executePayload!(args)).payload); remember(preview);
  requests.length = 0; const bad = await execute(d, { ...args, dryRun: false, expectedPreviewFingerprint: '0'.repeat(64) }); assert.equal(bad.isError, true); assert.equal(bad.structuredContent.error.code, 'validation_error'); assert.equal(requests.filter(r => r.url !== 'query').length, 0); assert.deepEqual(bad.structuredContent.data.results.map((r: any) => r.certainty), Array(3).fill('definitely_unsent'));
  for(const failure of [400,503,'network'] as const) {
   requests = fixture(failure);
   const result = await execute(d, { ...args, dryRun: false, ...(name === 'card_bulk_update' ? { continueOnError: false } : {}), expectedPreviewFingerprint: preview.data.previewFingerprint, format: 'json' }); const dto = result.structuredContent; remember(dto);
   assert.equal(result.isError, true, JSON.stringify(dto)); assert.equal(dto.ok, false); assert.equal(dto.data.results.length, 3); assert.equal(dto.data.results[0].certainty, 'dispatch_returned'); assert.equal(dto.data.results[1].certainty, failure === 400 ? 'definitely_rejected' : 'possibly_applied'); assert.equal(dto.data.results[2].certainty, 'definitely_unsent'); assert.equal(requests.filter(r => r.url !== 'query').length, 2); assert.equal(dto.data.results[1].replay, 'not_authorized');
   assert.equal(legacyData(result.content[0].text).created ?? legacyData(result.content[0].text).updated, 1, 'legacy bulk successful wrapper still has identical partial totals');
   assert.equal(dto.data.metrics.safeContinuationRange.startIndex, 2);
  }
  requests = fixture(); const aborted = new AbortController(); aborted.abort(); const result = await execute(d, args, aborted.signal); assert.equal(result.isError, true); remember(result.structuredContent); assert.equal(requests.length, 0);
 } finally { globalThis.fetch = original; resetRateGate(); await clean(); }
});
test('bulk invalid records/preview failures, clipping/UTF8 ceiling and malformed output preserve bounded effects', async () => {
 try {
  fixture(); for(const name of ['card_bulk_create','card_bulk_update']) {
   const d = definition(name); const invalid = await execute(d, name === 'card_bulk_create' ? { cards: [{ assignee: 'unsupported' }] } : { updates: [{ cardId: 'seq:0', clearDeck: true }] }); assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, 'validation_error'); assert.equal(Value.Check(d.outputSchema!, invalid.structuredContent), true);
   const action = name.replaceAll('_','-'); const payload: any = { ok: true, action, data: { dryRun: false, count: 1, artifact: { path: 'synthetic-schema-fixture.json', format: 'json', temporary: true }, metrics: { elapsedMs: 0, physicalRequests: 1, normalizationRequests: 0, dispatchRequests: 1, uniqueRecordsAttempted: 1, localGateWaitMs: 0, serverCooldownWaitMs: 0, consecutive429: 0, maxConsecutive429: 3, serverRecoveryWaitBudgetMs: 15000, retryEvents: [], rateLimitEvents: [], safeContinuationRange: null }, results: [{ index: 0, status: 'created', certainty: 'dispatch_returned', requested: { title: '😀'.repeat(2049), effort: 0, parentCardId: null }, replay: 'not_authorized' }] } };
   let dto: any = projectCardsBulkOutput(payload); assert.equal(dto.ok, true); assert.equal(dto.projectionComplete, false); assert.equal(Array.from(dto.data.results[0].requested.title).length, 2048);
   payload.data.results[0].actionKey = 'x'.repeat(129); dto = projectCardsBulkOutput(payload); assert.equal(dto.ok, false); assert.equal(dto.data.results[0].certainty, 'dispatch_returned');
   payload.data.results[0].actionKey = 'update:0:' + 'a'.repeat(64); payload.data.results[0].normalizedRequestedFingerprint = 'b'.repeat(64); payload.data.results[0].targetId = 'c'; payload.data.results[0].identity = { cardId: 'created', accountSeq: 0 }; payload.data.actualPreviewFingerprint = 'c'.repeat(64); payload.data.results[0].requested.content = '😀'.repeat(32768); payload.data.count = 100; payload.data.results = Array.from({ length: 100 }, (_, index) => ({ ...payload.data.results[0], index }));
   dto = projectCardsBulkOutput(payload); assert.equal(dto.ok, false); assert.equal(dto.error.code, 'output_too_large'); assert.equal(dto.data.results.length, 100); assert.equal(dto.data.results[99].certainty, 'dispatch_returned'); assert.equal(dto.data.results[99].actionKey, 'update:0:' + 'a'.repeat(64)); assert.equal(dto.data.results[99].normalizedRequestedFingerprint, 'b'.repeat(64)); assert.deepEqual(dto.data.results[99].identity, { cardId: 'created', accountSeq: 0 }); assert.equal(dto.data.actualPreviewFingerprint, 'c'.repeat(64)); assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= CARDS_BULK_LIMITS.bytes);
   payload.data.results = Array.from({ length: 100 }, (_, index) => ({ index, status: 'updated', certainty: 'dispatch_returned', requested: { content: '' }, replay: 'not_authorized' }));
   let remaining = CARDS_BULK_LIMITS.bytes - Buffer.byteLength(JSON.stringify(projectCardsBulkOutput(payload)));
   for(const row of payload.data.results) { const amount = Math.min(32768, remaining); row.requested.content = 'x'.repeat(amount); remaining -= amount; }
   assert.equal(remaining, 0);
   const exact: any = projectCardsBulkOutput(payload); assert.equal(exact.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(exact)), CARDS_BULK_LIMITS.bytes);
   payload.data.results.find((row: any) => row.requested.content.length < 32768).requested.content += 'x';
   assert.equal((projectCardsBulkOutput(payload) as any).error.code, 'output_too_large');
   for(const value of [undefined, {}, { ok: true, action, data: {} }]) { dto = projectCardsBulkOutput(value, name); assert.equal(dto.ok, false); assert.equal(Value.Check(d.outputSchema!, dto), true); }
  }
  assert.equal(CARDS_BULK_LIMITS.bytes, 2097152);
 } finally { globalThis.fetch = original; resetRateGate(); }
});
for(const name of ['card_bulk_create','card_bulk_update']) test(`${name}: failed preflight lookup keeps one indexed outcome per input and actual read accounting without dispatch`, async () => {
 const requests: any[] = []; globalThis.fetch = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); throw new Error('synthetic preflight lookup failure'); }) as typeof fetch;
 try {
  const result = await execute(definition(name), { ...argsFor(name), dryRun: false, format: 'json' }); const dto = result.structuredContent;
  assert.equal(result.isError, true); assert.equal(dto.data.results.length, 3); assert.deepEqual(dto.data.results.map((r: any) => r.index), [0,1,2]); assert.equal(dto.data.dispatchRequests, 0); assert.equal(dto.data.requestsAttempted, requests.length); assert.equal(requests.length, 1);
  if(name === 'card_bulk_create') assert.ok(dto.data.results.every((r: any) => r.certainty === 'definitely_unsent'));
  assert.ok(requests.every(request => request.query));
 } finally { globalThis.fetch = original; resetRateGate(); }
});
for(const name of ['card_bulk_create','card_bulk_update']) test(`${name}: bounded fallback keeps fingerprints/keys, duplicate targets or created identity, genuine artifact and source metrics`, async () => {
 const d = definition(name); const args = argsFor(name); let requests = fixture();
 try {
  const previewNative = await d.executePayload!(args); const preview: any = d.projectOutput!(previewNative.payload); remember(preview);
  const badPreview: any = structuredClone(previewNative.payload); badPreview.data.results[0].requested.content = false;
  const previewError: any = d.projectOutput!(badPreview); assert.equal(previewError.ok, false); assert.equal(previewError.data.previewFingerprint, preview.data.previewFingerprint); assert.equal(previewError.data.results[0].actionKey, preview.data.results[0].actionKey); assert.equal(previewError.data.results[0].certainty, 'not_dispatched');
  requests = fixture(503);
  const native = await d.executePayload!({ ...args, dryRun: false, ...(name === 'card_bulk_update' ? { continueOnError: false } : {}), expectedPreviewFingerprint: preview.data.previewFingerprint }); const beforeRequests = requests.length; const source: any = structuredClone(native.payload); const originalDto: any = d.projectOutput!(source); remember(originalDto);
  source.data.results[0].requested.content = false;
  let dto: any = d.projectOutput!(source); assert.equal(dto.ok, false); assert.equal(dto.data.results.length, 3); assert.equal(dto.data.results[0].actionKey, originalDto.data.results[0].actionKey); assert.deepEqual(dto.data.metrics, originalDto.data.metrics); assert.deepEqual(dto.data.artifact, originalDto.data.artifact); assert.equal(dto.data.results[0].certainty, 'dispatch_returned'); assert.equal(dto.data.results[1].certainty, 'possibly_applied'); assert.equal(dto.data.results[2].certainty, 'definitely_unsent'); assert.ok(dto.data.results[0].omittedEvidence.includes('requested'));
  if(name === 'card_bulk_create') assert.deepEqual(dto.data.results[0].identity, originalDto.data.results[0].identity); else { assert.equal(dto.data.results[0].normalizedRequestedFingerprint, originalDto.data.results[0].normalizedRequestedFingerprint); assert.deepEqual(dto.data.results.map((r: any) => r.targetId), ['c','c','c']); }
  assert.equal(Value.Check(d.outputSchema!, dto), true); assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= CARDS_BULK_LIMITS.bytes);
  source.data.metrics.rateLimitEvents = Array.from({ length: 600 }, () => ({ index: 0, retryAttempt: 1, retryAttempted: false, reason: '😀'.repeat(3000) }));
  source.data.results[1].actionKey = 'x'.repeat(129); source.data.results[1].normalizedRequestedFingerprint = 'not-a-fingerprint';
  dto = d.projectOutput!(source); assert.equal(dto.ok, false); assert.equal(dto.data.results[1].actionKey, undefined); assert.equal(dto.data.results[1].normalizedRequestedFingerprint, undefined); assert.ok(dto.data.results[1].omittedEvidence.includes('actionKey')); assert.equal(dto.data.results[0].actionKey, originalDto.data.results[0].actionKey); assert.equal(dto.data.metricsSummary.provenance, 'native_metrics_and_derived_event_counts'); assert.equal(dto.data.metricsSummary.physicalRequests, originalDto.data.metrics.physicalRequests); assert.equal(dto.data.metricsSummary.rateLimitEventCount, 600); assert.equal(dto.data.metricsSummary.retainedRateLimitEvents, 0); assert.equal(dto.data.metricsSummary.omittedRateLimitEvents, 600); assert.equal(dto.data.metricsSummary.retainedRetryEvents, 0); assert.ok(dto.data.omittedEvidence.includes('metrics')); assert.equal(Value.Check(d.outputSchema!, dto), true); assert.ok(Buffer.byteLength(JSON.stringify(dto)) <= CARDS_BULK_LIMITS.bytes); assert.equal(requests.length, beforeRequests); assert.equal(requests.filter(r => r.url !== 'query').length, 2);
 } finally { globalThis.fetch = original; resetRateGate(); await clean(); }
});
for(const name of ['card_bulk_create','card_bulk_update']) test(`${name}: genuine artifact failure after dispatch retains per-record effects with no replay/spill`, async () => {
 const d = definition(name); const args = argsFor(name); const requests = fixture(); const preview: any = d.projectOutput!((await d.executePayload!(args)).payload); remember(preview);
 const originalMkdtemp = fs.mkdtemp;
 try {
  fs.mkdtemp = (async () => { throw new Error('synthetic artifact filesystem failure'); }) as any;
  requests.length = 0;
  const result = await execute(d, { ...args, dryRun: false, expectedPreviewFingerprint: preview.data.previewFingerprint, format: 'json' });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.error.code, 'file_error'); assert.equal(result.structuredContent.data.artifact.unavailable, true); assert.equal(Object.hasOwn(result.structuredContent.data.artifact, 'path'), false); assert.equal(result.structuredContent.data.results.length, 3); assert.ok(result.structuredContent.data.results.every((r: any) => r.certainty === 'dispatch_returned')); assert.equal(requests.filter(r => r.url !== 'query').length, 3);
  assert.equal(legacyData(result.content[0].text).artifact.unavailable, true);
 } finally { fs.mkdtemp = originalMkdtemp; globalThis.fetch = original; resetRateGate(); await clean(); }
});
