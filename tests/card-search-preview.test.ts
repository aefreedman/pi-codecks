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

const makeCardsPayload = (cards: MockCard[]) => ({
  data: {
    _root: {
      account: {
        'cards({"$order":"-lastUpdatedAt","$limit":3000})': cards.map((card) => card.cardId),
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

    return new Response(JSON.stringify(makeCardsPayload(cards)), {
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
  const conflictText = String(await core.card_search.execute({ deck: "Dev", milestone: "Alpha", format: "json" }));
  const conflict = parseStructuredJson(conflictText);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.category, "validation_error");

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

  assert.equal(payload.ok, false);
  assert.equal(payload.action, "card-search");
  assert.equal(payload.error.category, "not_found");
}

console.log("Codecks card search preview tests passed");
