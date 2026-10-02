import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { CARD_SEARCH_OUTPUT_SCHEMA, projectCardSearchOutput, isCardSearchOutput } from "../src/card-search-output.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
import { PiToolHarness } from "./pi-tool-harness.ts";
useInertEnvironmentCredentialProvider();
const core = await import("../src/codecks-core.ts");
const success = (data: Record<string, unknown> = {}) => ({ ok: true, action: "card-search", data: { matches: 1, rawMatches: 1, returnedCards: 1, outputMode: "detailed", visibility: "token_visible_projects_only", complete: true, criteria: {}, cards: [{ cardId: "fixture", title: "Card" }], ...data } });
const failure = (error: Record<string, unknown> = {}) => ({ ok: false, action: "card-search", error: { category: "not_found", message: "Fixture error", ...error } });
test("bounded strict allowlist preserves falsy/null/absent and forbidden fields", () => {
  const dto = projectCardSearchOutput(success({ cards: [{ cardId: "fixture", accountSeq: 0, isDoc: false, effort: 0, priority: null, title: "", deck: { title: "", accountSeq: 0, transport: "private" }, token: "private", content: "private", path: "private" }] }));
  assert.equal(dto.ok, true); assert.ok(isCardSearchOutput(dto));
  const row = dto.data.cards[0]; assert.equal(row.effort, 0); assert.equal(row.isDoc, false); assert.equal(row.priority, null); assert.equal(row.title, ""); assert.equal(Object.hasOwn(row, "dueDate"), false); assert.equal(JSON.stringify(dto).includes("private"), false);
  assert.equal(Value.Check(CARD_SEARCH_OUTPUT_SCHEMA, { ...dto, unexpected: true }), false);
  assert.equal(Value.Check(CARD_SEARCH_OUTPUT_SCHEMA, { ...dto, data: { ...dto.data, cards: [{ ...row, unexpected: true }] } }), false);
});
test("mode semantics distinguish source totals, emitted rows, scan and samples", () => {
  for (const mode of ["compact", "detailed", "counts"]) {
    const dto = projectCardSearchOutput(success({ matches: 30, rawMatches: 30, returnedCards: mode === "counts" ? 0 : 1, outputMode: mode, truncated: mode !== "detailed", ...(mode === "counts" ? { cards: undefined, sampleCards: [{ title: "Sample" }] } : {}), facets: { effort: { "(unknown)": 30 } } }));
    assert.equal(dto.ok, true); assert.equal(dto.data.emittedRows, 1); assert.equal(dto.data.matches, 30); assert.equal(dto.data.rowsExhaustive, false); assert.equal(dto.data.facetBucketCount, 1); assert.equal(dto.data.facetSemantics, "legacy_inferred_buckets");
  }
  assert.equal(projectCardSearchOutput(success()).data.rowsExhaustive, true);
  const empty = projectCardSearchOutput(success({ matches: 0, rawMatches: 0, returnedCards: 0, cards: [], complete: false }));
  assert.equal(empty.ok, true); assert.equal(empty.completeness.read, "incomplete"); assert.equal(empty.data.rowsExhaustive, false);
});
test("errors map unknown categories, preserve page metrics and strip unsafe evidence", () => {
  const dto = projectCardSearchOutput(failure({ category: "unsafe_unknown", scannedCards: 2, requestsAttempted: 2, complete: false, authorization: "private", path: "private" }));
  assert.equal(dto.ok, false); assert.equal(dto.error.code, "api_error"); assert.equal(dto.completeness.read, "incomplete"); assert.equal(dto.evidence.scannedCards, 2); assert.equal(JSON.stringify(dto).includes("private"), false);
});
test("Unicode, explicit array/facet bounds, byte overflow fail closed", () => {
  const clipped = projectCardSearchOutput(success({ criteria: { deck: "😀".repeat(2049) }, cards: [{ title: "😀".repeat(2049), tags: Array(3001).fill("t") }] }));
  assert.equal(clipped.ok, true); assert.equal(Array.from(clipped.data.cards[0].title).length, 2048); assert.equal(clipped.data.cards[0].tags.length, 3000); assert.equal(clipped.completeness.projection, false); assert.equal(Array.from(clipped.data.criteria.deck as string).length, 2048);
  const rows = projectCardSearchOutput(success({ cards: Array(3001).fill({}) })); assert.equal(rows.data.emittedRows, 3000); assert.equal(rows.completeness.projection, false);
  const facets = projectCardSearchOutput(success({ facets: { status: Object.fromEntries(Array.from({ length: 3001 }, (_, i) => [`v${i}`, 1])) } })); assert.equal(facets.ok, false); assert.equal(facets.error.code, "output_too_large");
  const overflow = projectCardSearchOutput(success({ cards: Array(10).fill({ title: "😀".repeat(2048) }) })); assert.equal(overflow.ok, false); assert.equal(overflow.error.code, "output_too_large");
});
for (const [name, payload] of Object.entries({ absent: undefined, wrongAction: { ...success(), action: "other" }, missingData: { ok: true, action: "card-search" }, badComplete: success({ complete: undefined }), badRows: success({ cards: null }), badScalar: success({ matches: Infinity }), badFacet: success({ facets: [] }), error: failure({ category: undefined }) })) test(`malformed ${name} is contract failure`, () => { const dto = projectCardSearchOutput(payload); assert.equal(dto.ok, false); assert.equal(dto.error.code, "output_contract_error"); });

