import assert from "node:assert/strict";

type AnyRecord = Record<string, any>;
type ToolModule = typeof import("../src/codecks-core.ts");

const ACCOUNT_ID = "account-test";
const CARD_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const DECK_ID = "55555555-5555-4555-8555-555555555555";
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

const buildDeck = (overrides: AnyRecord = {}): AnyRecord => ({
  id: DECK_ID,
  accountSeq: 12,
  title: "Development",
  description: "Existing deck description",
  ...overrides,
});

const buildDeckPayload = (relationKey: string, decks: AnyRecord[] = [buildDeck()]): AnyRecord => ({
  data: {
    _root: { account: ACCOUNT_ID },
    account: {
      [ACCOUNT_ID]: {
        id: ACCOUNT_ID,
        [relationKey]: decks.map((deck) => String(deck.id)),
      },
    },
    deck: Object.fromEntries(decks.map((deck) => [String(deck.id), deck])),
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
  const core = await import("../src/codecks-core.ts");
  return new Proxy(core, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as AnyRecord;
      if (!value || typeof value !== "object" || typeof value.execute !== "function") return value;
      return {
        ...value,
        execute(args: AnyRecord) {
          return core.runWithAbortSignal(undefined, () => value.execute(args), process.cwd());
        },
      };
    },
  }) as ToolModule;
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

const testDeckUpdateDispatchesDescription = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "decks/update") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }

    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "decks");
    assert.ok(relationKey, `expected decks query: ${JSON.stringify(query)}`);
    assert.match(relationKey, /accountSeq/);
    return jsonResponse(buildDeckPayload(relationKey));
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: 12, description: "New deck description", format: "json" });
    const data = getData(String(result));
    assert.equal(data.deckId, DECK_ID);
    assert.equal(data.accountSeq, 12);
    assert.equal(data.title, "Development");
    assert.equal(data.description, "New deck description");
    assert.equal(data.descriptionCleared, false);
    assert.deepEqual(data.updatedFields, ["description"]);
    assert.ok(updatePayload, "expected deck update dispatch");
    assert.deepEqual(updatePayload, { id: DECK_ID, description: "New deck description" });
  });
};

const testDeckUpdateResolvesTitle = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "decks/update") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }
    const relationKey = getAccountRelationKey(query!, "decks");
    assert.ok(relationKey, `expected decks query: ${JSON.stringify(query)}`);
    return jsonResponse(buildDeckPayload(relationKey));
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: "Development", description: "By title", format: "json" });
    assert.equal(getData(String(result)).deckId, DECK_ID);
    assert.equal(updatePayload?.id, DECK_ID);
  });
};

const testDeckUpdateRejectsAmbiguousTitle = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query", "ambiguous deck lookup must not dispatch");
    const relationKey = getAccountRelationKey(query!, "decks");
    assert.ok(relationKey, `expected decks query: ${JSON.stringify(query)}`);
    return jsonResponse(buildDeckPayload(relationKey, [
      buildDeck({ id: DECK_ID, title: "Development" }),
      buildDeck({ id: "66666666-6666-4666-8666-666666666666", accountSeq: 13, title: "Developer Relations" }),
    ]));
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: "Develop", description: "Ambiguous", format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "ambiguous_match");
  });
};

const testDeckUpdateClearsDescription = async (tools: ToolModule): Promise<void> => {
  let updatePayload: AnyRecord | undefined;
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "decks/update") {
      updatePayload = payload;
      return jsonResponse({ payload: {} });
    }
    const relationKey = getAccountRelationKey(query!, "decks");
    assert.ok(relationKey, `expected decks query: ${JSON.stringify(query)}`);
    return jsonResponse(buildDeckPayload(relationKey));
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: 12, clearDescription: true, format: "json" });
    const data = getData(String(result));
    assert.equal(data.description, "");
    assert.equal(data.descriptionCleared, true);
    assert.deepEqual(updatePayload, { id: DECK_ID, description: "" });
  });
};

const testDeckUpdateRequiresDescription = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(() => {
    assert.fail("deck update without description should not reach Codecks");
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: 12, format: "json" });
    assert.equal(getError(String(result)).category, "validation_error");
  });
};

const testDeckUpdateRejectsNullDescription = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(() => {
    assert.fail("deck update with null description should not reach Codecks");
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: 12, description: null, format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "validation_error");
    assert.match(String(error.message), /description must be a string/i);
  });
};

