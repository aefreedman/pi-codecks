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
  const checked = parse(await invoke({ cards: [{ title: "Check" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(identityReads, 1);
  assert.equal(checked.data.results[0].status, "created");
  assert.equal(checked.data.results[0].certainty, "dispatch_returned");
  assert.equal(checked.data.results[0].verificationState, "mismatch");
  assert.deepEqual(checked.data.results[0].verificationCheckedFields, ["cardId", "accountSeq"]);
  assert.equal(checked.data.results[0].persistedVerified, undefined);
  assert.equal(checked.data.results[0].verificationObservedIdentity.cardId, "other");
  const mismatchText = String(await invoke({ cards: [{ title: "Check text" }], dryRun: false, verification: "identity" }));
  assert.match(mismatchText, /verification mismatch \(cardId, accountSeq\); observed \$/);

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
  const unidentified = parse(await invoke({ cards: [{ title: "No identity" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(unidentified.data.results[0].verificationState, "not_identifiable");
  assert.equal(unidentified.data.results[0].certainty, "dispatch_returned");
  assert.equal(identityReads, 0);
  const unidentifiedText = String(await invoke({ cards: [{ title: "No identity text" }], dryRun: false, verification: "identity" }));
  assert.match(unidentifiedText, /verification not_identifiable/);

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
  const absent = parse(await invoke({ cards: [{ title: "Eventually visible" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(identityReads, 1);
  assert.equal(absent.data.results[0].status, "created");
  assert.equal(absent.data.results[0].verificationState, "not_found");
  assert.deepEqual(absent.data.results[0].verificationCheckedFields, []);
  assert.match(absent.data.results[0].verificationWarning, /eventual-consistency/i);

  let failedReadRequests = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) { failedReadRequests += 1; return new Response("unavailable", { status: 503, statusText: "Unavailable" }); }
    return response(emptyCards(key!));
  }) as typeof fetch;
  const readFailure = parse(await invoke({ cards: [{ title: "Read failure" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(failedReadRequests, 1, "verification must not retry a 503 read");
  assert.equal(readFailure.data.results[0].status, "created");
  assert.equal(readFailure.data.results[0].verificationState, "read_failed");
  assert.equal(readFailure.data.results[0].verificationError.category, "api_error");
  const readFailureText = String(await invoke({ cards: [{ title: "Read failure text" }], dryRun: false, verification: "identity" }));
  assert.match(readFailureText, /verification read_failed; verification read error: Codecks API error 503/);

  let timeoutReadRequests = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) { timeoutReadRequests += 1; throw new DOMException("timeout", "AbortError"); }
    return response(emptyCards(key!));
  }) as typeof fetch;
  const timeoutFailure = parse(await invoke({ cards: [{ title: "Timeout failure" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(timeoutReadRequests, 1, "verification must not retry a timeout read");
  assert.equal(timeoutFailure.data.results[0].verificationState, "read_failed");
  assert.equal(timeoutFailure.data.results[0].verificationError.category, "request_timeout");

  // Compact and text results retain a verified identity outcome without exposing a
  // normalized payload. Detailed compatibility persistence is reserved for verified identities.
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD, accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    if (/"accountSeq":\[/.test(key!)) return response({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key!]: [CARD] } }, card: { [CARD]: { cardId: CARD, accountSeq: 81, title: "Verified" } } } });
    return response(emptyCards(key!));
  }) as typeof fetch;
  const verified = parse(await invoke({ cards: [{ title: "Verified" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(verified.data.results[0].verificationState, "identity_verified");
  assert.deepEqual(verified.data.results[0].verificationCheckedFields, ["cardId", "accountSeq"]);
  assert.equal(verified.data.results[0].verificationObservedIdentity.cardId, CARD);
  const verifiedDetailed = parse(await invoke({ cards: [{ title: "Verified detailed" }], dryRun: false, verification: "identity", outputMode: "detailed", format: "json" }));
  assert.equal(verifiedDetailed.data.results[0].persistedVerified.cardId, CARD);
  const verifiedText = String(await invoke({ cards: [{ title: "Verified text" }], dryRun: false, verification: "identity" }));
  assert.match(verifiedText, /verification identity_verified \(cardId, accountSeq\); observed \$13w/);

  // A card-ID-only dispatch compares only cardId and surfaces a neutral mismatch observation.
  let cardIdReads = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { id: CARD } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const direct = Object.keys(query).find((key) => key.startsWith("card("));
    if (direct) { cardIdReads += 1; return response({ data: { card: { [CARD]: { cardId: "other", accountSeq: 82, title: "Other" } } } }); }
    const key = relationKey(query, "cards");
    assert.ok(key);
    return response(emptyCards(key!));
  }) as typeof fetch;
  const cardOnlyMismatch = parse(await invoke({ cards: [{ title: "Card only" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(cardIdReads, 1);
  assert.equal(cardOnlyMismatch.data.results[0].verificationState, "mismatch");
  assert.deepEqual(cardOnlyMismatch.data.results[0].verificationCheckedFields, ["cardId"]);
  assert.equal(cardOnlyMismatch.data.results[0].verificationObservedIdentity.accountSeq, 82);

  // An account-sequence-only dispatch keeps a missing read unverified rather than
  // claiming either identity field was checked. Text exposes the outcome and warning.
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) return response({ payload: { accountSeq: 81 } });
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    return response(emptyCards(key!));
  }) as typeof fetch;
  const accountOnlyNotFound = parse(await invoke({ cards: [{ title: "Sequence only" }], dryRun: false, verification: "identity", format: "json" }));
  assert.equal(accountOnlyNotFound.data.results[0].verificationState, "not_found");
  assert.deepEqual(accountOnlyNotFound.data.results[0].verificationCheckedFields, []);
  const notFoundText = String(await invoke({ cards: [{ title: "Sequence only text" }], dryRun: false, verification: "identity" }));
  assert.match(notFoundText, /verification not_found; Identity was not found after one read; this can be eventual-consistency delay/);

  // Probe/fallback metadata preserves both stages instead of replacing title-probe accounting.
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    const titleProbe = /"title"/.test(key!);
    const ids = titleProbe ? ["probe-a", "probe-b"] : ["fallback"];
    return response({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key!]: ids } }, card: {} } });
  }) as typeof fetch;
  const oneProbeFallback = parse(await invoke({ cards: [{ title: "One probe" }], dryRun: true, duplicateScanLimit: 2, format: "json" }));
  assert.equal(oneProbeFallback.data.scan.requestsAttempted, 2);
  assert.equal(oneProbeFallback.data.scan.scanned, 3);
  assert.deepEqual(oneProbeFallback.data.scan.stages.map((stage: Json) => stage.stage), ["title_contains", "account_fallback"]);
  assert.equal(oneProbeFallback.data.scan.stages[0].probesAttempted, 1);

  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    const titleProbe = /"title"/.test(key!);
    const ids = titleProbe ? ["probe"] : [];
    return response({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key!]: ids } }, card: {} } });
  }) as typeof fetch;
  const fourProbeFallback = parse(await invoke({ cards: ["A", "B", "C", "D"].map((title) => ({ title })), dryRun: true, duplicateScanLimit: 1, format: "json" }));
  assert.equal(fourProbeFallback.data.scan.requestsAttempted, 5);
  assert.equal(fourProbeFallback.data.scan.scanned, 4);
  assert.equal(fourProbeFallback.data.scan.stages[0].probesAttempted, 4);
  assert.equal(fourProbeFallback.data.scan.stages[1].requestsAttempted, 1);

  // A server root semantic rejection retains its failed logical probe before the
  // account fallback; ordinary transport failures still stop rather than widen.
  let semanticRequests = 0;
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    semanticRequests += 1;
    if (/"title"/.test(key!)) return response({ errors: [{ message: "title contains filter unsupported" }] });
    return response(emptyCards(key!));
  }) as typeof fetch;
  const semanticFallback = parse(await invoke({ cards: [{ title: "Rejected" }], dryRun: true, format: "json" }));
  assert.equal(semanticFallback.ok, true);
  assert.equal(semanticRequests, 2, "the rejected title request and one fallback request were sent");
  assert.equal(semanticFallback.data.scan.requestsAttempted, 2);
  assert.equal(semanticFallback.data.scan.scanned, 0);
  assert.equal(semanticFallback.data.scan.fallback, "title_contains_semantically_rejected");
  assert.equal(semanticFallback.data.scan.semanticRejectedProbes, 1);
  assert.equal(semanticFallback.data.scan.semanticRejectedRequests, 1);
  assert.deepEqual(semanticFallback.data.scan.stages.map((stage: Json) => stage.stage), ["title_contains", "account_fallback"]);
  assert.equal(semanticFallback.data.scan.stages[0].probesAttempted, 1);
  assert.equal(semanticFallback.data.scan.stages[0].semanticRejectedProbes, 1);
  assert.equal(semanticFallback.data.scan.stages[0].semanticRejectedRequests, 1);
  for (const stage of semanticFallback.data.scan.stages) {
    assert.equal(typeof stage.queueWaitMs, "number");
    assert.equal(typeof stage.elapsedMs, "number");
  }

  let transportRequests = 0;
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    transportRequests += 1;
    throw new Error("network unavailable");
  }) as typeof fetch;
  const transportFailure = parse(await invoke({ cards: [{ title: "No widening" }], dryRun: true, format: "json" }));
  assert.equal(transportFailure.ok, false);
  assert.equal(transportRequests, 1, "transport failure must not issue an account fallback request");

  let pagedTitleRequests = 0;
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    pagedTitleRequests += 1;
    const ids = pagedTitleRequests === 1 ? Array.from({ length: 500 }, (_, index) => `page-${index}`) : [];
    return response({ data: { _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key!]: ids } }, card: {} } });
  }) as typeof fetch;
  const pagedProbe = parse(await invoke({ cards: [{ title: "Paged" }], dryRun: true, duplicateScanLimit: 501, format: "json" }));
  assert.equal(pagedProbe.data.scan.requestsAttempted, 2, "one logical title probe may paginate");
  assert.equal(pagedProbe.data.scan.stages.length, 1);
  assert.equal(pagedProbe.data.scan.stages[0].probesAttempted, 1);
  assert.equal(pagedProbe.data.scan.bounds.titleRequestBudgetUnit, "logical_title_probes");

  // Accessible archived cards remain duplicate evidence, while deleted cards do not.
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const key = relationKey(query, "cards");
    assert.ok(key);
    return response({ data: {
      _root: { account: ACCOUNT }, account: { [ACCOUNT]: { id: ACCOUNT, [key!]: ["archived", "deleted"] } },
      card: {
        archived: { cardId: "archived", accountSeq: 82, title: "Visibility check", visibility: "archived" },
        deleted: { cardId: "deleted", accountSeq: 83, title: "Visibility check", visibility: "deleted" },
      },
    } });
  }) as typeof fetch;
  const visibilityEvidence = parse(await invoke({ cards: [{ title: "Visibility check" }], dryRun: true, format: "json" }));
  assert.equal(visibilityEvidence.data.results[0].duplicateCandidates.length, 1);
  assert.equal(visibilityEvidence.data.results[0].duplicateCandidates[0].visibility, "archived");

  // Parent-scoped required dry-runs stay useful normalized previews while the same
  // required apply remains blocked and neither path dispatches a create.
  let parentCreates = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) { parentCreates += 1; return response({}); }
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    const direct = Object.keys(query).find((key) => key.startsWith("card("));
    assert.ok(direct);
    return response({ data: { card: { [CARD]: { cardId: CARD, accountSeq: 81, title: "Parent" } } } });
  }) as typeof fetch;
  const parentPreview = parse(await invoke({ cards: [{ title: "Child", parentCardId: CARD }], format: "json" }));
  assert.equal(parentPreview.ok, true);
  assert.equal(parentPreview.data.outputMode, "detailed");
  assert.equal(parentPreview.data.scan.policyOutcome, "parent_local_required_unavailable");
  assert.equal(parentPreview.data.scan.requestsAttempted, 0);
  assert.equal(parentPreview.data.results[0].normalizedRequested.parent.cardId, CARD);
  assert.equal(parentCreates, 0);
  assert.ok(parentPreview.warnings.some((warning: string) => /parent-local duplicate matching is unavailable/i.test(warning)));
  const parentApply = parse(await invoke({ cards: [{ title: "Child", parentCardId: CARD }], dryRun: false, duplicatePolicy: "required", format: "json" }));
  assert.equal(parentApply.ok, false);
  assert.equal(parentApply.error.category, "conflict");
  assert.equal(parentCreates, 0);

  console.log("bulk create simplification tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
