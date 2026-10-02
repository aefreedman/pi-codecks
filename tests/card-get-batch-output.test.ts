import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { CARD_GET_OUTPUT_SCHEMA, projectCardGetOutput } from "../src/card-get-output.ts";
import { CARD_SEARCH_OUTPUT_SCHEMA } from "../src/card-search-output.ts";
import { projectBoundedValue } from "../src/contracts/common.ts";
import { CARD_GET_BATCH_OUTPUT_SCHEMA, CARD_GET_BATCH_LIMITS, projectCardGetBatchOutput, isCardGetBatchOutput, hasCardGetBatchByteBudget } from "../src/tools/cards/card-get-batch-output.ts";
import { executeCardGetBatchPayload, card_get_batch } from "../src/tools/cards/reads.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { runWithAbortSignal, getOperationContext } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
const card = (fields: Record<string, unknown> = {}) => ({ contentTrust: "external", ...fields });
const payload = (items: any[]) => ({ ok: true, action: "card-get-batch", data: { requested: items.length, uniqueReferences: new Set(items.map(i => i.requestedRef)).size, found: items.filter(i => i.status === "found").length, missing: items.filter(i => i.status === "missing").length, complete: true, items } });
const found = (fields: Record<string, unknown> = {}, requestedRef = "seq:0") => ({ requestedRef, status: "found", card: card(fields) });
const failure = (items?: any[]) => ({ ok: false, action: "card-get-batch", error: { category: "api_error", message: "Synthetic failure", ...(items ? { requested: items.length, complete: false, items } : {}) } });
const register = (definition: any) => { let registered: any; registerCodecksTool({ registerTool(t: any) { registered = t; } } as any, definition, "Fixture", false, () => "PERSONAL"); return registered; };
const execute = (definition: any, args: any, signal?: AbortSignal) => register(definition).execute("fixture", args, signal, undefined, { cwd: process.cwd() });

