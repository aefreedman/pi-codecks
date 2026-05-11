import assert from "node:assert/strict";

process.env.CODECKS_ACCOUNT = "example";
process.env.CODECKS_TOKEN = "test-token";

const core = await import("../src/codecks-core.ts");

type MockCard = Record<string, unknown>;

const deck = { id: "deck-dev", title: "Dev", accountSeq: 2 };
const milestone = { id: "milestone-alpha", name: "Alpha", title: "Alpha", accountSeq: 84 };

const parseStructuredJson = (text: string): Record<string, any> => {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(match, `expected structured json block in: ${text}`);
  return JSON.parse(match[1]);
};

const makeCardsPayload = (cards: MockCard[]) => ({
  data: {
    _root: {
      account: {
        'cards({"deckId":"deck-dev","$order":"-lastUpdatedAt","$limit":300})': cards.map((card) => card.cardId),
        'cards({"deckId":"deck-dev","$order":"-lastUpdatedAt","$limit":20})': cards.map((card) => card.cardId),
      },
    },
    card: Object.fromEntries(cards.map((card) => [String(card.cardId), card])),
    deck: { "deck-dev": deck },
    milestone: { "milestone-alpha": milestone },
  },
});

const installFetchMock = (cards: MockCard[]) => {
  const requests: any[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    requests.push(body);
    const queryText = JSON.stringify(body.query ?? {});

    if (queryText.includes("decks")) {
      return new Response(JSON.stringify({
        data: {
          _root: { account: { decks: ["deck-dev"] } },
          deck: { "deck-dev": deck },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
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
    visibility: "default",
    isDoc: true,
    effort: null,
    deck: "deck-dev",
    childCards: [],
  },
];

{
  const requests = installFetchMock(cards);
  const text = String(await core.card_search.execute({ deck: "Dev", format: "json" }));
  const payload = parseStructuredJson(text);

  assert.equal(payload.ok, true);
  assert.equal(payload.action, "card-search");
  assert.equal(payload.data.matches, 4);
  assert.ok(JSON.stringify(requests[1].query).includes('deckId'), "deck argument should infer deck-scoped search");
  assert.ok(JSON.stringify(requests[1].query).includes('deck-dev'), "deck-scoped search should use resolved deck id");

  const first = payload.data.cards[0];
  assert.equal(first.shortCode, "$14j");
  assert.equal(first.effort, null);
  assert.equal(first.cardType, "regular");
  assert.equal(first.childCount, 0);
  assert.equal(first.deckId, "deck-dev");
  assert.equal(first.milestoneId, "milestone-alpha");
  assert.equal(first.lastUpdatedAt, "2026-05-11T00:00:00.000Z");
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
  assert.equal(payload.data.excludedCount, 4);
  const excludedReasons = new Map(payload.data.excludedCards.map((card: any) => [card.shortCode, card.exclusionReasons]));
  assert.deepEqual(excludedReasons.get("$14j"), ["skipped_by_request"]);
  assert.deepEqual(excludedReasons.get("$14k"), ["effort_already_set"]);
  assert.deepEqual(excludedReasons.get("$14o"), ["hero_card"]);
  assert.deepEqual(excludedReasons.get("$14q"), ["documentation_card"]);
  assert.match(payload.nextSuggestedAction, /codecks_card_update_effort/);
}

console.log("Codecks card search preview tests passed");
