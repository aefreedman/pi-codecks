import assert from "node:assert/strict";

type AnyRecord = Record<string, unknown>;

type ToolModule = typeof import("../src/codecks-core.ts");

type QueryHandler = (query: AnyRecord) => Response | Promise<Response>;

const ACCOUNT_ID = "acct-1";
const CARD_ID = "f050d696-2d1d-11f1-aefd-cbe0288ce232";
const BOARD_ID = "f236cb96-2d1d-11f1-aefd-2b4112c125cb";
const CARD_SEQ = 1853;

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

const getDirectKey = (query: AnyRecord, entity: string): string | undefined =>
  Object.keys(query).find((key) => key.startsWith(`${entity}(`));

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

const buildCardRelationPayload = (card: AnyRecord, relationKey: string): AnyRecord => ({
  _root: { account: ACCOUNT_ID },
  account: {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      [relationKey]: [String(card.cardId)],
    },
  },
  card: {
    [String(card.cardId)]: card,
  },
});

const buildCapabilityPayload = (enabled: boolean): AnyRecord => ({
  _root: { account: ACCOUNT_ID },
  account: {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      visionBoardEnabled: enabled,
    },
  },
});

const buildVisionBoardRelationPayload = (visionBoard: AnyRecord, relationKey: string): AnyRecord => ({
  _root: { account: ACCOUNT_ID },
  account: {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      [relationKey]: [String(visionBoard.id)],
    },
  },
  visionBoard: {
    [String(visionBoard.id)]: visionBoard,
  },
});

const buildVisionBoardQueryRelationPayload = (queries: AnyRecord[], relationKey: string): AnyRecord => ({
  _root: { account: ACCOUNT_ID },
  account: {
    [ACCOUNT_ID]: {
      id: ACCOUNT_ID,
      [relationKey]: queries.map((entry) => String(entry.id)),
    },
  },
  visionBoardQuery: Object.fromEntries(queries.map((entry) => [String(entry.id), entry])),
});

const buildHandler = (overrides: {
  card?: AnyRecord;
  capability?: boolean;
  directVisionBoard?: AnyRecord | null;
  accountVisionBoards?: AnyRecord[];
  queries?: AnyRecord[];
  cardErrorStatus?: number;
  directVisionBoardErrorStatus?: number;
  accountVisionBoardsErrorStatus?: number;
  queryErrorStatus?: number;
} = {}): QueryHandler => {
  const card = overrides.card ?? {
    cardId: CARD_ID,
    accountSeq: CARD_SEQ,
    title: "VisionBoard reference",
    visionBoard: BOARD_ID,
  };
  const capability = overrides.capability ?? true;

  return async (query) => {
    const directCardKey = getDirectKey(query, "card");
    if (directCardKey) {
      if (overrides.cardErrorStatus) {
        return jsonResponse({ error: "forbidden" }, overrides.cardErrorStatus);
      }
      return jsonResponse({
        card: {
          [String(card.cardId)]: card,
        },
      });
    }

    const cardsRelation = getAccountRelation(query, "cards");
    if (cardsRelation) {
      if (overrides.cardErrorStatus) {
        return jsonResponse({ error: "forbidden" }, overrides.cardErrorStatus);
      }
      return jsonResponse(buildCardRelationPayload(card, cardsRelation.key));
    }

    const directVisionBoardKey = getDirectKey(query, "visionBoard");
    if (directVisionBoardKey) {
      if (overrides.directVisionBoardErrorStatus) {
        return jsonResponse({ error: "internal server error" }, overrides.directVisionBoardErrorStatus);
      }
      const directVisionBoard = overrides.directVisionBoard ?? {
        id: BOARD_ID,
        accountSeq: 99,
        createdAt: "2026-03-31T12:23:00Z",
        isDeleted: false,
        creator: {
          id: "user-1",
          name: "Angela",
        },
      };
      return jsonResponse({
        visionBoard: {
          [String(directVisionBoard.id)]: directVisionBoard,
        },
      });
    }

    const capabilityRelation = Array.isArray(query._root)
      && isObject(query._root[0])
      && Array.isArray((query._root[0] as AnyRecord).account)
      && ((query._root[0] as AnyRecord).account as unknown[]).includes("visionBoardEnabled");
    if (capabilityRelation) {
      return jsonResponse(buildCapabilityPayload(capability));
    }

    const visionBoardsRelation = getAccountRelation(query, "visionBoards");
    if (visionBoardsRelation) {
      if (overrides.accountVisionBoardsErrorStatus) {
        return jsonResponse({ error: "internal server error" }, overrides.accountVisionBoardsErrorStatus);
      }
      const board = (overrides.accountVisionBoards ?? [
        {
          id: BOARD_ID,
          accountSeq: 111,
          createdAt: "2026-03-31T12:23:00Z",
          isDeleted: false,
          creator: { id: "user-2", fullName: "Board User" },
        },
      ])[0];
      return jsonResponse(buildVisionBoardRelationPayload(board, visionBoardsRelation.key));
    }

    const visionBoardQueriesRelation = getAccountRelation(query, "visionBoardQueries");
    if (visionBoardQueriesRelation) {
      if (overrides.queryErrorStatus) {
        return jsonResponse({ error: "internal server error" }, overrides.queryErrorStatus);
      }
      const queries = overrides.queries ?? [];
      return jsonResponse(buildVisionBoardQueryRelationPayload(queries, visionBoardQueriesRelation.key));
    }

    throw new Error(`Unhandled query: ${JSON.stringify(query)}`);
  };
};

