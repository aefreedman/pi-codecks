import assert from "node:assert/strict";

type AnyRecord = Record<string, any>;
type ToolModule = typeof import("../src/codecks-core.ts");

const ACCOUNT_ID = "account-test";
const CARD_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const MILESTONE_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "33333333-3333-4333-8333-333333333333";

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

const getAccountRelationKey = (query: AnyRecord, relation: string): string | undefined => {
  const root = Array.isArray(query._root) ? query._root[0] : undefined;
  const accountEntries = isObject(root) && Array.isArray(root.account) ? root.account : [];
  for (const entry of accountEntries) {
    if (!isObject(entry)) continue;
    const key = Object.keys(entry).find((candidate) => candidate === relation || candidate.startsWith(`${relation}(`));
    if (key) return key;
  }
  return undefined;
};

const directCardKey = (query: AnyRecord): string | undefined => Object.keys(query).find((key) => key.startsWith("card("));

const buildCard = (overrides: AnyRecord = {}): AnyRecord => ({
  cardId: CARD_ID,
  accountSeq: 100,
  title: "Card under test",
  content: "Card under test\n\nBody",
  status: "not_started",
  derivedStatus: "not_started",
  isDoc: false,
  ...overrides,
});

const buildCardPayload = (card: AnyRecord = buildCard()): AnyRecord => ({
  data: {
    card: {
      [String(card.cardId)]: card,
    },
  },
});

const buildRun = (overrides: AnyRecord = {}): AnyRecord => ({
  id: RUN_ID,
  accountSeq: 91,
  name: "Current Run",
  description: "Run description",
  startDate: "2026-05-11",
  endDate: "2026-05-24",
  isDeleted: false,
  completedAt: null,
  lockedAt: null,
  ...overrides,
});

const buildRunPayload = (relationKey: string, run: AnyRecord = buildRun(), cards: AnyRecord[] = []): AnyRecord => ({
  data: {
    _root: { account: ACCOUNT_ID },
    account: {
      [ACCOUNT_ID]: {
        id: ACCOUNT_ID,
        sprintsEnabled: true,
        [relationKey]: [String(run.id)],
      },
    },
    sprint: {
      [String(run.id)]: {
        ...run,
        ...(cards.length > 0 ? { cards: cards.map((card) => String(card.cardId)) } : {}),
      },
    },
    card: Object.fromEntries(cards.map((card) => [String(card.cardId), card])),
  },
});

const buildMilestone = (overrides: AnyRecord = {}): AnyRecord => ({
  id: MILESTONE_ID,
  accountSeq: 84,
  name: "Alpha",
  description: "Existing description",
  date: "2026-06-28",
  startDate: null,
  color: "green",
  isGlobal: true,
  handSyncEnabled: false,
  isDeleted: false,
  ...overrides,
});

const buildMilestonePayload = (relationKey: string, milestone: AnyRecord = buildMilestone()): AnyRecord => ({
  data: {
    _root: { account: ACCOUNT_ID },
    account: {
      [ACCOUNT_ID]: {
        id: ACCOUNT_ID,
        [relationKey]: [String(milestone.id)],
      },
    },
    milestone: {
      [String(milestone.id)]: milestone,
    },
  },
});

const withMockedCodecks = async (
  handler: (request: { path: string; query?: AnyRecord; payload?: AnyRecord }) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<void> => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const bodyText = String(init?.body ?? "{}");
    const body = bodyText ? JSON.parse(bodyText) as AnyRecord : {};
    const dispatchMatch = url.match(/\/dispatch\/(.+)$/);
    if (dispatchMatch) {
      return handler({ path: dispatchMatch[1], payload: body });
    }
    assert.ok(isObject(body.query), `expected query object, got: ${bodyText}`);
    return handler({ path: "query", query: body.query });
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
  delete process.env.CODECKS_DEFAULT_ASSIGNEE_ID;
  return import("../src/codecks-core.ts");
};

