import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as core from "../src/codecks-core.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
const USER_ID = "33333333-3333-4333-8333-333333333333";
const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const parse = (value: unknown) => JSON.parse(String(value).match(/```json\s*([\s\S]*?)\s*```/)![1]);
const loggedIn = { data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Sam" } } } };
const originalFetch = globalThis.fetch;
let dispatches = 0;
globalThis.fetch = (async (input, init) => {
  if (String(input).includes("/dispatch/cards/create")) { dispatches += 1; return new Response(JSON.stringify({ payload: { id: `created-${dispatches}`, accountSeq: dispatches } }), { status: 200 }); }
  const query = JSON.parse(String(init?.body)).query as Record<string, unknown>;
  if (JSON.stringify(query).includes("loggedInUser")) return new Response(JSON.stringify(loggedIn), { status: 200 });
  if (Object.keys(query).some(key => key.startsWith("user("))) return new Response(JSON.stringify({ data: { user: { [USER_ID]: { id: USER_ID, name: "Sam" }, [OTHER_USER_ID]: { id: OTHER_USER_ID, name: "Other" } } } }), { status: 200 });
  if (Object.keys(query).some(key => key.startsWith("card("))) return new Response(JSON.stringify({ data: { card: { [PARENT_ID]: { cardId: PARENT_ID, title: "Parent", accountSeq: 9, isDoc: false } } } }), { status: 200 });
  throw new Error(`unexpected query ${JSON.stringify(query)}`);
}) as typeof fetch;

try {
  const preview = async (cards: unknown[]) => parse(await core.card_bulk_create.execute({ cards, dryRun: true, format: "json" }));
  const cards = [{ title: "Alpha", correlationKey: "row-a" }, { title: "Beta", correlationKey: "row-b" }];
  const first = await preview(cards);
  const second = await preview(cards);
  assert.match(first.data.previewFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(first.data.previewFingerprint, second.data.previewFingerprint, "unchanged normalized intent has a stable fingerprint");
  assert.equal(dispatches, 0);
  assert.equal(JSON.parse(readFileSync(first.data.artifact.path, "utf8")).previewFingerprint, first.data.previewFingerprint);
  const text = String(await core.card_bulk_create.execute({ cards, dryRun: true }));
  assert.match(text, new RegExp(`Preview Fingerprint: ${first.data.previewFingerprint}`));

  const matching = parse(await core.card_bulk_create.execute({ cards, dryRun: false, expectedPreviewFingerprint: first.data.previewFingerprint, format: "json" }));
  assert.equal(matching.ok, true); assert.equal(matching.data.created, 2); assert.equal(dispatches, 2);

  const reject = async (applyCards: unknown[], fingerprint: unknown) => {
    const before = dispatches;
    const result = parse(await core.card_bulk_create.execute({ cards: applyCards, dryRun: false, expectedPreviewFingerprint: fingerprint as string, format: "json" }));
    assert.equal(result.ok, false); assert.equal(result.error.category, "validation_error"); assert.equal(result.error.dispatchRequests, 0);
    assert.equal(dispatches, before, "invalid preview binding must make zero create dispatches");
    assert.ok(result.error.results.every((record: { status: string; certainty: string }) => record.status === "definitely_unsent" && record.certainty === "definitely_unsent"));
    return result;
  };
  await reject(cards, undefined);
  await reject(cards, "not-a-fingerprint");
  await reject([cards[0]], first.data.previewFingerprint);
  await reject([cards[1], cards[0]], first.data.previewFingerprint);
  await reject([{ title: "Changed" }, cards[1]], first.data.previewFingerprint);

  for (const changed of [
    [{ title: "Alpha", assigneeId: OTHER_USER_ID }, { title: "Beta" }],
    [{ title: "Alpha", effort: 5 }, { title: "Beta" }],
    [{ title: "Alpha", parentCardId: PARENT_ID }, { title: "Beta" }],
  ]) await reject(changed, first.data.previewFingerprint);

  const noCorrelation = await preview([{ title: "Alpha" }, { title: "Beta" }]);
  assert.equal(noCorrelation.data.previewFingerprint, first.data.previewFingerprint, "correlation keys do not alter dispatched intent");

  const sensitiveTitle = "normalized-title-must-not-appear";
  const sensitiveContent = "normalized-content-must-not-appear";
  const opaqueFingerprint = "opaque-expected-fingerprint-must-not-appear";
  const sensitiveReject = await reject([{
    title: sensitiveTitle,
    content: sensitiveContent,
    assigneeId: OTHER_USER_ID,
    parentCardId: PARENT_ID,
    correlationKey: "safe-row-correlation",
  }], opaqueFingerprint);
  const serializedReject = JSON.stringify(sensitiveReject);
  for (const forbidden of [sensitiveTitle, sensitiveContent, OTHER_USER_ID, PARENT_ID, opaqueFingerprint]) {
    assert.doesNotMatch(serializedReject, new RegExp(forbidden));
  }
  assert.deepEqual(sensitiveReject.error.results, [{ index: 0, correlationKey: "safe-row-correlation", status: "definitely_unsent", certainty: "definitely_unsent" }]);
  assert.match(sensitiveReject.error.actualPreviewFingerprint, /^[a-f0-9]{64}$/);

  const highPriority = await preview([{ title: "Priority alias", priority: "high" }]);
  const aPriority = await preview([{ title: "Priority alias", priority: "a" }]);
  assert.equal(highPriority.data.previewFingerprint, aPriority.data.previewFingerprint, "normalized priority aliases share a fingerprint");
} finally { globalThis.fetch = originalFetch; }
console.log("bulk create preview fingerprint tests passed");
