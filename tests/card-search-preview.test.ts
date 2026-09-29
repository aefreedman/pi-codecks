import assert from "node:assert/strict";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
process.env.CODECKS_ACCOUNT = "example";

const core = await import("../src/codecks-core.ts");

type MockCard = Record<string, unknown>;

type FetchMockOptions = {
  rejectCardQueries?: boolean;
  ignoreDeckFilter?: boolean;
  denyCardQueries?: boolean;
  denyAggregate?: boolean;
  denyPageAtOffset?: number;
  keepChildRelationOnSummary?: boolean;
};

const deck = { id: "deck-dev", title: "Dev", accountSeq: 2 };
const otherDeck = { id: "deck-other", title: "Other", accountSeq: 3 };
const milestone = { id: "milestone-alpha", name: "Alpha", accountSeq: 84 };

const parseStructuredJson = (text: string): Record<string, any> => {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `expected structured json block in: ${text}`);
  return JSON.parse(match[1]);
};

const getCardsRelationKey = (query: any): string | undefined => {
  const root = query?._root?.[0];
  const accountEntries = root?.account;
  if (!Array.isArray(accountEntries)) return undefined;
  return accountEntries.flatMap((entry: any) => Object.keys(entry ?? {})).find((key: string) => key.startsWith("cards("));
};

const getCardsFilters = (request: any): Record<string, any> => {
  const key = getCardsRelationKey(request.query);
  assert.ok(key, "expected a paged account cards relation");
  return JSON.parse(key.slice("cards(".length, -1));
};

const makeCardsPayload = (relationKey: string, cards: MockCard[]) => ({
  data: {
    _root: {
      account: {
        [relationKey]: cards.map((card) => card.cardId),
      },
    },
    card: Object.fromEntries(cards.map((card) => [String(card.cardId), card])),
    deck: { "deck-dev": deck, "deck-other": otherDeck },
    milestone: { "milestone-alpha": milestone },
  },
});