const testStatusUpdateBlocksOpenReview = async (tools: ToolModule): Promise<void> => {
  let dispatchCount = 0;
  await withMockedCodecks(({ path, query }) => {
    if (path !== "query") {
      dispatchCount += 1;
      return jsonResponse({ payload: {} });
    }

    const key = directCardKey(query!);
    assert.ok(key, `expected direct card query: ${JSON.stringify(query)}`);
    const fields = query![key] as unknown[];
    const hasResolvableRelation = JSON.stringify(fields).includes("resolvables");
    if (hasResolvableRelation) {
      return jsonResponse({
        data: {
          card: {
            [CARD_ID]: {
              ...buildCard(),
              resolvables: ["review-1"],
            },
          },
          resolvable: {
            "review-1": { id: "review-1", context: "review", isClosed: false },
          },
        },
      });
    }

    return jsonResponse(buildCardPayload());
  }, async () => {
    const result = await tools.card_update_status.execute({ cardId: CARD_ID, status: "done", format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "validation_error");
    assert.match(String(error.message), /open Review/i);
    assert.equal(dispatchCount, 0, "status update should not dispatch when review is open");
  });
};

const testPrivateCardCreationDefaultsOwner = async (tools: ToolModule): Promise<void> => {
  let createPayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "cards/create") {
      createPayload = payload;
      return jsonResponse({ payload: { card: { cardId: CARD_ID, accountSeq: 123 } } });
    }

    assert.equal(path, "query");
    if (query!._root) {
      return jsonResponse({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Agent" } } } });
    }

    const key = directCardKey(query!);
    assert.ok(key, `expected created card lookup query: ${JSON.stringify(query)}`);
    return jsonResponse(buildCardPayload(buildCard({ accountSeq: 123 })));
  }, async () => {
    const result = await tools.card_create.execute({ title: "Private card", content: "Body", format: "json" });
    assert.ok(createPayload, "expected create dispatch");
    assert.equal(createPayload!.deckId, null);
    assert.equal(createPayload!.assigneeId, USER_ID);
    assert.equal(createPayload!.userId, USER_ID);
    const payload = parseToolResult(String(result));
    assert.equal(payload.ok, true);
    assert.ok(Array.isArray(payload.warnings), "expected private-card warning");
    assert.match(String(payload.warnings[0]), /Private card/i);
    assert.equal(payload.data.privateCard, true);
    assert.equal(payload.data.ownerId, USER_ID);
  });
};

const testCardCreateCoercesNumericLocationIdsForDispatch = async (tools: ToolModule): Promise<void> => {
  let createPayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "cards/create") {
      createPayload = payload;
      return jsonResponse({ payload: { card: { cardId: CARD_ID, accountSeq: 123 } } });
    }

    assert.equal(path, "query");
    if (query!._root) {
      return jsonResponse({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Agent" } } } });
    }

    const key = directCardKey(query!);
    assert.ok(key, `expected created card lookup query: ${JSON.stringify(query)}`);
    return jsonResponse(buildCardPayload(buildCard({ accountSeq: 123 })));
  }, async () => {
    const result = await tools.card_create.execute({ title: "Scoped card", content: "Body", deck: 12, milestone: 84, format: "json" });
    getData(String(result));
    assert.ok(createPayload, "expected create dispatch");
    assert.equal(createPayload!.deckId, "12");
    assert.equal(createPayload!.milestoneId, "84");
  });
};

const testCardListResolvablesEmptyIsSuccessful = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query");
    const key = directCardKey(query!);
    assert.ok(key, `expected direct card query: ${JSON.stringify(query)}`);
    return jsonResponse({
      data: {
        card: {
          [CARD_ID]: {
            ...buildCard(),
            resolvables: [],
          },
        },
        resolvable: {},
      },
    });
  }, async () => {
    const result = await tools.card_list_resolvables.execute({ cardId: CARD_ID, contexts: ["review"], format: "json" });
    const data = getData(String(result));
    assert.equal(data.total, 0);
    assert.deepEqual(data.threads, []);
  });
};

const testRunUpdateDispatchesSprintUpdate = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "sprints/updateSprint") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "sprints");
    assert.ok(relationKey, `expected sprints query: ${JSON.stringify(query)}`);
    assert.match(relationKey, /accountSeq/);
    return jsonResponse(buildRunPayload(relationKey));
  }, async () => {
    const result = await tools.run_update.execute({ runId: 91, customLabel: "New Label", description: "New description", format: "json" });
    const data = getData(String(result));
    assert.equal(data.runId, RUN_ID);
    assert.ok(updatePayload, "expected run update dispatch");
    assert.equal(updatePayload!.id, RUN_ID);
    assert.equal(updatePayload!.name, "New Label");
    assert.equal(updatePayload!.description, "New description");
  });
};