test("closed v1 DTO preserves ordered duplicates, missing, source/projected counts and null/falsy/absence", () => {
  const dto = projectCardGetBatchOutput(payload([found({ accountSeq: 0, effort: 0, isDoc: false, content: null, deck: { title: "" } }), { requestedRef: "seq:1", status: "missing" }, found({ accountSeq: 0 })]));
  assert.ok(isCardGetBatchOutput(dto)); assert.equal(dto.ok, true);
  assert.deepEqual(dto.data.items.map(i => i.requestedRef), ["seq:0", "seq:1", "seq:0"]);
  assert.equal(dto.data.found, 2); assert.equal(dto.data.missing, 1); assert.equal(dto.data.projectedFound, 2);
  assert.equal(dto.data.items[0].card.card.effort, 0); assert.equal(dto.data.items[0].card.card.isDoc, false); assert.equal(dto.data.items[0].card.card.content, null);
  assert.equal(Object.hasOwn(dto.data.items[0].card.card, "priority"), false);
  assert.equal(Value.Check(CARD_GET_BATCH_OUTPUT_SCHEMA, { ...dto, private: true }), false);
});
test("complete all-missing lookup succeeds, upstream failures retain failed versus unqueried without fabricated source counts", () => {
  const missing = projectCardGetBatchOutput(payload([{ requestedRef: "seq:0", status: "missing" }]));
  assert.equal(missing.ok, true); assert.equal(missing.completeness.read, "complete"); assert.equal(missing.data.found, 0);
  const failed = projectCardGetBatchOutput(failure([{ requestedRef: "seq:0", status: "failed" }, { requestedRef: "seq:1", status: "unqueried" }]));
  assert.equal(failed.ok, false); assert.equal(failed.completeness.read, "incomplete");
  assert.deepEqual(failed.data.items.map(i => i.status), ["failed", "unqueried"]); assert.equal(Object.hasOwn(failed.data, "found"), false);
});
test("per-card projection errors retain found source count, all items, read completeness and native semantic failure", () => {
  const dto = projectCardGetBatchOutput(payload([found(), found({ effort: "bad" }, "seq:1"), found({ content: "😀".repeat(32768) }, "seq:2"), { requestedRef: "seq:3", status: "missing" }]));
  assert.equal(dto.ok, false); assert.equal(dto.error.code, "output_contract_error"); assert.equal(dto.completeness.read, "complete"); assert.equal(dto.completeness.projection, false);
  assert.equal(dto.data.found, 3); assert.equal(dto.data.projectedFound, 1); assert.equal(dto.data.projectionErrors, 2);
  assert.deepEqual(dto.data.items.map(i => i.status), ["found", "projection_error", "projection_error", "missing"]);
  assert.equal(dto.data.items[2].error.error.code, "output_too_large"); assert.ok(isCardGetBatchOutput(dto));
});
test("Unicode field clipping is explicit and reusable input references are never clipped", () => {
  const dto = projectCardGetBatchOutput(payload([found({ title: "😀".repeat(2049), tags: Array(26).fill("tag") })]));
  assert.equal(dto.ok, true); assert.equal(dto.completeness.projection, false); assert.equal(Array.from(dto.data.items[0].card.card.title).length, 2048);
  assert.equal(dto.data.items[0].card.card.tags.length, 25);
  assert.equal(projectCardGetBatchOutput(payload([found({}, "s".repeat(129))])).error.code, "output_contract_error");
  const identity = projectCardGetBatchOutput(payload([found({ cardId: "x".repeat(2049) })]));
  assert.equal(identity.ok, false); assert.equal(identity.data.items[0].status, "projection_error");
});
test("exact per-card UTF-8 bytes pass, one byte over is explicit projection error", () => {
  const template: any = projectCardGetOutput({ ok: true, action: "card-get", data: { card: card({ content: "", title: "" }) } });
  const overhead = Buffer.byteLength(JSON.stringify(template), "utf8");
  const remaining = 65536 - overhead;
  const content = "😀".repeat(Math.floor(remaining / 4));
  const title = "x".repeat(remaining % 4);
  const exact = projectCardGetBatchOutput(payload([found({ content, title })]));
  assert.equal(exact.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(exact.data.items[0].card), "utf8"), 65536);
  const over = projectCardGetBatchOutput(payload([found({ content, title: title + "x" })]));
  assert.equal(over.ok, false); assert.equal(over.data.items[0].status, "projection_error"); assert.equal(over.data.items[0].error.error.code, "output_too_large");
});
test("batch UTF-8 budget is inclusive and counts repeated items/metadata; maximal normal projection is below defensive ceiling", () => {
  const dto: any = projectCardGetBatchOutput(payload(Array.from({ length: 25 }, () => found({ content: "😀".repeat(16000) }))));
  assert.equal(dto.ok, true); assert.ok(Buffer.byteLength(JSON.stringify(dto)) < CARD_GET_BATCH_LIMITS.bytes);
  // A schema-valid repeated DTO permits a >65KiB embedded card to exercise the independent full JSON predicate.
  const edge: any = structuredClone(dto);
  for (const item of edge.data.items) { item.card.card.content = "😀".repeat(20800); item.card.card.title = ""; }
  const remaining = CARD_GET_BATCH_LIMITS.bytes - Buffer.byteLength(JSON.stringify(edge));
  assert.ok(remaining > 0 && remaining < 24 * 2048);
  for (let i = 0, left = remaining; left > 0; i++) { const n = Math.min(left, 2048); edge.data.items[i].card.card.title = "x".repeat(n); left -= n; }
  assert.equal(Buffer.byteLength(JSON.stringify(edge)), CARD_GET_BATCH_LIMITS.bytes); assert.equal(hasCardGetBatchByteBudget(edge), true); assert.equal(isCardGetBatchOutput(edge), false, "per-card ceiling is enforced independently");
  edge.data.items[24].card.card.title += "x"; assert.equal(hasCardGetBatchByteBudget(edge), false);
});
for (const [name, value] of Object.entries({ absent: undefined, missingData: { ok: true, action: "card-get-batch" }, missingError: { ok: false, action: "card-get-batch" }, missingItems: { ok: true, action: "card-get-batch", data: {} }, badStatus: payload([{ requestedRef: "seq:0", status: "invented" }]), wrongCount: { ...payload([found()]), data: { ...payload([found()]).data, found: 0 } }, excessiveItems: payload(Array(26).fill(found())) })) {
  test(`malformed native ${name} fails closed`, () => { const dto = projectCardGetBatchOutput(value); assert.equal(dto.ok, false); assert.equal(dto.error.code, "output_contract_error"); assert.ok(isCardGetBatchOutput(dto)); });
}
test("nested mixed object unions select valid discriminators before clipping, missing/invalid branches fail", () => {
  const schema = Type.Array(Type.Union([Type.Object({ status: Type.Literal("found"), data: Type.String({ maxLength: 2 }) }), Type.Object({ status: Type.Literal("error"), error: Type.String({ maxLength: 2 }) })]), { maxItems: 25 });
  const state = { complete: true };
  assert.deepEqual(projectBoundedValue(schema, [{ status: "found", data: "long" }, { status: "error", error: "oops" }], state), [{ status: "found", data: "lo" }, { status: "error", error: "oo" }]); assert.equal(state.complete, false);
  for (const status of [undefined, "missing", false]) assert.throws(() => projectBoundedValue(schema, [{ status, error: "oops" }], { complete: true }));
});
test("pilot schema owners are byte-for-byte unchanged and exact schema hashes remain frozen by foundation suite", () => {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  assert.equal(hash(CARD_GET_OUTPUT_SCHEMA), "cba7b98f84efc597635e17da6c7ed0e7942360131543cb197a361db5ef2bbf37");
  assert.equal(hash(CARD_SEARCH_OUTPUT_SCHEMA), "c53a26fbba4ac9dcd8e718301ed4547c8d4ac398376c36ed7d2d62a7cf92fe71");
});
test("native neutral seam executes once under canonical context, read pilots and legacy/no-seam remain accepted", async () => {
  let calls = 0;
  const definition: any = { exportName: "fixture", tool: { execute() { throw Error("must not replay"); } }, config: {}, executePayload: async () => { calls++; assert.ok(getOperationContext()); return { text: "native presentation", payload: payload([found()]) }; }, outputSchema: CARD_GET_BATCH_OUTPUT_SCHEMA, projectOutput: projectCardGetBatchOutput };
  const value = await execute(definition, {}); assert.equal(calls, 1); assert.equal(value.isError, false); assert.equal(value.content[0].text, "native presentation");
  assert.throws(() => register({ ...definition, read: definition.executePayload }), /Ambiguous/);
  const legacy = await execute({ exportName: "fixture", tool: { execute: () => "legacy" }, config: {} }, {}); assert.equal(legacy.content[0].text, "legacy"); assert.equal(legacy.structuredContent, undefined);
  for (const name of ["card_get", "card_search"]) { const d = getCodecksToolDefinition(name); assert.ok(d.read); assert.equal(d.executePayload, undefined); }
  for (const candidate of [undefined, { text: "misleading", payload: undefined }, { text: "misleading", payload: payload([found({ effort: "bad" })]) }]) {
    const result = await execute({ ...definition, executePayload: async () => candidate }, {}); assert.equal(result.isError, true); assert.equal(result.structuredContent.ok, false); assert.doesNotMatch(result.content[0].text, /misleading/);
  }
});
test("real native batch operation/adapter deduplicates one query, preserves legacy output and observed relations", async () => {
  const before = globalThis.fetch; const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => { const query = JSON.parse(String(init?.body)).query; bodies.push(query); const relation = query._root[0].account.flatMap((entry: any) => Object.keys(entry)).find((key: string) => key.startsWith("cards("));
    return new Response(JSON.stringify({ data: { _root: { account: "fixture" }, account: { fixture: { [relation]: ["c0"] } }, card: { c0: { cardId: "c0", accountSeq: 0, effort: 0, isDoc: false, content: null, deck: { title: "" }, parentCard: { cardId: "parent", accountSeq: null }, childCards: [{ cardId: "child" }] } } } })); }) as typeof fetch;
  try {
    const args = { cardIds: ["seq:0", "seq:1", "seq:0"] };
    const native = await executeCardGetBatchPayload(args); assert.equal(bodies.length, 1); assert.match(JSON.stringify(bodies[0]), /accountSeq.*\[0,1\]/);
    const dto: any = projectCardGetBatchOutput(native.payload); assert.equal(dto.ok, true); assert.equal(dto.data.uniqueReferences, 2); assert.equal(dto.data.items[0].card.card.content, null);
    assert.equal(Object.hasOwn(dto.data.items[0].card.card.deck, "id"), false); assert.equal(Object.hasOwn(dto.data.items[0].card.card.parentCard, "cardRef"), false);
    assert.equal(Object.hasOwn(dto.data.items[0].card.card.childCards[0], "status"), false);
    const legacy = await card_get_batch.execute(args); assert.equal(legacy, native.text); assert.equal(bodies.length, 2);
    const registered = await execute(getCodecksToolDefinition("card_get_batch"), { ...args, format: "text" }); assert.equal(registered.isError, false); assert.match(registered.content[0].text, /Card Batch Data/); assert.doesNotMatch(registered.content[0].text, /```json/); assert.equal(bodies.length, 3);
    const invalid = await execute(getCodecksToolDefinition("card_get_batch"), { cardIds: ["seq:0", "123e4567-e89b-12d3-a456-426614174000"] }); assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error.code, "validation_error"); assert.equal(bodies.length, 3);
  } finally { globalThis.fetch = before; resetRateGate(); }
});
test("real upstream error and pre-abort keep failed/unqueried evidence and native status", async () => {
  const before = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ errors: [{ message: "synthetic API failure" }] }))) as typeof fetch;
  try {
    const failed = await execute(getCodecksToolDefinition("card_get_batch"), { cardIds: ["seq:0", "seq:0"] }); assert.equal(failed.isError, true); assert.deepEqual(failed.structuredContent.data.items.map(i => i.status), ["failed", "failed"]);
    const controller = new AbortController(); controller.abort();
    const aborted = await runWithAbortSignal(controller.signal, () => executeCardGetBatchPayload({ cardIds: ["seq:0"] }));
    const dto = projectCardGetBatchOutput(aborted.payload); assert.equal(dto.ok, false); assert.equal(dto.data.items[0].status, "unqueried");
  } finally { globalThis.fetch = before; resetRateGate(); }
});