let lastMockResponseSerializedBytes = 0;
const installFetchMock = (cards: MockCard[], options: FetchMockOptions = {}) => {
  const requests: any[] = [];
  lastMockResponseSerializedBytes = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    const queryText = JSON.stringify(body.query ?? {});

    if (queryText.includes("decks")) {
      return new Response(JSON.stringify({
        data: {
          _root: { account: { decks: ["deck-dev", "deck-other"] } },
          deck: { "deck-dev": deck, "deck-other": otherDeck },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (queryText.includes("milestones")) {
      return new Response(JSON.stringify({
        data: {
          _root: { account: { milestones: ["milestone-alpha"] } },
          milestone: { "milestone-alpha": milestone },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (options.rejectCardQueries) {
      throw new Error("mock Codecks outage");
    }
    if (options.denyCardQueries) {
      return new Response(JSON.stringify({ error: "missing_scope", path: "_root.account.cards", requiredScope: "card:read" }), { status: 403 });
    }
    if (options.denyAggregate && queryText.includes('count:childCards')) {
      return new Response(JSON.stringify({ error: "invalid_aggregate", path: "_root.account.cards", message: "Invalid aggregate selection" }), { status: 400 });
    }

    const relationKey = getCardsRelationKey(body.query);
    assert.ok(relationKey, `expected cards relation in ${queryText}`);
    const filters = getCardsFilters(body);
    if (options.denyPageAtOffset !== undefined && Number(filters.$offset ?? 0) >= options.denyPageAtOffset) {
      return new Response(JSON.stringify({ error: "missing_scope", path: "_root.account.cards", requiredScope: "card:read" }), { status: 403 });
    }
    const scopedCards = options.ignoreDeckFilter || filters.deckId === undefined
      ? cards
      : cards.filter((card) => card.deck === filters.deckId || card.deck_id === filters.deckId || card.deckId === filters.deckId);
    const offset = Number(filters.$offset ?? 0);
    const limit = Number(filters.$limit ?? scopedCards.length);
    const page = scopedCards.slice(offset, offset + limit);
    const selection = (body.query._root[0].account[0] as Record<string, unknown>)[relationKey] as unknown[];
    const projected = page.map((card) => {
      if (!selection.includes("count:childCards")) return card;
      const result = { ...card };
      if (!options.keepChildRelationOnSummary) delete result.childCards;
      if (Object.prototype.hasOwnProperty.call(card, "count:childCards")) {
        if (card["count:childCards"] === undefined) delete result["count:childCards"];
      } else if (Array.isArray(card.childCards)) {
        result["count:childCards"] = card.childCards.length;
      }
      return result;
    });
    const responseText = JSON.stringify(makeCardsPayload(relationKey, projected));
    lastMockResponseSerializedBytes += Buffer.byteLength(responseText);
    return new Response(responseText, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
};

const cards: MockCard[] = [
  {
    cardId: "card-eligible",
    accountSeq: 101,
    title: "Eligible card",
    status: "not_started",
    derivedStatus: "assigned",
    visibility: "default",
    isDoc: false,
    effort: null,
    priority: "b",
    lastUpdatedAt: "2026-05-11T00:00:00.000Z",
    deck: "deck-dev",
    milestone: "milestone-alpha",
    childCards: [],
  },
  {
    cardId: "card-effort-set",
    accountSeq: 102,
    title: "Already estimated",
    status: "not_started",
    derivedStatus: "assigned",
    visibility: "default",
    isDoc: false,
    effort: 3,
    deck: "deck-dev",
    childCards: [],
  },
  {
    cardId: "card-hero",
    accountSeq: 103,
    title: "Hero card",
    status: "not_started",
    derivedStatus: "assigned",
    visibility: "default",
    isDoc: false,
    effort: null,
    deck: "deck-dev",
    childCards: ["child-a"],
  },
  {
    cardId: "card-doc",
    accountSeq: 104,
    title: "Documentation card",
    status: "not_started",
    derivedStatus: "documentation",
    visibility: "default",
    isDoc: true,
    effort: null,
    deck: "deck-dev",
    childCards: [],
  },
  {
    cardId: "card-done",
    accountSeq: 105,
    title: "Done card",
    status: "done",
    derivedStatus: "done",
    visibility: "default",
    isDoc: false,
    effort: null,
    deck: "deck-dev",
    childCards: [],
  },
  {
    cardId: "card-other-deck",
    accountSeq: 106,
    title: "Other deck card",
    status: "not_started",
    derivedStatus: "assigned",
    visibility: "default",
    isDoc: false,
    effort: null,
    deck: "deck-other",
    childCards: [],
  },
];

{
  const requests = installFetchMock(cards);
  const text = String(await core.card_search.execute({ deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.action, "card-search");
  assert.equal(payload.data.matches, 5);
  assert.equal(getCardsFilters(requests[1]).deckId, "deck-dev", "resolved deck is pushed into the paged server filter");
  assert.ok(JSON.stringify(requests[1].query).includes('"deck"'), "deck relation remains selected for defensive verification");
  assert.ok(JSON.stringify(requests[1].query).includes('"count:childCards"'), "paged summaries request only the child-count aggregate");
  assert.ok(!JSON.stringify(requests[1].query).includes('"childCards"'), "paged summaries do not request child references");

  const first = payload.data.cards[0];
  assert.equal(first.shortCode, "$14j");
  assert.equal(first.effort, null);
  assert.equal(first.effortKnown, true);
  assert.equal(first.cardType, "regular");
  assert.equal(first.cardTypeKnown, true);
  assert.equal(first.childCount, 0);
  assert.equal(first.childCountKnown, true);
  assert.equal(first.deckId, "deck-dev");
  assert.equal(first.milestoneId, "milestone-alpha");
  assert.equal(first.lastUpdatedAt, "2026-05-11T00:00:00.000Z");
}

{
  const manyChildren = {
    ...cards[2], cardId: "synthetic-many-children", accountSeq: 200,
    childCards: Array.from({ length: 250 }, (_, index) => `synthetic-child-${index}`),
  };
  const requests = installFetchMock([manyChildren, cards[0]]);
  const result = parseStructuredJson(String(await core.card_search.execute({ outputMode: "counts", format: "json" })));
  assert.equal(result.ok, true);
  assert.equal(requests.length, 1, "aggregate and former child-relation summary each require one page request, no per-card preflight");
  assert.equal(result.data.matches, 2);
  assert.equal(result.data.facets.status.not_started, 2, "counts output retains status facets rather than reducing to one aggregate total");
  assert.equal(result.data.sampleCards[0].childCount, 250);
  assert.equal(result.data.sampleCards[0].childCountKnown, true);
  assert.equal(result.data.sampleCards[1].childCount, 0);
  assert.equal(result.data.sampleCards[1].childCountKnown, true);
  assert.ok(JSON.stringify(requests[0].query).includes('"count:childCards"'));
  assert.ok(!JSON.stringify(requests[0].query).includes('"childCards"'));
  const oldNormalizedBytes = Buffer.byteLength(JSON.stringify(makeCardsPayload(getCardsRelationKey(requests[0].query)!, [manyChildren, cards[0]])));
  assert.ok(lastMockResponseSerializedBytes < oldNormalizedBytes, `synthetic normalized JSON: aggregate ${lastMockResponseSerializedBytes} bytes < old child refs ${oldNormalizedBytes} bytes; same one request`);
  console.log(`Synthetic high-child fixture: one request each; normalized JSON aggregate ${lastMockResponseSerializedBytes} bytes vs previous child refs ${oldNormalizedBytes} bytes (not wire/compressed bytes).`);
}

{
  const fixture = [
    { ...cards[0], cardId: "synthetic-unknown-count", accountSeq: 210, childCards: undefined, "count:childCards": undefined },
    { ...cards[0], cardId: "synthetic-invalid-count", accountSeq: 211, childCards: undefined, "count:childCards": "0" },
    { ...cards[0], cardId: "synthetic-negative-count", accountSeq: 212, childCards: undefined, "count:childCards": -1 },
    { ...cards[0], cardId: "synthetic-observed-zero", accountSeq: 213, childCards: [], "count:childCards": 0 },
    { ...cards[0], cardId: "synthetic-relation-fallback", accountSeq: 214, childCards: ["synthetic-child"], "count:childCards": "invalid" },
  ];
  installFetchMock(fixture);
  const result = parseStructuredJson(String(await core.card_search.execute({ format: "json" })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.cards.map((card: any) => [card.childCountKnown, card.childCount]), [
    [false, null], [false, null], [false, null], [true, 0], [false, null],
  ], "missing/invalid/forbidden-like aggregate values must not become known zero");
  installFetchMock(fixture, { keepChildRelationOnSummary: true });
  const withRelation = parseStructuredJson(String(await core.card_search.execute({ format: "json" })));
  assert.equal(withRelation.data.cards[3].childCountKnown, true, "present empty relation is still a known zero");
  assert.equal(withRelation.data.cards[4].childCount, 1, "a valid present child relation may backfill an invalid aggregate without another request");
}

{
  const requests: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    const root = body.query?._root?.[0];
    if (root?.loggedInUser) {
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: "synthetic-user" }, user: { "synthetic-user": { id: "synthetic-user" } } } }), { status: 200 });
    }
    const relationKey = Object.keys(root?.account?.[0] ?? {})[0];
    assert.match(relationKey, /^(handCards|queueEntries)\(/);
    const relationFields = root.account[0][relationKey];
    assert.ok(JSON.stringify(relationFields).includes('"count:childCards"'), "Hand/bookmark summaries request child aggregates");
    assert.ok(!JSON.stringify(relationFields).includes('"childCards"'), "Hand/bookmark summaries omit child identities");
    const isHand = relationKey.startsWith("queueEntries(");
    const entity = isHand ? "queueEntry" : "handCard";
    return new Response(JSON.stringify({ data: {
      _root: { account: { [relationKey]: ["row-1"] } },
      [entity]: { "row-1": { userId: "synthetic-user", sortIndex: 0, card: "synthetic-card" } },
      card: { "synthetic-card": { ...cards[0], cardId: "synthetic-card", "count:childCards": 7, childCards: undefined } },
    } }), { status: 200 });
  }) as typeof fetch;
  for (const location of ["hand", "bookmarks"] as const) {
    const result = parseStructuredJson(String(await core.card_search.execute({ location, format: "json" })));
    assert.equal(result.ok, true, `${location} summary should hydrate numeric count`);
    assert.equal(result.data.cards[0].childCount, 7);
    assert.equal(result.data.cards[0].childCountKnown, true);
  }
  assert.equal(requests.length, 4, "each personal summary needs only its existing identity + relation read");
}

{
  const requests = installFetchMock(cards);
  const text = String(await core.card_search.execute({ milestone: "Alpha", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.action, "card-search");
  assert.equal(getCardsFilters(requests[1]).milestoneId, undefined, "milestone pushdown stays unverified and local");
  assert.ok(JSON.stringify(requests[1].query).includes('"milestone"'), "milestone-scoped search should request milestone relation data for client-side filtering");
  assert.equal(getCardsFilters(requests[1]).deckId, undefined, "milestone-only search remains an account-visible scan");
}

{
  const requests = installFetchMock(cards);
  const text = String(await core.card_search.execute({ title: "*eligible*", deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.data.matches, 1);
  assert.equal(payload.data.cards[0].title, "Eligible card");
  assert.deepEqual(payload.data.cards[0].matchedFields, ["title"]);
  assert.ok(!JSON.stringify(requests[1].query).includes("*eligible*"), "wildcards should be interpreted client-side, not sent literally to Codecks title contains");
}

{
  installFetchMock([
    {
      cardId: "card-accented",
      accountSeq: 120,
      title: "SS Île-de-France backgrounds",
      status: "not_started",
      visibility: "default",
      deck: "deck-dev",
      childCards: [],
    },
  ]);
  const text = String(await core.card_search.execute({ title: "ile de france", deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.data.matches, 1);
  assert.equal(payload.data.cards[0].title, "SS Île-de-France backgrounds");
}

{
  installFetchMock([
    {
      cardId: "card-body-match",
      accountSeq: 121,
      title: "Open body match",
      content: "The body still mentions IDF.",
      status: "started",
      derivedStatus: "started",
      visibility: "default",
      deck: "deck-dev",
      childCards: [],
    },
    {
      cardId: "card-done-body-match",
      accountSeq: 122,
      title: "Done body match",
      content: "The body still mentions IDF.",
      status: "done",
      derivedStatus: "done",
      visibility: "default",
      deck: "deck-dev",
      childCards: [],
    },
  ]);
  const text = String(await core.card_search.execute({ text: "idf", searchIn: "title_or_content", includeDone: false, deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.data.matches, 1);
  assert.equal(payload.data.cards[0].title, "Open body match");
  assert.deepEqual(payload.data.cards[0].matchedFields, ["content"]);
}

{
  installFetchMock(cards);
  const text = String(await core.card_list_missing_effort.execute({
    deck: "Dev",
    skipCodes: ["$14j"],
    format: "json",
  }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.action, "card-list-missing-effort");
  assert.equal(payload.data.eligibleCount, 0);
  assert.equal(payload.data.excludedCount, 5);
  const excludedReasons = new Map(payload.data.excludedCards.map((card: any) => [card.shortCode, card.exclusionReasons]));
  assert.deepEqual(excludedReasons.get("$14j"), ["skipped_by_request"]);
  assert.deepEqual(excludedReasons.get("$14k"), ["effort_already_set"]);
  assert.deepEqual(excludedReasons.get("$14o"), ["hero_card"]);
  assert.deepEqual(excludedReasons.get("$14q"), ["documentation_card"]);
  assert.deepEqual(excludedReasons.get("$14r"), ["done_card"]);
  assert.match(payload.nextSuggestedAction, /explicit approval/);
  assert.match(payload.nextSuggestedAction, /codecks_card_update_effort/);
}

{
  installFetchMock(cards);
  const text = String(await core.card_list_missing_effort.execute({
    deck: "Dev",
    includeDone: true,
    includeExcluded: false,
    format: "json",
  }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.data.eligibleCount, 2);
  assert.equal(payload.data.excludedCards, undefined);
  assert.deepEqual(payload.data.eligibleCards.map((card: any) => card.shortCode), ["$14j", "$14r"]);
}

{
  installFetchMock([
    {
      cardId: "card-partial",
      accountSeq: 106,
      title: "Partial card",
      status: "not_started",
      visibility: "default",
      deck: "deck-dev",
    },
  ]);
  const text = String(await core.card_list_missing_effort.execute({ deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);
  const reasons = payload.data.excludedCards[0].exclusionReasons;

  assert.equal(payload.data.eligibleCount, 0);
  assert.ok(reasons.includes("effort_unknown"));
  assert.ok(reasons.includes("child_count_unknown"));
}

{
  const requests = installFetchMock(cards);
  const intersectionText = String(await core.card_search.execute({ location: "milestone", deck: "Dev", milestone: "Alpha", format: "json" }));
  const intersection = parseStructuredJson(intersectionText);
  assert.equal(intersection.ok, true);
  assert.equal(intersection.data.matches, 1);
  assert.equal(intersection.data.cards[0].title, "Eligible card");
  assert.equal(getCardsFilters(requests[2]).deckId, "deck-dev", "only the verified deck predicate is pushed down");
  assert.equal(getCardsFilters(requests[2]).milestoneId, undefined, "milestone is still verified after the deck-scoped read");
  assert.equal(intersection.data.scannedCards, 5, "intersection coverage counts deck rows before local milestone filtering");

  const ignoredText = String(await core.card_list_missing_effort.execute({ location: "hand", deck: "Dev", format: "json" }));
  const ignored = parseStructuredJson(ignoredText);
  assert.equal(ignored.ok, false);
  assert.equal(ignored.error.category, "validation_error");
}

{
  installFetchMock([], { rejectCardQueries: true });
  const text = String(await core.card_list_missing_effort.execute({ deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, false);
  assert.equal(payload.action, "card-list-missing-effort");
  assert.equal(payload.error.category, "api_error");
  assert.match(payload.error.message, /mock Codecks outage/);
}

{
  const requests = installFetchMock(cards, { denyCardQueries: true });
  const denied = parseStructuredJson(String(await core.card_search.execute({ deck: "Dev", format: "json" })));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.category, "missing_scope");
  assert.equal(denied.error.apiCode, "missing_scope");
  assert.equal(denied.error.apiPath, "_root.account.cards");
  assert.equal(requests.length, 2, "a rejected scoped query never falls back to an account-wide query");
  assert.equal(getCardsFilters(requests[1]).deckId, "deck-dev");
  assert.ok(JSON.stringify(requests[1].query).includes('"count:childCards"'), "aggregate selection errors are not retried without the aggregate");
}

{
  const requests = installFetchMock(cards, { denyAggregate: true });
  const rejected = parseStructuredJson(String(await core.card_search.execute({ deck: "Dev", format: "json" })));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.apiCode, "invalid_aggregate");
  assert.equal(rejected.error.apiPath, "_root.account.cards");
  assert.equal(rejected.error.httpStatus, 400);
  assert.equal(requests.length, 2, "invalid aggregate never retries without aggregate or without deck filter");
  assert.equal(getCardsFilters(requests[1]).deckId, "deck-dev");
}

{
  const requests = installFetchMock(cards, { denyPageAtOffset: 2 });
  const denied = parseStructuredJson(String(await core.card_search.execute({ deck: "Dev", pageSize: 2, scanLimit: 5, format: "json" })));
  assert.equal(denied.ok, false);
  assert.equal(denied.error.category, "missing_scope");
  assert.equal(denied.error.scannedCards, 2, "earlier pages remain measured, but are not presented as complete matches");
  assert.equal(denied.error.requestsAttempted, 2);
  assert.equal(denied.error.complete, false);
  assert.equal(denied.error.cards, undefined, "private earlier-page rows are not copied into error details");
  assert.equal(requests.length, 3);
  assert(requests.slice(1).every((request) => getCardsFilters(request).deckId === "deck-dev"), "no failed page broadens to account scan");
  const preview = parseStructuredJson(String(await core.card_list_missing_effort.execute({ deck: "Dev", pageSize: 2, scanLimit: 5, format: "json" })));
  assert.equal(preview.ok, false);
  assert.equal(preview.error.category, "missing_scope");
  assert.equal(preview.error.scannedCards, 2);
}

{
  const savedFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requests++;
    const queryText = JSON.stringify(JSON.parse(String(init?.body ?? "{}")).query);
    const invalidLimit = queryText.includes('$limit');
    return new Response(JSON.stringify({
      error: invalidLimit ? "invalid_limit" : "invalid_order",
      path: "_root.account.cards",
      message: invalidLimit ? "$limit requires $order" : "$order must name a sortable field",
    }), { status: 400 });
  }) as typeof fetch;
  try {
    for (const [filter, code] of [[{ $limit: 2 }, "invalid_limit"], [{ $order: { field: "createdAt" } }, "invalid_order"]] as const) {
      const key = `cards(${JSON.stringify(filter)})`;
      const result = parseStructuredJson(String(await core.query.execute({ query: { _root: [{ account: [{ [key]: ["cardId"] }] }] } })));
      assert.equal(result.ok, false);
      assert.equal(result.error.category, "api_error");
      assert.equal(result.error.apiCode, code);
      assert.equal(result.error.apiPath, "_root.account.cards");
      assert.match(result.error.validationMessage, /\$limit requires \$order|\$order must name/);
    }
    assert.equal(requests, 2, "invalid query diagnostics are preserved without broad retries");
  } finally { globalThis.fetch = savedFetch; }
}

{
  installFetchMock([]);
  const text = String(await core.card_search.execute({ deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.action, "card-search");
  assert.equal(payload.data.matches, 0);
  assert.deepEqual(payload.data.cards, []);
}

{
  const manyCards = Array.from({ length: 30 }, (_, index) => ({
    cardId: `bulk-${index}`,
    accountSeq: 200 + index,
    title: `Bulk card ${index}`,
    status: index % 2 === 0 ? "not_started" : "done",
    derivedStatus: index % 2 === 0 ? "assigned" : "done",
    visibility: "default",
    isDoc: false,
    effort: index % 3,
    priority: index % 2 === 0 ? "b" : "c",
    deck: "deck-dev",
    milestone: "milestone-alpha",
    childCards: [],
  }));
  installFetchMock(manyCards);
  const compactText = String(await core.card_search.execute({ deck: "Dev", limit: 100, format: "json" }));
  const compact = parseStructuredJson(compactText);
  assert.equal(compact.data.matches, 30);
  assert.equal(compact.data.returnedCards, 25);
  assert.equal(compact.data.truncated, true);
  assert.equal(compact.data.cards.length, 25);
  assert.equal(compact.data.facets.status.done, 15);
  assert.match(compact.warnings[0], /truncated/);

  const countsText = String(await core.card_search.execute({ deck: "Dev", outputMode: "counts", format: "json" }));
  const counts = parseStructuredJson(countsText);
  assert.equal(counts.data.matches, 30);
  assert.equal(counts.data.returnedCards, 0);
  assert.equal(counts.data.cards, undefined);
  assert.equal(counts.data.sampleCards.length, 10);
  assert.equal(counts.data.facets.derivedStatus.done, 15);
}

{
  const pagedCards = [
    ...Array.from({ length: 100 }, (_, index) => ({ ...cards[5], cardId: `other-${index}`, accountSeq: 300 + index })),
    { ...cards[0], cardId: "target-after-old-account-window", accountSeq: 500, title: "Late scoped match" },
  ];
  const requests = installFetchMock(pagedCards);
  const text = String(await core.card_search.execute({ deck: "Dev", pageSize: 2, scanLimit: 2, format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.data.matches, 1);
  assert.equal(payload.data.cards[0].title, "Late scoped match");
  assert.equal(payload.data.scannedCards, 1, "server-scoped budget counts only the returned deck row, not 100 unrelated cards");
  assert.equal(payload.data.complete, true);
  assert.equal(payload.data.scanLimitReached, false);
  const cardRequests = requests.map((request) => getCardsRelationKey(request.query)).filter(Boolean) as string[];
  assert.equal(cardRequests.length, 1);
  assert.equal(getCardsFilters(requests[1]).deckId, "deck-dev");
}

{
  const requests = installFetchMock([
    { ...cards[5], cardId: "wrong-deck" },
    { ...cards[0], cardId: "right-deck", deck: undefined, deck_id: "deck-dev" },
  ], { ignoreDeckFilter: true });
  const result = parseStructuredJson(String(await core.card_search.execute({ deck: "Dev", pageSize: 3, scanLimit: 3, format: "json" })));
  assert.equal(result.data.matches, 1, "unexpected server rows are still rejected by client scope verification");
  assert.equal(result.data.cards[0].title, "Eligible card");
  assert.equal(result.data.scannedCards, 2);
  assert.equal(result.data.complete, true);
  assert.equal(requests.length, 2);
}

{
  installFetchMock([
    { ...cards[5], cardId: "other-first" },
    { ...cards[0], cardId: "archived-deck-card", visibility: "archived" },
    { ...cards[0], cardId: "visible-deck-card" },
  ]);
  const result = parseStructuredJson(String(await core.card_search.execute({ deck: "Dev", pageSize: 2, scanLimit: 2, format: "json" })));
  assert.equal(result.data.scannedCards, 2, "the scoped budget counts server rows even when archive filtering drops one");
  assert.equal(result.data.matches, 1);
  assert.equal(result.data.complete, false);
  assert.equal(result.data.scanLimitReached, true);
  assert.match(result.warnings[0], /incomplete/i);
}

{
  const exactBoundCards = Array.from({ length: 4 }, (_, index) => ({
    ...cards[0],
    cardId: `bound-${index}`,
    accountSeq: 320 + index,
  }));
  installFetchMock(exactBoundCards);
  const text = String(await core.card_search.execute({ pageSize: 2, scanLimit: 4, limit: 4, format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.data.scannedCards, 4);
  assert.equal(payload.data.complete, false);
  assert.equal(payload.data.scanLimitReached, true);
  assert.match(payload.warnings[0], /may be incomplete/i);
}

{
  const duplicateCards = [
    { ...cards[0], cardId: "duplicate", accountSeq: 340 },
    { ...cards[0], cardId: "duplicate", accountSeq: 340 },
    { ...cards[0], cardId: "unique", accountSeq: 341 },
  ];
  installFetchMock(duplicateCards);
  const text = String(await core.card_search.execute({ pageSize: 2, scanLimit: 10, format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.data.scannedCards, 3);
  assert.equal(payload.data.matches, 2);
  assert.equal(payload.data.complete, true);
}

{
  const exactBoundCards = Array.from({ length: 2 }, (_, index) => ({
    ...cards[0],
    cardId: `preview-bound-${index}`,
    accountSeq: 350 + index,
  }));
  installFetchMock(exactBoundCards);
  const text = String(await core.card_list_missing_effort.execute({
    pageSize: 2,
    scanLimit: 2,
    limit: 1,
    format: "json",
  }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.data.complete, false);
  assert.equal(payload.data.scanLimitReached, true);
  assert.equal(payload.data.scannedCards, 2);
  assert.equal(payload.data.eligibleCount, 2);
  assert.equal(payload.data.returnedEligibleCards, 1);
  assert.match(payload.warnings[0], /not authoritative/i);
  assert.match(payload.nextSuggestedAction, /Increase scanLimit/i);
}

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    errors: [{
      message: "Authorization: Bearer bearer-secret\nCookie=session-secret\ntoken=token-secret credential=credential-secret",
      authorization: "header-secret",
      password: "password-secret",
    }],
  }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
  try {
    for (const result of [
      await core.card_search.execute({ format: "json" }),
      await core.card_list_missing_effort.execute({ format: "json" }),
      await core.query.execute({ query: { _root: ["account"], password: "query-secret" } }),
      await core.runWithAbortSignal(undefined, () => core.dispatch.execute({ path: "cards/create", payload: { deckId: "synthetic-deck", assigneeId: null, content: "synthetic" }, format: "json" }), process.cwd()),
    ]) {
      const text = String(result);
      const payload = parseStructuredJson(text);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.category, "api_error");
      assert.doesNotMatch(text, /bearer-secret|session-secret|token-secret|credential-secret|header-secret|password-secret|query-secret/);
      if (payload.error.dispatchAttempt === "http_response") {
        assert.equal(payload.error.mutationCertainty, "indeterminate");
        assert.equal(payload.error.httpStatus, 200);
      } else {
        assert.match(text, /\[REDACTED\]/);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("Codecks card search preview tests passed");