const testRunUpdateClearsCustomLabel = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "sprints/updateSprint") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "sprints");
    assert.ok(relationKey, `expected sprints query: ${JSON.stringify(query)}`);
    return jsonResponse(buildRunPayload(relationKey));
  }, async () => {
    const result = await tools.run_update.execute({ runId: 91, clearCustomLabel: true, format: "json" });
    const data = getData(String(result));
    assert.equal(data.runId, RUN_ID);
    assert.ok(updatePayload, "expected run update dispatch");
    assert.equal(updatePayload!.id, RUN_ID);
    assert.equal(updatePayload!.name, null);
  });
};

const testCardRunAssignmentDispatchesSprintId = async (tools: ToolModule): Promise<void> => {
  let cardUpdatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "cards/update") {
      cardUpdatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "sprints");
    if (relationKey) {
      return jsonResponse(buildRunPayload(relationKey));
    }

    const key = directCardKey(query!);
    assert.ok(key, `expected card or sprint query: ${JSON.stringify(query)}`);
    return jsonResponse(buildCardPayload());
  }, async () => {
    const result = await tools.card_update_run.execute({ cardId: CARD_ID, runId: 91, format: "json" });
    const data = getData(String(result));
    assert.equal(data.sprintId, RUN_ID);
    assert.ok(cardUpdatePayload, "expected card update dispatch");
    assert.equal(cardUpdatePayload!.id, CARD_ID);
    assert.equal(cardUpdatePayload!.sprintId, RUN_ID);
  });
};

const testMilestoneListReturnsFilteredMilestones = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "milestones");
    assert.ok(relationKey, `expected milestones query: ${JSON.stringify(query)}`);
    return jsonResponse(buildMilestonePayload(relationKey, buildMilestone({ name: "Alpha Release" })));
  }, async () => {
    const result = await tools.milestone_list.execute({ search: "alpha", format: "json" });
    const data = getData(String(result));
    assert.equal(data.total, 1);
    assert.equal(data.milestones[0].id, MILESTONE_ID);
    assert.equal(data.milestones[0].name, "Alpha Release");
    assert.match(String(data.milestones[0].url), /milestones\/84/);
  });
};

const testMilestoneGetReturnsDescription = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "milestones");
    assert.ok(relationKey, `expected milestones query: ${JSON.stringify(query)}`);
    assert.match(relationKey, /accountSeq/);
    return jsonResponse(buildMilestonePayload(relationKey));
  }, async () => {
    const result = await tools.milestone_get.execute({ milestoneId: 84, format: "json" });
    const data = getData(String(result));
    assert.equal(data.milestone.id, MILESTONE_ID);
    assert.equal(data.milestone.description, "Existing description");
    assert.match(String(data.milestone.url), /milestones\/84/);
  });
};

const testMilestoneUpdateDispatchesDescription = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "milestones/update") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "milestones");
    assert.ok(relationKey, `expected milestones query: ${JSON.stringify(query)}`);
    assert.match(relationKey, /accountSeq/);
    return jsonResponse(buildMilestonePayload(relationKey));
  }, async () => {
    const result = await tools.milestone_update.execute({ milestoneId: 84, description: "New description", format: "json" });
    const data = getData(String(result));
    assert.equal(data.milestoneId, MILESTONE_ID);
    assert.equal(data.description, "New description");
    assert.equal(data.descriptionCleared, false);
    assert.ok(updatePayload, "expected milestone update dispatch");
    assert.equal(updatePayload!.id, MILESTONE_ID);
    assert.equal(updatePayload!.description, "New description");
    assert.equal("sessionId" in updatePayload!, false, "milestone update should not add cards/update session metadata");
  });
};

