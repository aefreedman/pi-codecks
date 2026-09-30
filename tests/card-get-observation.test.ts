import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
import { projectCardGetOutput, finalizeCardGetOutput, CARD_GET_OUTPUT_SCHEMA } from "../src/card-get-output.ts";
useInertEnvironmentCredentialProvider();
const core = await import("../src/codecks-core.ts");
const absentRefs = (value: any) => { for (const key of ["shortCode", "cardRef", "accountSeqRef", "url"]) assert.equal(Object.hasOwn(value, key), false, key); };
async function read(card: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { card: { fixture: card } } }))) as typeof fetch;
  try { return await core.runWithAbortSignal(undefined, () => core.readCardGet({ cardId: "fixture" })); }
  finally { globalThis.fetch = original; core.__test.resetRateGate(); }
}
test("pilot top-level null observations remain null and cannot derive type or seq:null refs", async () => {
  const result = await read({ cardId: "fixture", title: "Card", isDoc: null, accountSeq: null, status: null, derivedStatus: null });
  const dto = projectCardGetOutput(result.payload);
  assert.equal(dto.ok, true); assert.equal(dto.card.isDoc, null); assert.equal(dto.card.accountSeq, null);
  assert.equal(dto.card.status, null); assert.equal(dto.card.derivedStatus, null); assert.equal(dto.card.cardType, "unknown"); absentRefs(dto.card);
  const legacy = JSON.parse(result.text.match(/```json\s*([\s\S]*)\s*```/)![1]);
  assert.equal(legacy.data.card.isDoc, false); assert.equal(legacy.data.card.accountSeqRef, "seq:null", "unrelated legacy interface stays unchanged");
  for (const facts of [{ status: null }, { derivedStatus: null }, { isDoc: null, status: undefined }, {}]) {
    const unknown = projectCardGetOutput((await read({ cardId: "fixture", title: "Card", ...facts })).payload);
    assert.equal(unknown.card.cardType, "unknown");
    if (facts.isDoc === null) assert.equal(unknown.card.isDoc, null);
    else assert.equal(Object.hasOwn(unknown.card, "isDoc"), false);
  }
});
test("pilot related observations preserve nulls and zero/false without deriving invalid references", async () => {
  const unknown = { cardId: "parent", title: "Parent", isDoc: null, status: null, derivedStatus: null, accountSeq: null };
  const dto = projectCardGetOutput((await read({ cardId: "fixture", title: "Card", accountSeq: 0, isDoc: false, parentCard: unknown,
    childCards: [{ ...unknown, cardId: "child-null" }, { cardId: "child-zero", accountSeq: 0, isDoc: false }, { cardId: "child-missing" }] })).payload);
  assert.equal(dto.ok, true); assert.equal(dto.card.accountSeqRef, "seq:0"); assert.equal(dto.card.isDoc, false);
  for (const item of [dto.card.parentCard, dto.card.childCards[0]]) {
    assert.equal(item.isDoc, null); assert.equal(item.status, null); assert.equal(item.derivedStatus, null); assert.equal(item.accountSeq, null); assert.equal(item.cardType, "unknown"); absentRefs(item);
  }
  assert.equal(dto.card.childCards[1].accountSeq, 0); assert.equal(dto.card.childCards[1].isDoc, false); assert.equal(dto.card.childCards[1].accountSeqRef, "seq:0");
  assert.equal(dto.card.childCards[2].cardType, "unknown"); assert.equal(Object.hasOwn(dto.card.childCards[2], "isDoc"), false); absentRefs(dto.card.childCards[2]);
});
for (const branch of ["ambiguous", "incomplete", "failed-page"] as const) {
  test(`pilot ${branch} candidates use source observations, not renderer defaults`, async () => {
    const sources = [{ cardId: "missing", title: "Match card" },
      { cardId: "null", title: "Match card", accountSeq: null, isDoc: null, status: null, derivedStatus: null, deck: null, milestone: null, assignee: null },
      { cardId: "zero", title: "Match card", accountSeq: 0, isDoc: false }];
    const original = globalThis.fetch; let requests = 0;
    globalThis.fetch = (async (_input, init) => {
      requests++;
      if (branch === "failed-page" && requests === 2) return new Response(JSON.stringify({ errors: [{ message: "synthetic page failure" }] }));
      const query = JSON.parse(String(init?.body)).query;
      const relation = query._root[0].account.flatMap((entry: object) => Object.keys(entry)).find((key: string) => key.startsWith("cards("));
      assert.ok(relation);
      const cards = branch === "ambiguous" ? sources : [...sources, ...Array.from({ length: 497 }, (_, index) => ({ cardId: `unrelated-${index}`, title: "Unrelated" }))];
      return new Response(JSON.stringify({ data: { _root: { account: "fixture" }, account: { fixture: { [relation]: cards.map(card => card.cardId) } }, card: Object.fromEntries(cards.map(card => [card.cardId, card])) } }));
    }) as typeof fetch;
    try {
      const result = await core.runWithAbortSignal(undefined, () => core.readCardGet({ title: "Match card" }));
      const dto = projectCardGetOutput(result.payload);
      assert.equal(dto.ok, false); assert.equal(dto.error.code, branch === "ambiguous" ? "ambiguous_match" : "incomplete_read");
      const [missing, explicitNull, zero] = dto.evidence.candidates;
      assert.equal(missing.cardType, "unknown");
      for (const key of ["accountSeq", "status", "derivedStatus", "isDoc", "deck", "milestone", "assignee"]) assert.equal(Object.hasOwn(missing, key), false, key);
      absentRefs(missing); absentRefs(explicitNull);
      for (const key of ["accountSeq", "status", "derivedStatus", "isDoc", "deck", "milestone", "assignee"]) assert.equal(explicitNull[key], null, key);
      assert.equal(explicitNull.cardType, "unknown"); assert.equal(zero.accountSeqRef, "seq:0"); assert.equal(zero.isDoc, false); assert.equal(zero.accountSeq, 0);
      const legacy = JSON.parse(result.text.match(/```json\s*([\s\S]*)\s*```/)![1]);
      assert.equal(legacy.error.candidates[0].cardType, "regular"); assert.equal(legacy.error.candidates[0].accountSeq, null);
      assert.equal(requests, branch === "ambiguous" ? 1 : branch === "incomplete" ? 6 : 2);
    } finally { globalThis.fetch = original; core.__test.resetRateGate(); }
  });
}
test("schema-valid post-hook byte overflow has its distinct safe error code", () => {
  const dto = projectCardGetOutput({ ok: true, action: "card-get", data: { card: { contentTrust: "external" } } });
  const oversized = { ...dto, card: { ...dto.card, content: "😀".repeat(20000) } };
  assert.equal(Value.Check(CARD_GET_OUTPUT_SCHEMA, oversized), true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > 65536);
  const result = finalizeCardGetOutput({ toolName: "codecks_card_get", structuredContent: oversized, isError: false });
  assert.equal(result.isError, true); assert.equal(result.structuredContent.ok, false); assert.equal(result.structuredContent.error.code, "output_too_large");
  assert.equal(JSON.stringify(result).includes("😀"), false);
});
