import assert from "node:assert/strict";

type AnyRecord = Record<string, unknown>;
type ToolModule = typeof import("../src/codecks-core.ts");
type QueryHandler = (query: AnyRecord) => Response | Promise<Response>;

// Mock-only fixture identifiers. These are not expected to exist in any live Codecks account.
const ACCOUNT_ID = "mock-account-card-get";
const CARD_ID = "mock-card-main-id";
const CHILD_ID = "mock-card-child-id";
const CARD_CODE = "12g";
const CARD_REF = `$${CARD_CODE}`;
const CARD_SEQ = 42;

const isObject = (value: unknown): value is AnyRecord => typeof value === "object" && value !== null && !Array.isArray(value);

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const parseToolResult = (result: string): AnyRecord => {
  const match = result.match(/```json\s*([\s\S]*?)\s*```/i);
  assert.ok(match, `expected JSON code fence in result:\n${result}`);
  return JSON.parse(match[1]) as AnyRecord;
};

const getData = (result: string): AnyRecord => {
  const payload = parseToolResult(result);
  assert.equal(payload.ok, true, `expected ok=true result:\n${result}`);
  assert.ok(isObject(payload.data), "expected payload.data object");
  return payload.data;
};

const getError = (result: string): AnyRecord => {
  const payload = parseToolResult(result);
  assert.equal(payload.ok, false, `expected ok=false result:\n${result}`);
  assert.ok(isObject(payload.error), "expected payload.error object");
  return payload.error;
};

const getAccountRelation = (query: AnyRecord, relation: string): { key: string; fields: unknown } | undefined => {
  const root = Array.isArray(query._root) ? query._root[0] : undefined;
  const accountEntries = isObject(root) && Array.isArray(root.account) ? root.account : [];
  for (const entry of accountEntries) {
    if (!isObject(entry)) continue;
    const key = Object.keys(entry).find((candidate) => candidate === relation || candidate.startsWith(`${relation}(`));
    if (key) {
      return { key, fields: entry[key] };
    }
  }
  return undefined;
};

const getDirectCardKey = (query: AnyRecord): string | undefined =>
  Object.keys(query).find((key) => key.startsWith("card("));

const withMockedFetch = async (handler: QueryHandler, run: () => Promise<void>): Promise<void> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const bodyText = String(init?.body ?? "{}");
    const payload = JSON.parse(bodyText) as AnyRecord;
    const query = payload.query;
    assert.ok(isObject(query), `expected query object, got: ${bodyText}`);
    return handler(query);
  }) as typeof fetch;

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const loadTools = async (): Promise<ToolModule> => {
  process.env.CODECKS_ACCOUNT = "test-account";
  process.env.CODECKS_TOKEN = "test-token";
  return import("../src/codecks-core.ts");
};

const buildCard = (overrides: AnyRecord = {}): AnyRecord => ({
  cardId: CARD_ID,
  accountSeq: CARD_SEQ,
  title: "Structured retrieval card",
  content: "Plain first line\n\nBody text",
  status: "started",
  derivedStatus: "started",
  visibility: "visible",
  isDoc: false,
  effort: 3,
  priority: "b",
  dueDate: null,
  lastUpdatedAt: "2026-04-29T12:00:00.000Z",
  masterTags: [{ tag: "agent-tool" }],
  deck: "deck-1",
  milestone: "milestone-1",
  assignee: "user-1",
  creator: "user-2",
  childCards: [CHILD_ID],
  ...overrides,
});