const testMilestoneUpdateClearsDescriptionWithEmptyString = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "milestones/update") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "milestones");
    assert.ok(relationKey, `expected milestones query: ${JSON.stringify(query)}`);
    return jsonResponse(buildMilestonePayload(relationKey));
  }, async () => {
    const result = await tools.milestone_update.execute({ milestoneId: 84, clearDescription: true, format: "json" });
    const data = getData(String(result));
    assert.equal(data.description, "");
    assert.equal(data.descriptionCleared, true);
    assert.ok(updatePayload, "expected milestone update dispatch");
    assert.equal(updatePayload!.id, MILESTONE_ID);
    assert.equal(updatePayload!.description, "");
  });
};

const testMilestoneUpdateRequiresDescription = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(() => {
    assert.fail("milestone update without description should not reach Codecks");
  }, async () => {
    const result = await tools.milestone_update.execute({ milestoneId: 84, format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "validation_error");
    assert.match(String(error.message), /description/i);
  });
};

const testMilestoneUpdateRejectsNullDescription = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(() => {
    assert.fail("milestone update with null description should not reach Codecks");
  }, async () => {
    const result = await tools.milestone_update.execute({ milestoneId: 84, description: null, format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "validation_error");
    assert.match(String(error.message), /description must be a string/i);
  });
};

const testCardSearchNoMatchesIsSuccessful = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "cards");
    assert.ok(relationKey, `expected cards relation query: ${JSON.stringify(query)}`);
    return jsonResponse({
      data: {
        _root: { account: ACCOUNT_ID },
        account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [relationKey]: [] } },
        card: {},
      },
    });
  }, async () => {
    const result = await tools.card_search.execute({ title: "missing", format: "json" });
    const data = getData(String(result));
    assert.equal(data.matches, 0);
    assert.deepEqual(data.cards, []);
    assert.ok(Array.isArray(data.searchTips), "expected search tips for no-match result");
  });
};

const testBulkCreateDryRunReportsDuplicateCandidates = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "cards");
    assert.ok(relationKey, `expected cards relation query: ${JSON.stringify(query)}`);
    const card = buildCard({ title: "Duplicate title", accountSeq: 77 });
    return jsonResponse({
      data: {
        _root: { account: ACCOUNT_ID },
        account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [relationKey]: [CARD_ID] } },
        card: { [CARD_ID]: card },
      },
    });
  }, async () => {
    const result = await tools.card_bulk_create.execute({ cards: [{ title: "Duplicate title", content: "Body" }], dryRun: true, format: "json" });
    const data = getData(String(result));
    assert.equal(data.dryRun, true);
    assert.equal(data.duplicateCandidates, 1);
    assert.equal(data.results[0].status, "duplicate_candidate");
  });
};

const testCardRunClearDispatchesNullSprintId = async (tools: ToolModule): Promise<void> => {
  let cardUpdatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "cards/update") {
      cardUpdatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const key = directCardKey(query!);
    assert.ok(key, `expected card query: ${JSON.stringify(query)}`);
    return jsonResponse(buildCardPayload());
  }, async () => {
    const result = await tools.card_update_run.execute({ cardId: CARD_ID, clearRun: true, format: "json" });
    const data = getData(String(result));
    assert.equal(data.sprintId, null);
    assert.ok(cardUpdatePayload, "expected card update dispatch");
    assert.equal(cardUpdatePayload!.id, CARD_ID);
    assert.equal(cardUpdatePayload!.sprintId, null);
  });
};

const tools = await loadTools();
await testStatusUpdateBlocksOpenReview(tools);
await testPrivateCardCreationDefaultsOwner(tools);
await testCardCreateCoercesNumericLocationIdsForDispatch(tools);
await testCardListResolvablesEmptyIsSuccessful(tools);
await testCardSearchNoMatchesIsSuccessful(tools);
await testBulkCreateDryRunReportsDuplicateCandidates(tools);
await testRunUpdateDispatchesSprintUpdate(tools);
await testRunUpdateClearsCustomLabel(tools);
await testMilestoneListReturnsFilteredMilestones(tools);
await testMilestoneGetReturnsDescription(tools);
await testMilestoneUpdateDispatchesDescription(tools);
await testMilestoneUpdateClearsDescriptionWithEmptyString(tools);
await testMilestoneUpdateRequiresDescription(tools);
await testMilestoneUpdateRejectsNullDescription(tools);
await testCardRunAssignmentDispatchesSprintId(tools);
await testCardRunClearDispatchesNullSprintId(tools);

console.log("CDX tool update tests passed");