const testDeckUpdateReportsDispatchFailure = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    if (path === "decks/update") return jsonResponse({ error: "rejected" }, 400);
    const relationKey = getAccountRelationKey(query!, "decks");
    assert.ok(relationKey, `expected decks query: ${JSON.stringify(query)}`);
    return jsonResponse(buildDeckPayload(relationKey));
  }, async () => {
    const result = await tools.deck_update.execute({ deckId: 12, description: "Rejected", format: "json" });
    assert.equal(getError(String(result)).category, "api_error");
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
    if (JSON.stringify(query).includes("loggedInUser")) {
      return jsonResponse({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Fixture User" } } } });
    }
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

const testBulkCreateRejectsInvalidUuidLocationsWithoutDispatch = async (tools: ToolModule): Promise<void> => {
  const invalidDeckId = "fe9a15eb-9262-11f1-b0b7-a7bf58105ef2";
  const invalidMilestoneId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  for (const location of [
    { field: "deck", value: invalidDeckId, relation: "decks" },
    { field: "milestone", value: invalidMilestoneId, relation: "milestones" },
  ] as const) {
    let createDispatches = 0;
    await withMockedCodecks(({ path, query }) => {
      if (path === "cards/create") {
        createDispatches += 1;
        return jsonResponse({});
      }
      assert.equal(path, "query");
      if (JSON.stringify(query).includes("loggedInUser")) {
        return jsonResponse({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Fixture User" } } } });
      }
      const relationKey = getAccountRelationKey(query!, location.relation);
      assert.ok(relationKey, `expected ${location.relation} lookup query: ${JSON.stringify(query)}`);
      return location.relation === "decks"
        ? jsonResponse(buildDeckPayload(relationKey!))
        : jsonResponse(buildMilestonePayload(relationKey!));
    }, async () => {
      const result = await tools.card_bulk_create.execute({
        cards: [{ title: "Invalid location", [location.field]: location.value }],
        dryRun: true,
        format: "json",
      });
      const error = getError(String(result));
      assert.equal(error.category, "validation_error");
      assert.match(String(error.message), new RegExp(`cards\\[0\\]\\.${location.field}: No ${location.field} matched`, "i"));
      assert.equal(createDispatches, 0, `invalid ${location.field} must not dispatch cards/create`);
    });
  }
};

const testCardCreateRejectsInvalidUuidDeckWithoutDispatch = async (tools: ToolModule): Promise<void> => {
  const invalidDeckId = "fe9a15eb-9262-11f1-b0b7-a7bf58105ef2";
  let createDispatches = 0;
  await withMockedCodecks(({ path, query }) => {
    if (path === "cards/create") {
      createDispatches += 1;
      return jsonResponse({});
    }
    assert.equal(path, "query");
    const relationKey = getAccountRelationKey(query!, "decks");
    assert.ok(relationKey, `expected deck lookup query: ${JSON.stringify(query)}`);
    return jsonResponse(buildDeckPayload(relationKey!));
  }, async () => {
    const result = await tools.card_create.execute({ title: "Invalid deck", deck: invalidDeckId, format: "json" });
    const error = getError(String(result));
    assert.equal(error.category, "not_found");
    assert.match(String(error.message), /No deck matched/i);
    assert.equal(createDispatches, 0, "invalid deck must not dispatch cards/create");
  });
};

const testBulkCreateResolvesValidUuidLocations = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    assert.equal(path, "query");
    if (JSON.stringify(query).includes("loggedInUser")) {
      return jsonResponse({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Fixture User" } } } });
    }
    const deckKey = getAccountRelationKey(query!, "decks");
    if (deckKey) return jsonResponse(buildDeckPayload(deckKey));
    const milestoneKey = getAccountRelationKey(query!, "milestones");
    if (milestoneKey) return jsonResponse(buildMilestonePayload(milestoneKey));
    const cardKey = getAccountRelationKey(query!, "cards");
    assert.ok(cardKey, `expected card duplicate scan: ${JSON.stringify(query)}`);
    return jsonResponse({ data: { _root: { account: ACCOUNT_ID }, account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [cardKey!]: [] } }, card: {} } });
  }, async () => {
    const result = await tools.card_bulk_create.execute({
      cards: [{ title: "Resolved UUIDs", deck: DECK_ID, milestone: MILESTONE_ID }],
      dryRun: true,
      format: "json",
    });
    const data = getData(String(result));
    assert.equal(data.results[0].status, "ready");
    assert.deepEqual(data.results[0].deck, { id: DECK_ID, name: "Development" });
    assert.deepEqual(data.results[0].milestone, { id: MILESTONE_ID, name: "Alpha" });
  });
};

const testSingleAndBulkCreateUseIdenticalPayloads = async (tools: ToolModule): Promise<void> => {
  const payloads: AnyRecord[] = [];
  await withMockedCodecks(({ path, query, payload }) => {
    if (path === "cards/create") {
      payloads.push(payload!);
      return jsonResponse({ payload: { card: { cardId: CARD_ID, accountSeq: 123 } } });
    }
    assert.equal(path, "query");
    if (JSON.stringify(query).includes("loggedInUser")) {
      return jsonResponse({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Fixture User" } } } });
    }
    const cardKey = getAccountRelationKey(query!, "cards");
    if (cardKey) {
      return jsonResponse({ data: { _root: { account: ACCOUNT_ID }, account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [cardKey]: [] } }, card: {} } });
    }
    const key = directCardKey(query!);
    assert.ok(key, `expected created-card lookup: ${JSON.stringify(query)}`);
    return jsonResponse(buildCardPayload(buildCard({ accountSeq: 123 })));
  }, async () => {
    const input = {
      title: "Shared payload",
      content: "Body",
      cardType: "documentation",
      deck: 12,
      milestone: 84,
      effort: 3,
      priority: "high",
      putOnHand: true,
      tags: ["alpha"],
    };
    getData(String(await tools.card_create.execute({ ...input, format: "json" })));
    getData(String(await tools.card_bulk_create.execute({ cards: [input], dryRun: false, format: "json" })));
  });
  assert.equal(payloads.length, 2, "expected one single and one bulk create dispatch");
  assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(payloads[0].deckId, "12");
  assert.equal(payloads[0].milestoneId, "84");
  assert.equal(payloads[0].isDoc, true);
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

const testConcreteMutationRejectsRootErrors = async (tools: ToolModule): Promise<void> => {
  await withMockedCodecks(({ path, query }) => {
    if (path === "cards/update") {
      return jsonResponse({ errors: [{ message: "token=mutation-secret rejected" }] });
    }

    assert.equal(path, "query");
    const key = directCardKey(query!);
    assert.ok(key, `expected direct card query: ${JSON.stringify(query)}`);
    return jsonResponse(buildCardPayload());
  }, async () => {
    const result = String(await tools.card_update_effort.execute({ cardId: CARD_ID, effort: 3, format: "json" }));
    const error = getError(result);
    assert.equal(error.category, "api_error");
    assert.match(String(error.message), /semantic error/i);
    assert.doesNotMatch(result, /mutation-secret/);
    assert.match(result, /\[REDACTED\]/);
  });
};

const tools = await loadTools();
await testStatusUpdateBlocksOpenReview(tools);
await testPrivateCardCreationDefaultsOwner(tools);
await testCardCreateCoercesNumericLocationIdsForDispatch(tools);
await testCardListResolvablesEmptyIsSuccessful(tools);
await testCardSearchNoMatchesIsSuccessful(tools);
await testBulkCreateDryRunReportsDuplicateCandidates(tools);
await testBulkCreateRejectsInvalidUuidLocationsWithoutDispatch(tools);
await testCardCreateRejectsInvalidUuidDeckWithoutDispatch(tools);
await testBulkCreateResolvesValidUuidLocations(tools);
await testSingleAndBulkCreateUseIdenticalPayloads(tools);
await testRunUpdateDispatchesSprintUpdate(tools);
await testRunUpdateClearsCustomLabel(tools);
await testDeckUpdateDispatchesDescription(tools);
await testDeckUpdateResolvesTitle(tools);
await testDeckUpdateRejectsAmbiguousTitle(tools);
await testDeckUpdateClearsDescription(tools);
await testDeckUpdateRequiresDescription(tools);
await testDeckUpdateRejectsNullDescription(tools);
await testDeckUpdateReportsDispatchFailure(tools);
await testMilestoneListReturnsFilteredMilestones(tools);
await testMilestoneGetReturnsDescription(tools);
await testMilestoneUpdateDispatchesDescription(tools);
await testMilestoneUpdateClearsDescriptionWithEmptyString(tools);
await testMilestoneUpdateRequiresDescription(tools);
await testMilestoneUpdateRejectsNullDescription(tools);
await testCardRunAssignmentDispatchesSprintId(tools);
await testCardRunClearDispatchesNullSprintId(tools);
await testConcreteMutationRejectsRootErrors(tools);

console.log("CDX tool update tests passed");