const buildDetailPayload = (card: AnyRecord = buildCard()): AnyRecord => ({
  _root: { account: ACCOUNT_ID },
  account: {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      [`cards({\"accountSeq\":[${String(card.accountSeq)}]})`]: [String(card.cardId)],
    },
  },
  card: {
    [String(card.cardId)]: card,
    [CHILD_ID]: {
      cardId: CHILD_ID,
      accountSeq: CARD_SEQ + 1,
      title: "Child card",
      status: "not_started",
      derivedStatus: "not_started",
      isDoc: false,
    },
  },
  deck: {
    "deck-1": { id: "deck-1", accountSeq: 12, title: "Tools" },
  },
  milestone: {
    "milestone-1": { id: "milestone-1", accountSeq: 34, name: "Agent Milestone", title: "Agent Milestone" },
  },
  user: {
    "user-1": { id: "user-1", name: "Agent", fullName: "Agent User" },
    "user-2": { id: "user-2", name: "Creator", fullName: "Creator User" },
  },
});

const buildSearchPayload = (cards: AnyRecord[], relationKey: string): AnyRecord => ({
  _root: { account: ACCOUNT_ID },
  account: {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      [relationKey]: cards.map((card) => String(card.cardId)),
    },
  },
  card: Object.fromEntries(cards.map((card) => [String(card.cardId), card])),
});

const testDirectShortCodeReturnsStructuredCard = async (tools: ToolModule): Promise<void> => {
  let callCount = 0;
  await withMockedFetch((query) => {
    callCount += 1;
    const cardsRelation = getAccountRelation(query, "cards");
    assert.ok(cardsRelation, `expected direct account card query: ${JSON.stringify(query)}`);
    assert.match(cardsRelation.key, /accountSeq/);
    return jsonResponse({ data: buildDetailPayload() });
  }, async () => {
    const result = await tools.card_get.execute({ cardId: CARD_REF });
    const data = getData(String(result));
    assert.ok(isObject(data.card), "expected data.card object");
    const card = data.card as AnyRecord;
    assert.equal(card.cardId, CARD_ID);
    assert.equal(card.shortCode, CARD_REF);
    assert.equal(card.content, "Plain first line\n\nBody text");
    assert.equal(card.contentTrust, "external");
    assert.equal(card.cardType, "regular");
    assert.deepEqual(card.tags, ["agent-tool"]);
    assert.ok(isObject(card.deck), "expected deck summary");
    assert.equal((card.deck as AnyRecord).title, "Tools");
    assert.ok(isObject(card.creator), "expected creator summary");
    assert.equal((card.creator as AnyRecord).name, "Creator");
    assert.ok(Array.isArray(card.childCards), "expected childCards array");
    assert.equal((card.childCards as unknown[]).length, 1);
    assert.equal(callCount, 1, "direct retrieval should not perform enrichment or search calls");
  });
};

const testTitleLookupAmbiguousReturnsCandidates = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch((query) => {
    const cardsRelation = getAccountRelation(query, "cards");
    assert.ok(cardsRelation, `expected title search query: ${JSON.stringify(query)}`);
    return jsonResponse({
      data: buildSearchPayload([
        buildCard({ cardId: "card-a", accountSeq: 101, title: "Duplicate" }),
        buildCard({ cardId: "card-b", accountSeq: 102, title: "Duplicate" }),
      ], cardsRelation.key),
    });
  }, async () => {
    const result = await tools.card_get.execute({ title: "Duplicate" });
    const error = getError(String(result));
    assert.equal(error.category, "ambiguous_match");
    assert.equal(error.matches, 2);
    assert.ok(Array.isArray(error.candidates), "expected retryable candidates");
  });
};

const testTitleLookupNoMatchReturnsStructuredError = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch((query) => {
    const cardsRelation = getAccountRelation(query, "cards");
    assert.ok(cardsRelation, `expected title search query: ${JSON.stringify(query)}`);
    return jsonResponse({ data: buildSearchPayload([], cardsRelation.key) });
  }, async () => {
    const result = await tools.card_get.execute({ title: "Missing" });
    const error = getError(String(result));
    assert.equal(error.category, "not_found");
    assert.equal(error.title, "Missing");
  });
};