const loadTools = async (): Promise<ToolModule> => {
  process.env.CODECKS_ACCOUNT = "test-account";
  process.env.CODECKS_TOKEN = "test-token";
  return import("../src/codecks-core.ts");
};

const testShortCodeAndDollarCodeResolve = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({ directVisionBoardErrorStatus: 500, accountVisionBoardsErrorStatus: 500, queryErrorStatus: 500 }), async () => {
    const shortResult = await tools.card_get_vision_board.execute({ cardId: "3c5", format: "json" });
    const shortData = getData(String(shortResult));
    assert.equal(shortData.resolvedCardId, CARD_ID);
    assert.equal(shortData.shortCode, "$3c5");
    assert.equal(shortData.status, "available");

    const dollarResult = await tools.card_get_vision_board.execute({ cardId: "$3c5", format: "json" });
    const dollarData = getData(String(dollarResult));
    assert.equal(dollarData.resolvedCardId, CARD_ID);
    assert.equal(dollarData.shortCode, "$3c5");
  });
};

const testUuidResolutionAndAbsentStatus = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({ card: { cardId: CARD_ID, accountSeq: CARD_SEQ, title: "No board card" } }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json" });
    const data = getData(String(result));
    assert.equal(data.resolvedCardId, CARD_ID);
    assert.equal(data.status, "absent");
    assert.equal(data.queryCount, 0);
    assert.equal(data.visionBoard, null);
  });
};

const testFallbackWhenDirectLookupFails = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({
    directVisionBoardErrorStatus: 500,
    accountVisionBoards: [
      {
        id: BOARD_ID,
        accountSeq: 777,
        createdAt: "2026-03-31T12:24:00Z",
        isDeleted: false,
        creator: { id: "user-9", name: "Fallback User" },
      },
    ],
    queryErrorStatus: 500,
  }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json" });
    const data = getData(String(result));
    assert.equal(data.status, "available");
    assert.equal(data.source, "account.visionBoards");
    assert.ok(isObject(data.visionBoard));
    assert.equal((data.visionBoard as AnyRecord).accountSeq, 777);
  });
};

