import assert from "node:assert/strict";

process.env.CODECKS_ACCOUNT = "example";
process.env.CODECKS_TOKEN = "test-token";

const core = await import("../src/codecks-core.ts");

type MockCard = Record<string, unknown>;

type FetchMockOptions = {
  rejectCardQueries?: boolean;
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

const installFetchMock = (cards: MockCard[], options: FetchMockOptions = {}) => {
  const requests: any[] = [];
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

    const relationKey = getCardsRelationKey(body.query);
    assert.ok(relationKey, `expected cards relation in ${queryText}`);
    const filters = JSON.parse(relationKey.slice("cards(".length, -1));
    const offset = Number(filters.$offset ?? 0);
    const limit = Number(filters.$limit ?? cards.length);
    const page = cards.slice(offset, offset + limit);
    return new Response(JSON.stringify(makeCardsPayload(relationKey, page)), {
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
  assert.ok(!JSON.stringify(requests[1].query).includes("deckId"), "deck-scoped search should avoid the live-API-unsafe deckId cards filter");
  assert.ok(JSON.stringify(requests[1].query).includes('"deck"'), "deck-scoped search should request deck relation data for client-side filtering");

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
  const requests = installFetchMock(cards);
  const text = String(await core.card_search.execute({ milestone: "Alpha", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.action, "card-search");
  assert.ok(!JSON.stringify(requests[1].query).includes("milestoneId"), "milestone-scoped search should avoid the live-API-unsafe milestoneId cards filter");
  assert.ok(JSON.stringify(requests[1].query).includes('"milestone"'), "milestone-scoped search should request milestone relation data for client-side filtering");
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
  installFetchMock(cards);
  const intersectionText = String(await core.card_search.execute({ location: "milestone", deck: "Dev", milestone: "Alpha", format: "json" }));
  const intersection = parseStructuredJson(intersectionText);
  assert.equal(intersection.ok, true);
  assert.equal(intersection.data.matches, 1);
  assert.equal(intersection.data.cards[0].title, "Eligible card");

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
    { ...cards[5], cardId: "other-1", accountSeq: 301 },
    { ...cards[5], cardId: "other-2", accountSeq: 302 },
    { ...cards[0], cardId: "target-after-page-one", accountSeq: 303, title: "Late scoped match" },
  ];
  const requests = installFetchMock(pagedCards);
  const text = String(await core.card_search.execute({ deck: "Dev", pageSize: 2, scanLimit: 10, format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.data.matches, 1);
  assert.equal(payload.data.cards[0].title, "Late scoped match");
  assert.equal(payload.data.scannedCards, 3);
  assert.equal(payload.data.complete, true);
  assert.equal(payload.data.scanLimitReached, false);
  const cardRequests = requests.map((request) => getCardsRelationKey(request.query)).filter(Boolean) as string[];
  assert.equal(cardRequests.length, 2);
  assert.match(cardRequests[1], /"\$offset":2/);
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
      await core.runWithAbortSignal(undefined, () => core.dispatch.execute({ path: "cards/create", payload: {}, format: "json" }), {
        sessionManager: {}, mode: "tui", hasUI: true, confirm: async () => true,
      }),
    ]) {
      const text = String(result);
      const payload = parseStructuredJson(text);
      assert.equal(payload.ok, false);
      assert.equal(payload.error.category, "api_error");
      assert.doesNotMatch(text, /bearer-secret|session-secret|token-secret|credential-secret|header-secret|password-secret|query-secret/);
      assert.match(text, /\[REDACTED\]/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("Codecks card search preview tests passed");