const testTitleLookupSingleFetchesDetail = async (tools: ToolModule): Promise<void> => {
  let callCount = 0;
  await withMockedFetch((query) => {
    callCount += 1;
    const cardsRelation = getAccountRelation(query, "cards");
    if (cardsRelation) {
      if (cardsRelation.key.includes("title")) {
        return jsonResponse({ data: buildSearchPayload([buildCard()], cardsRelation.key) });
      }
      return jsonResponse({ data: buildDetailPayload() });
    }

    const directKey = getDirectCardKey(query);
    assert.ok(directKey, `expected direct detail query: ${JSON.stringify(query)}`);
    return jsonResponse({
      data: {
        card: {
          [CARD_ID]: buildCard(),
          [CHILD_ID]: buildCard({ cardId: CHILD_ID, accountSeq: CARD_SEQ + 1, title: "Child card" }),
        },
        deck: { "deck-1": { id: "deck-1", accountSeq: 12, title: "Tools" } },
        milestone: { "milestone-1": { id: "milestone-1", accountSeq: 34, name: "Agent Milestone" } },
        user: { "user-1": { id: "user-1", name: "Agent" } },
        [directKey]: CARD_ID,
      },
    });
  }, async () => {
    const result = await tools.card_get.execute({ title: "Structured retrieval card" });
    const data = getData(String(result));
    assert.ok(isObject(data.card), "expected data.card object");
    assert.equal((data.card as AnyRecord).cardId, CARD_ID);
    assert.equal(callCount, 2, "title lookup should search then fetch detail once");
  });
};

const testSemanticApiErrorsReturnApiError = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(() => jsonResponse({ errors: [{ message: "Cannot query field isDoc" }] }), async () => {
    const result = await tools.card_get.execute({ cardId: CARD_ID });
    const error = getError(String(result));
    assert.equal(error.category, "api_error");
    assert.match(String(error.message), /Cannot query field isDoc/);
  });
};

const testCardMapFallbackDoesNotBecomeCard = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch((query) => {
    const directKey = getDirectCardKey(query);
    assert.ok(directKey, `expected direct detail query: ${JSON.stringify(query)}`);
    return jsonResponse({
      data: {
        [directKey]: "missing-card-ref",
        card: {
          [CARD_ID]: buildCard(),
        },
      },
    });
  }, async () => {
    const result = await tools.card_get.execute({ cardId: "missing-card-ref" });
    const error = getError(String(result));
    assert.equal(error.category, "not_found");
  });
};

const testZeroAccountSeqIsPreserved = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch((query) => {
    const cardsRelation = getAccountRelation(query, "cards");
    assert.ok(cardsRelation, `expected account sequence query: ${JSON.stringify(query)}`);
    assert.match(cardsRelation.key, /\"accountSeq\":\[0\]/);
    return jsonResponse({ data: buildDetailPayload(buildCard({ accountSeq: 0 })) });
  }, async () => {
    const result = await tools.card_get.execute({ cardId: "$zz" });
    const data = getData(String(result));
    assert.ok(isObject(data.card), "expected data.card object");
    assert.equal((data.card as AnyRecord).accountSeq, 0);
  });
};

const testValidationRequiresCardIdOrTitle = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(() => {
    throw new Error("card_get should not call the API when required inputs are missing");
  }, async () => {
    const result = await tools.card_get.execute({});
    const error = getError(String(result));
    assert.equal(error.category, "validation_error");
  });
};

const tools = await loadTools();
await testDirectShortCodeReturnsStructuredCard(tools);
await testTitleLookupAmbiguousReturnsCandidates(tools);
await testTitleLookupNoMatchReturnsStructuredError(tools);
await testTitleLookupSingleFetchesDetail(tools);
await testSemanticApiErrorsReturnApiError(tools);
await testCardMapFallbackDoesNotBecomeCard(tools);
await testZeroAccountSeqIsPreserved(tools);
await testValidationRequiresCardIdOrTitle(tools);

console.log("card_get tool test passed");