const testMultipleQueriesOrderedAndPayloadOmitted = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({
    queries: [
      {
        id: "q-older",
        type: "filter",
        createdAt: "2026-03-31T12:20:00Z",
        lastUsedAt: "2026-03-31T12:21:00Z",
        isStale: false,
        card: { cardId: CARD_ID },
        query: { old: true },
        payload: { old: true },
      },
      {
        id: "q-newer",
        type: "filter",
        createdAt: "2026-03-31T12:22:00Z",
        lastUsedAt: "2026-03-31T12:25:00Z",
        isStale: false,
        card: { cardId: CARD_ID },
        query: { newest: true },
        payload: { newest: true },
      },
    ],
  }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json" });
    const data = getData(String(result));
    assert.equal(data.source, "account.visionBoardQueries");
    assert.equal(data.queryCount, 2);
    assert.ok(Array.isArray(data.queries));
    const queries = data.queries as AnyRecord[];
    assert.equal(queries[0].lastUsedAt, "2026-03-31T12:25:00Z");
    assert.ok(!("query" in queries[0]));
    assert.ok(!("payload" in queries[0]));
  });
};

const testIncludePayloadTruncates = async (tools: ToolModule): Promise<void> => {
  const longString = "x".repeat(5005);
  await withMockedFetch(buildHandler({
    queries: [
      {
        id: "q-big",
        type: "payload",
        createdAt: "2026-03-31T12:20:00Z",
        lastUsedAt: "2026-03-31T12:25:00Z",
        isStale: false,
        card: { cardId: CARD_ID },
        query: { large: longString },
        payload: { large: longString },
      },
    ],
  }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json", includePayload: true });
    const data = getData(String(result));
    assert.equal(data.payloadIncluded, true);
    assert.equal(data.payloadTruncated, true);
    const queries = data.queries as AnyRecord[];
    assert.ok(typeof queries[0].query === "object");
    assert.match(String((queries[0].query as AnyRecord).large), /truncated/i);
    assert.match(String((queries[0].payload as AnyRecord).large), /truncated/i);
  });
};

const testUnsupportedCapability = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({ capability: false, card: { cardId: CARD_ID, accountSeq: CARD_SEQ, title: "Unsupported" } }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json" });
    const data = getData(String(result));
    assert.equal(data.status, "unsupported");
    assert.equal(data.queryCount, 0);
  });
};

const testMalformedPayloadShapeDoesNotCrash = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({
    queries: [
      {
        id: "q-weird",
        type: "payload",
        createdAt: "2026-03-31T12:20:00Z",
        lastUsedAt: "2026-03-31T12:25:00Z",
        isStale: true,
        card: { cardId: CARD_ID },
        query: "odd-string-query",
        payload: ["a", { nested: true }, 42],
      },
    ],
  }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json", includePayload: true });
    const data = getData(String(result));
    const queries = data.queries as AnyRecord[];
    assert.equal(data.status, "available");
    assert.equal(typeof queries[0].query, "string");
    assert.ok(Array.isArray(queries[0].payload));
  });
};

const testForbiddenErrorReturnsStructuredError = async (tools: ToolModule): Promise<void> => {
  await withMockedFetch(buildHandler({ cardErrorStatus: 403 }), async () => {
    const result = await tools.card_get_vision_board.execute({ cardId: CARD_ID, format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "forbidden");
  });
};

const main = async (): Promise<void> => {
  const tools = await loadTools();
  await testShortCodeAndDollarCodeResolve(tools);
  await testUuidResolutionAndAbsentStatus(tools);
  await testFallbackWhenDirectLookupFails(tools);
  await testMultipleQueriesOrderedAndPayloadOmitted(tools);
  await testIncludePayloadTruncates(tools);
  await testUnsupportedCapability(tools);
  await testMalformedPayloadShapeDoesNotCrash(tools);
  await testForbiddenErrorReturnsStructuredError(tools);
  console.log("PASS: vision board tool unit tests");
};

await main();
