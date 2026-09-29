import assert from "node:assert/strict";

process.env.CODECKS_ENABLE_DEBUG_TOOLS = "1";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "loader-only";

const { PiToolHarness } = await import("./pi-tool-harness.ts");
const {
  CODECKS_TOOL_SEARCH_NAME,
  DEBUG_CODECKS_TOOL_NAMES,
  DEFAULT_CODECKS_TOOL_NAMES,
} = await import("../src/codecks-tool-loading.ts");

const debugNames = [...DEBUG_CODECKS_TOOL_NAMES];
const harness = new PiToolHarness({ activeTools: [...DEFAULT_CODECKS_TOOL_NAMES, ...debugNames] });
await harness.load();
await harness.startSession();

assert.equal(harness.registry.size, 49, "debug opt-in registers 46 default tools, two debug tools, and loader");
assert(debugNames.every((name) => harness.registry.has(name)), "both opt-in debug definitions should be registered");
assert.deepEqual(new Set(harness.getActiveTools()), new Set([CODECKS_TOOL_SEARCH_NAME]), "loader-only defers opt-in debug tools like ordinary deferred tools");

const loader = harness.registry.get(CODECKS_TOOL_SEARCH_NAME)!;
const result = await loader.execute("debug-loader", { query: "diagnostic logged in user resolvables", toolNames: [debugNames[1]] });
assert.deepEqual(result.details.added, [debugNames[1]], "an explicitly requested registered diagnostic tool can activate");
assert(harness.getActiveTools().includes(debugNames[1]));

// Optional relation probes must only page schema-confirmed hasMany relations with an order.
const originalFetch = globalThis.fetch;
const core = await import("../src/codecks-core.ts");
const priorProfile = process.env.CODECKS_PROFILE;
const priorToken = process.env.CODECKS_PROFILE_PERSONAL_TOKEN;
const priorAccount = process.env.CODECKS_ACCOUNT;
const priorProvider = process.env.CODECKS_CREDENTIAL_PROVIDER;
try {
  process.env.CODECKS_ACCOUNT = "synthetic-account";
  process.env.CODECKS_PROFILE = "PERSONAL";
  process.env.CODECKS_PROFILE_PERSONAL_TOKEN = "cdxut_synthetic-debug-profile";
  process.env.CODECKS_CREDENTIAL_PROVIDER = "environment";
  const queries: Record<string, unknown>[] = [];
  let includeActionable = false;
  globalThis.fetch = (async (_url, init) => {
    const query = JSON.parse(String(init?.body ?? "{}")).query as Record<string, unknown>;
    queries.push(query);
    if (Object.keys(query)[0].startsWith("resolvable(")) {
      const key = Object.keys(query)[0];
      const relationKey = Object.keys((query as any)[key].find((entry: unknown) => typeof entry === "object" && entry !== null))[0];
      return new Response(JSON.stringify({ data: { [key]: "res-1", resolvable: { "res-1": { id: "res-1", [relationKey]: [] } } } }), { status: 200 });
    }
    if (JSON.stringify(query).includes('"account"')) {
      const key = Object.keys((query._root as any)[0].account[0])[0];
      if (!includeActionable) {
        return new Response(JSON.stringify({ data: { _root: { account: "account-1" }, account: { "account-1": { [key]: [] } } } }), { status: 200 });
      }
      const cardFields = (query._root as any)[0].account[0][key];
      const relationKey = Object.keys(cardFields.find((entry: any) => entry && typeof entry === "object" && Object.keys(entry)[0].startsWith("resolvables(")))[0];
      const resolvableFields = cardFields.find((entry: any) => entry && typeof entry === "object" && entry[relationKey])[relationKey];
      const entryKey = Object.keys(resolvableFields.find((entry: any) => entry && typeof entry === "object" && Object.keys(entry)[0].startsWith("entries(")))[0];
      return new Response(JSON.stringify({ data: {
        _root: { account: "account-1" }, account: { "account-1": { [key]: ["card-1"] } },
        card: { "card-1": { cardId: "card-1", accountSeq: 1, title: "Synthetic", status: "started", assignee: "user-1", [relationKey]: ["res-1"] } },
        resolvable: { "res-1": { id: "res-1", context: "comments", isClosed: false, [entryKey]: ["entry-1"] } },
        resolvableEntry: { "entry-1": { entryId: "entry-1", author: "user-2", createdAt: "2026-09-28T00:00:00Z", content: "Synthetic message" } },
        user: { "user-1": { id: "user-1", name: "Synthetic" }, "user-2": { id: "user-2", name: "Other" } },
      } }), { status: 200 });
    }
    const entries = (query._root as any)[0].loggedInUser;
    const key = entries.find((entry: unknown) => typeof entry === "object" && entry !== null);
    const relationKey = key && Object.keys(key)[0];
    return new Response(JSON.stringify({ data: {
      _root: { loggedInUser: "user-1" },
      user: { "user-1": { id: "user-1", name: "Synthetic", ...(relationKey ? { [relationKey]: [] } : {}) } },
    } }), { status: 200 });
  }) as typeof fetch;
  const response = String(await core.debug_logged_in_user_resolvables.execute({
    scanLimit: 1, probeRelations: ["participations", "profileImage"], probeFields: [], relationProbeLimit: 2, format: "json",
  }));
  const parsed = JSON.parse(response.match(/```json\s*([\s\S]*?)```/)![1]);
  assert.equal(parsed.ok, true);
  const probe = parsed.data.relationProbes.find((entry: any) => entry.relation === "profileImage");
  assert.equal(probe.ok, false);
  assert.match(probe.error, /Unsupported loggedInUser probe relation/);
  const serialized = JSON.stringify(queries);
  assert(!serialized.includes("profileImage"), "a single-row relation never receives collection pagination");
  assert.match(serialized, /participations\(/);
  assert.match(serialized, /\\"\$order\\":\\"-firstJoinedAt\\"/);
  assert.match(serialized, /\\"\$limit\\":2/);
  assert.equal(queries.length, 3, "identity, empty card scan, and one safe relation probe only");
  queries.length = 0;
  includeActionable = true;
  const participation = String(await core.debug_logged_in_user_resolvable_participation.execute({
    scanLimit: 1, probeResolvableRelations: ["participants", "card"], probeResolvableFields: [], relationProbeLimit: 2, format: "json",
  }));
  const participationResult = JSON.parse(participation.match(/```json\s*([\s\S]*?)```/)![1]);
  assert.equal(participationResult.ok, true);
  assert.equal(participationResult.data.sampleResolvableId, "res-1");
  const skipped = participationResult.data.resolvableRelationProbes.find((entry: any) => entry.relation === "card");
  assert.equal(skipped.ok, false);
  assert.match(skipped.error, /Unsupported resolvable probe relation/);
  const participationQueries = JSON.stringify(queries);
  assert(!participationQueries.includes('"card('), "single-row resolvable relations are not paginated");
  assert.match(participationQueries, /participants\(/);
  assert.match(participationQueries, /\\"\$order\\":\\"-firstJoinedAt\\"/);
  assert.match(participationQueries, /\\"\$limit\\":2/);
  assert.equal(queries.length, 3, "identity, bounded scan, and one ordered resolvable relation query only");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [["CODECKS_PROFILE", priorProfile], ["CODECKS_PROFILE_PERSONAL_TOKEN", priorToken], ["CODECKS_ACCOUNT", priorAccount], ["CODECKS_CREDENTIAL_PROVIDER", priorProvider]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

console.log("PASS: Codecks debug dynamic registration and ordered relation probes passed");