async function fakeRead(cards: Record<string, any>[], args: Record<string, unknown>, failAt = Infinity, status = 403) {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    calls++;
    if (calls >= failAt) return new Response(JSON.stringify({ error: status === 401 ? "authentication_rejected" : "missing_scope" }), { status });
    const query = JSON.parse(String(init?.body)).query;
    const relation = query._root[0].account.flatMap((entry: object) => Object.keys(entry)).find((key: string) => key.startsWith("cards("));
    const filters = JSON.parse(relation.slice(6, -1));
    const page = cards.slice(filters.$offset ?? 0, (filters.$offset ?? 0) + (filters.$limit ?? 500));
    return new Response(JSON.stringify({ data: { _root: { account: "fixture" }, account: { fixture: { [relation]: page.map(c => c.cardId) } }, card: Object.fromEntries(page.map(c => [c.cardId, c])) } }));
  }) as typeof fetch;
  try { return await core.runWithAbortSignal(undefined, () => core.readCardSearch(args)); }
  finally { globalThis.fetch = original; core.__test.resetRateGate(); }
}
test("fake HTTP seam preserves legacy text, source observations, modes and empty/partial-empty", async () => {
  const cards = Array.from({ length: 30 }, (_, i) => ({ cardId: `fixture-${i}`, accountSeq: i, title: "Card", isDoc: i === 0 ? null : false, effort: 0, dueDate: null }));
  for (const outputMode of ["compact", "detailed", "counts"]) {
    const read = await fakeRead(cards, { limit: 30, outputMode, format: "json" });
    assert.match(read.text, /```json/); const dto = projectCardSearchOutput(read.payload); assert.equal(dto.ok, true);
    assert.equal(dto.data.emittedRows, outputMode === "compact" ? 25 : outputMode === "counts" ? 10 : 30);
    const row = (dto.data.cards ?? dto.data.sampleCards)[0]; assert.equal(row.isDoc, null); assert.equal(row.accountSeqRef, "seq:0"); assert.equal(Object.hasOwn(row, "priority"), false); assert.equal(Object.hasOwn(dto.data.criteria, "includeDone"), false);
  }
  const absent = projectCardSearchOutput((await fakeRead([{ cardId: "missing", title: "Card", masterTags: [{}] }], {})).payload);
  assert.equal(Object.hasOwn(absent.data.cards[0], "tags"), false); assert.equal(Object.hasOwn(absent.data.cards[0], "isDoc"), false); assert.equal(Object.hasOwn(absent.data.cards[0], "accountSeqRef"), false);
  for (const partial of [false, true]) {
    const read = await fakeRead(partial ? cards : [], { title: "No match", scanLimit: 2, pageSize: 2 }); const dto = projectCardSearchOutput(read.payload);
    assert.equal(dto.ok, true); assert.equal(dto.data.matches, 0); assert.equal(dto.completeness.read, partial ? "incomplete" : "complete"); assert.equal(dto.data.rowsExhaustive, false);
  }
  const pageError = projectCardSearchOutput((await fakeRead(cards, { pageSize: 2, scanLimit: 4 }, 2)).payload);
  assert.equal(pageError.ok, false); assert.equal(pageError.completeness.read, "incomplete"); assert.equal(pageError.evidence.scannedCards, 2); assert.equal(pageError.evidence.requestsAttempted, 2);
  const auth = projectCardSearchOutput((await fakeRead([], {}, 1, 401)).payload); assert.equal(auth.ok, false); assert.equal(auth.error.code, "authentication_rejected");
  const validation = projectCardSearchOutput((await fakeRead([], { location: "deck" })).payload); assert.equal(validation.ok, false); assert.equal(validation.error.code, "validation_error");
});
test("registered adapter advertises schema and malformed native seam never falls back to text success", async () => {
  const harness = new PiToolHarness(); await harness.load();
  const tool = harness.registry.get("codecks_card_search")!; assert.deepEqual((tool as any).outputSchema, CARD_SEARCH_OUTPUT_SCHEMA);
  const original = core.card_search.read;
  try {
    for (const payload of [undefined, success({ cards: [{ effort: "bad" }] }), success({ cards: Array(10).fill({ title: "😀".repeat(2048) }) }), failure({ category: "unknown" })]) {
      core.card_search.read = async () => ({ text: "legacy success must not rescue invalid output", payload: payload as any });
      const result = await tool.execute("fixture", {}, undefined, undefined, { cwd: process.cwd() });
      assert.equal(result.isError, true); assert.equal(result.structuredContent.ok, false);
      if (result.structuredContent.error.code.startsWith("output_")) assert.equal(result.content[0].text.includes("legacy success"), false);
    }
  } finally { core.card_search.read = original; }
});
