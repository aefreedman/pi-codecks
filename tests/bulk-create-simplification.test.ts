import assert from "node:assert/strict";
import * as core from "../src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "test-account";
process.env.CODECKS_TOKEN = "test-token";

type Json = Record<string, any>;
const ACCOUNT = "account-test";
const USER = "33333333-3333-4333-8333-333333333333";
const DECK = "22222222-2222-4222-8222-222222222222";
const CARD = "11111111-1111-4111-8111-111111111111";
const response = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
const parse = (value: unknown): Json => {
  const match = String(value).match(/```json\s*([\s\S]*?)\s*```/i);
  assert.ok(match);
  return JSON.parse(match[1]);
};
const relationKey = (query: Json, name: string): string | undefined => (query._root?.[0]?.account ?? [])
  .flatMap((entry: Json) => Object.keys(entry)).find((key: string) => key === name || key.startsWith(`${name}(`));
const login = () => ({ data: { _root: { loggedInUser: USER }, user: { [USER]: { id: USER, name: "Sam" } } } });
const emptyCards = (key: string, ids: string[] = []) => ({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key]: ids } }, card: {} } });
const invoke = (args: Json) => core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute(args), process.cwd());

const originalFetch = globalThis.fetch;
try {
  // A scan-limit hit is incomplete evidence, but normal apply is explicitly best effort.
  let creates = 0;
  let scanCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) { creates += 1; return response({ payload: { id: CARD, accountSeq: 81 } }); }
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const deckKey = relationKey(query, "decks");
    if (deckKey) return response({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [deckKey]: [DECK] } }, deck: { [DECK]: { id: DECK, title: "Known" } } } });
    const key = relationKey(query, "cards");
    assert.ok(key);
    scanCalls += 1;
    // This represents an account with more than 3,000 accessible cards without
    // making the credential-free fixture serialize all card objects.
    return response(emptyCards(key!, Array.from({ length: 3000 }, (_, index) => `row-${index}`)));
  }) as typeof fetch;
  const bestEffort = parse(await invoke({ cards: [{ title: "Known Deck", deck: DECK }], dryRun: false, format: "json" }));
  assert.equal(bestEffort.ok, true);
  assert.equal(creates, 1);
  assert.equal(bestEffort.data.responseSchemaVersion, 2);
  assert.equal(bestEffort.data.duplicatePolicy, "best_effort");
  assert.equal(bestEffort.data.duplicateDiscovery.complete, false);
  assert.equal(bestEffort.data.duplicateDiscovery.policyOutcome, "best_effort_proceeded");
  assert.equal(bestEffort.data.results[0].cardRef, "$13w");
  assert.equal(scanCalls, 2, "a known Deck is not blocked by unrelated account size even after conservative fallback");

  creates = 0;
  const required = parse(await invoke({ cards: [{ title: "Known Deck", deck: DECK }], dryRun: false, duplicatePolicy: "required", format: "json" }));
  assert.equal(required.ok, false);
  assert.equal(required.error.category, "conflict");
  assert.equal(creates, 0);

  // skip performs no card relation request. duplicateLimit=0 still discovers by default.
  let cardQueries = 0;
  creates = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) { creates += 1; return response({ payload: { id: CARD, accountSeq: 81 } }); }
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    cardQueries += 1;
    return response(emptyCards(key!));
  }) as typeof fetch;
  const skipped = parse(await invoke({ cards: [{ title: "Skip" }], dryRun: false, duplicatePolicy: "skip", format: "json" }));
  assert.equal(skipped.ok, true);
  assert.equal(cardQueries, 0);
  assert.equal(skipped.data.duplicateDiscovery.policyOutcome, "skipped_by_request");
  const limitZero = parse(await invoke({ cards: [{ title: "Still discover" }], dryRun: true, duplicateLimit: 0, format: "json" }));
  assert.equal(limitZero.ok, true);
  assert.equal(cardQueries, 1);
  assert.deepEqual(limitZero.data.results[0].duplicateCandidates, []);

  // Small mixed targets use one title-contains relation per normalized title, with
  // client-side exact title/scope matching and no milestone filter dependency.
  cardQueries = 0;
  const mixed = parse(await invoke({ cards: [{ title: "Alpha", deck: 7 }, { title: "Beta", milestone: 8 }, { title: "Alpha", deck: 7 }], dryRun: true, format: "json" }));
  assert.equal(mixed.ok, true);
  assert.equal(mixed.data.scan.strategy, "title_contains");
  assert.equal(cardQueries, 2);

  // Default text apply foregrounds the dispatch reference; default verification reads none.
  let identityReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) identityReads += 1;
    return response(emptyCards(key!));
  }) as typeof fetch;
  const text = String(await invoke({ cards: [{ title: "Reference", correlationKey: "source-1" }], dryRun: false }));
  assert.match(text, /#1 \[source-1\] created\/dispatch_returned \$13w/);
  assert.equal(identityReads, 0);

  // Identity verification has one exact read per identifiable create and reports a
  // mismatch without changing dispatch certainty or retrying the create.
  identityReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) {
      identityReads += 1;
      return response({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key!]: ["other"] } }, card: { other: { cardId: "other", accountSeq: 82, title: "Other" } } } });
    }
    return response(emptyCards(key!));
  }) as typeof fetch;
  const checked = parse(await invoke({ cards: [{ title: "Check" }], dryRun: false, verification: "identity", outputMode: "detailed", format: "json" }));
  assert.equal(identityReads, 1);
  assert.equal(checked.data.results[0].status, "created");
  assert.equal(checked.data.results[0].verificationState, "mismatch");
  assert.deepEqual(checked.data.results[0].verificationCheckedFields, ["cardId", "accountSeq"]);

  // An unidentifiable dispatch does not trigger a query. A one-shot absent read is
  // explicitly an eventual-consistency possibility, not a failed create.
  identityReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ accepted: true });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) identityReads += 1;
    return response(emptyCards(key!));
  }) as typeof fetch;
  const unidentified = parse(await invoke({ cards: [{ title: "No identity" }], dryRun: false, verification: "identity", outputMode: "detailed", format: "json" }));
  assert.equal(unidentified.data.results[0].verificationState, "not_identifiable");
  assert.equal(identityReads, 0);

  identityReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) identityReads += 1;
    return response(emptyCards(key!));
  }) as typeof fetch;
  const absent = parse(await invoke({ cards: [{ title: "Eventually visible" }], dryRun: false, verification: "identity", outputMode: "detailed", format: "json" }));
  assert.equal(identityReads, 1);
  assert.equal(absent.data.results[0].status, "created");
  assert.equal(absent.data.results[0].verificationState, "not_found");
  assert.match(absent.data.results[0].verificationWarning, /eventual-consistency/i);

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) return new Response("unavailable", { status: 503, statusText: "Unavailable" });
    return response(emptyCards(key!));
  }) as typeof fetch;
  const readFailure = parse(await invoke({ cards: [{ title: "Read failure" }], dryRun: false, verification: "identity", outputMode: "detailed", format: "json" }));
  assert.equal(readFailure.data.results[0].status, "created");
  assert.equal(readFailure.data.results[0].verificationState, "read_failed");

  console.log("bulk create simplification tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
