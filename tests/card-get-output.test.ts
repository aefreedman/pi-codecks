import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { CARD_GET_OUTPUT_SCHEMA, CARD_GET_LIMITS, projectCardGetOutput, isCardGetOutput, finalizeCardGetOutput } from "../src/card-get-output.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
const success = (card: Record<string, unknown> = {}) => ({ ok: true, action: "card-get", data: { card: { contentTrust: "external", cardId: "fixture-card", ...card } } });
const error = (fields: Record<string, unknown> = {}) => ({ ok: false, action: "card-get", error: { category: "not_found", message: "Not found", ...fields } });

test("projects only the bounded public allowlist without arbitrary data or fabricated artifacts", () => {
  const value = projectCardGetOutput(success({ cardRef: "$12g", accountSeqRef: "seq:42", transport: { token: "fixture" }, artifact: "/private/path" }));
  assert.equal(value.ok, true); assert.ok(isCardGetOutput(value));
  assert.equal(value.card.cardRef, "$12g"); assert.equal(value.card.accountSeqRef, "seq:42");
  assert.equal(Object.hasOwn(value.card, "transport"), false); assert.equal(Object.hasOwn(value.card, "artifact"), false);
  assert.deepEqual(value.provenance, { source: "codecks", contentTrust: "external" });
});
test("preserves zero, false, explicit null, empty strings, and absent fields", () => {
  const value = projectCardGetOutput(success({ accountSeq: 0, effort: 0, isDoc: false, dueDate: null, content: "", deck: { title: "", accountSeq: 0 }, milestone: { isGlobal: false } }));
  assert.equal(value.ok, true); assert.equal(value.card.accountSeq, 0); assert.equal(value.card.effort, 0); assert.equal(value.card.isDoc, false);
  assert.equal(value.card.dueDate, null); assert.equal(value.card.content, ""); assert.equal(Object.hasOwn(value.card, "priority"), false);
  assert.equal(value.card.milestone.isGlobal, false); assert.equal(Object.hasOwn(value.card.deck, "id"), false);
});
test("projects error evidence but never arbitrary error data", () => {
  const value = projectCardGetOutput(error({ recoveryHint: "Use seq:0", suggestedCardRef: "seq:0", token: "fixture", request: { authorization: "fixture" }, candidates: [{ cardRef: "$zz", accountSeq: 0, title: "Card", internal: "private" }] }));
  assert.equal(value.ok, false); assert.equal(value.error.code, "not_found"); assert.equal(value.evidence.suggestedCardRef, "seq:0");
  assert.equal(JSON.stringify(value).includes("private"), false); assert.equal(Object.hasOwn(value.error, "request"), false);
});
test("incomplete read is not absence or uniqueness evidence", () => {
  const value = projectCardGetOutput(error({ category: "incomplete_read", complete: false, candidates: [{ title: "Possible" }] }));
  assert.equal(value.ok, false); assert.equal(value.completeness.read, "incomplete"); assert.equal(value.evidence.candidates.length, 1);
});
test("string and array bounds clip with explicit projection incompleteness", () => {
  const value = projectCardGetOutput(success({ title: "a".repeat(2049), content: "a".repeat(32769), tags: Array(26).fill("tag"), childCards: Array(26).fill({ title: "Child" }) }));
  assert.equal(value.ok, true); assert.equal(value.card.title.length, 2048); assert.equal(value.card.content.length, 32768);
  assert.equal(value.card.tags.length, 25); assert.equal(value.card.childCards.length, 25); assert.equal(value.completeness.projection, false);
});
test("candidate and error-message bounds", () => {
  const value = projectCardGetOutput(error({ message: "x".repeat(2049), candidates: Array(6).fill({ title: "Match" }) }));
  assert.equal(value.error.message.length, 2048); assert.equal(value.evidence.candidates.length, 5); assert.equal(value.completeness.projection, false);
});
test("Unicode clipping preserves code points; byte budget fails closed", () => {
  const unicode = projectCardGetOutput(success({ title: "😀".repeat(2049) }));
  assert.equal(unicode.ok, true); assert.equal(Array.from(unicode.card.title).length, 2048); assert.equal(unicode.completeness.projection, false);
  const oversized = projectCardGetOutput(success({ content: "😀".repeat(32768) }));
  assert.equal(oversized.ok, false); assert.equal(oversized.error.code, "output_too_large"); assert.ok(Buffer.byteLength(JSON.stringify(oversized)) < CARD_GET_LIMITS.bytes);
});
for (const [name, payload] of Object.entries({ missing: undefined, wrongAction: { ...success(), action: "other" }, invalidDiscriminator: { ...success(), ok: "true" }, missingCard: { ok: true, action: "card-get", data: {} }, invalidScalar: success({ effort: "0" }), invalidTrust: success({ contentTrust: "internal" }), unsafeSequence: success({ accountSeq: Number.MAX_SAFE_INTEGER + 1 }), nonFinite: success({ effort: Infinity }), invalidRelation: success({ deck: [] }), missingError: { ok: false, action: "card-get" } })) {
  test(`malformed ${name} becomes bounded domain failure, not text success`, () => {
    const value = projectCardGetOutput(payload); assert.equal(value.ok, false); assert.equal(value.error.code, "output_contract_error"); assert.ok(isCardGetOutput(value));
  });
}
test("strict schema rejects unknown keys at every object depth", () => {
  const value = projectCardGetOutput(success({ deck: { title: "Deck" } }));
  for (const bad of [{ ...value, private: true }, { ...value, card: { ...value.card, private: true } }, { ...value, card: { ...value.card, deck: { title: "Deck", private: true } } }]) assert.equal(Value.Check(CARD_GET_OUTPUT_SCHEMA, bad), false);
});
test("conformance guard validates data and native status without restoring rejected payload", () => {
  const good = projectCardGetOutput(success());
  assert.equal(finalizeCardGetOutput({ toolName: "other", structuredContent: undefined, isError: false }), undefined);
  assert.equal(finalizeCardGetOutput({ toolName: "codecks_card_get", structuredContent: good, isError: false }), undefined);
  for (const [structuredContent, isError] of [[undefined, false], [{ ...good, extra: "rejected-secret" }, false], [good, true], [projectCardGetOutput(error()), false]] as const) {
    const replacement = finalizeCardGetOutput({ toolName: "codecks_card_get", structuredContent, isError });
    assert.equal(replacement?.isError, true); assert.equal(replacement?.structuredContent.ok, false); assert.ok(isCardGetOutput(replacement?.structuredContent));
    assert.equal(JSON.stringify(replacement).includes("rejected-secret"), false);
  }
});
test("real internal read seam preserves missing vs null without changing legacy text", async () => {
  const core = await import("../src/codecks-core.ts");
  const fetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: { _root: { account: "fixture" }, account: { fixture: { 'cards({"accountSeq":[0]})': ["fixture-card"] } }, card: { "fixture-card": { cardId: "fixture-card", accountSeq: 0, title: "Card", effort: 0, isDoc: false, dueDate: null, content: null, deck: { title: "Deck" }, parentCard: { cardId: "parent", title: "Parent" }, childCards: [{ cardId: "child", title: "Child" }] } } } }))) as typeof globalThis.fetch;
  try {
    const read = await core.runWithAbortSignal(undefined, () => core.readCardGet({ cardId: "seq:0" }));
    const value = projectCardGetOutput(read.payload);
    assert.equal(value.ok, true); assert.equal(value.card.content, null); assert.equal(value.card.dueDate, null); assert.equal(value.card.effort, 0); assert.equal(value.card.isDoc, false);
    assert.equal(Object.hasOwn(value.card, "priority"), false); assert.match(read.text, /```json/);
    assert.equal(Object.hasOwn(value.card.deck, "id"), false);
    assert.equal(Object.hasOwn(value.card.parentCard, "accountSeq"), false);
    assert.equal(Object.hasOwn(value.card.parentCard, "isDoc"), false);
    assert.equal(value.card.parentCard.cardType, "unknown");
    assert.equal(Object.hasOwn(value.card.childCards[0], "status"), false);
  } finally { globalThis.fetch = fetch; core.__test.resetRateGate(); }
});
