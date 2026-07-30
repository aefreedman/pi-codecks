import assert from "node:assert/strict";
import * as core from "../src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "test-account";
process.env.CODECKS_TOKEN = "test-token";

const CARD_ID = "11111111-1111-4111-8111-111111111111";
const response = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
const parseResult = (value: unknown): Record<string, any> => {
  const match = String(value).match(/```json\s*([\s\S]*?)\s*```/i);
  assert.ok(match, `expected structured result: ${String(value)}`);
  return JSON.parse(match[1]);
};
const invoke = (tool: any, args: Record<string, unknown>) => core.runWithAbortSignal(undefined, () => tool.execute(args), process.cwd());
const deckPayload = () => ({ data: { _root: { account: "account-1" }, account: { "account-1": { id: "account-1", decks: ["deck-1"] } }, deck: { "deck-1": { id: "deck-1", accountSeq: 7, title: "Test Deck", description: "Current — 😀", isDeleted: false } } } });
const cardPayload = () => ({ data: { card: { [CARD_ID]: { cardId: CARD_ID, accountSeq: 31, title: "Existing", content: "Existing\n\nBody", status: "not_started", isDoc: false } } } });

const originalFetch = globalThis.fetch;
try {
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("must not dispatch"); }) as typeof fetch;
  const replacement = parseResult(await invoke(core.card_create, { title: "bad\ufffdtitle", format: "json" }));
  assert.equal(replacement.ok, false);
  assert.equal(replacement.error.category, "validation_error");
  assert.match(replacement.error.message, /title.*U\+FFFD.*UTF-16 offset 3.*code-point offset 3/i);
  const surrogate = parseResult(await invoke(core.deck_update, { deckId: "deck-1", description: "bad\ud800", format: "json" }));
  assert.equal(surrogate.ok, false);
  assert.match(surrogate.error.message, /description.*unpaired UTF-16 surrogate.*offset 3/i);
  assert.equal(calls, 0, "corrupt caller text is rejected before any lookup or dispatch");

  calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error("must not dispatch"); }) as typeof fetch;
  const invalidBatch = parseResult(await invoke(core.card_bulk_update, {
    dryRun: false,
    updates: [
      { cardId: CARD_ID, title: "one" },
      { cardId: CARD_ID, title: "two" },
      { cardId: CARD_ID, title: "three" },
      { cardId: CARD_ID, title: "four\ufffd" },
    ],
    format: "json",
  }));
  assert.equal(invalidBatch.ok, false);
  assert.equal(invalidBatch.error.requestsAttempted, 0);
  assert.equal(invalidBatch.error.results[0].status, "definitely_unsent");
  assert.equal(invalidBatch.error.results[3].status, "failed");
  assert.equal(calls, 0, "a malformed fourth record prevents every bulk dispatch");

  globalThis.fetch = (async (_input, init) => {
    const url = String(_input);
    if (url.includes("/dispatch/cards/update")) return response({ data: { accepted: true } });
    const query = JSON.parse(String(init?.body)).query as Record<string, unknown>;
    assert.ok(Object.keys(query).some((key) => key.startsWith("card(")), `unexpected query: ${JSON.stringify(query)}`);
    return response(cardPayload());
  }) as typeof fetch;
  const applied = parseResult(await invoke(core.card_bulk_update, {
    dryRun: false,
    updates: [{ cardId: CARD_ID, title: "Valid — 😀", correlationKey: "import-row-1" }],
    format: "json",
  }));
  assert.equal(applied.ok, true);
  const record = applied.data.results[0];
  assert.equal(record.correlationKey, "import-row-1");
  assert.match(record.actionKey, /^update:0:[a-f0-9]{24}$/);
  assert.equal(record.status, "updated");
  assert.equal(record.certainty, "dispatch_returned");
  assert.equal(record.persistedVerified, null);
  assert.equal(record.verificationState, "not_performed");
  assert.equal(record.normalizedRequested.title, "Valid — 😀");
  assert.deepEqual(record.dispatchReturned, { accepted: true });

  globalThis.fetch = (async () => response(deckPayload())) as typeof fetch;
  const deck = parseResult(await invoke(core.deck_get, { title: "Test Deck", format: "json" }));
  assert.equal(deck.ok, true);
  assert.equal(deck.data.deckId, "deck-1");
  assert.equal(deck.data.description, "Current — 😀");
  assert.equal(deck.data.isDeleted, false);

  console.log("backlog hardening tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
