import assert from "node:assert/strict";
import { assertContractIdentity } from "./structured-contract-inventory.ts";
import * as originals from "../src/codecks-core.ts";
import * as reads from "../src/tools/entities/reads.ts";
import * as writes from "../src/tools/entities/writes.ts";
import { ENTITY_TOOL_DEFINITIONS } from "../src/tools/entities/definitions.ts";
import { composeCodecksToolCatalog } from "../src/pi/tool-definition.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { runWithAbortSignal, getOperationContext } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
type RecordData = Record<string, any>;
const moved = { ...reads, ...writes };
const deckId = "55555555-5555-4555-8555-555555555555";
const milestoneId = "44444444-4444-4444-8444-444444444444";
const runId = "22222222-2222-4222-8222-222222222222";
const entities = {
  decks: [{ id: deckId, accountSeq: 12, title: "Development", description: "Deck body", isDeleted: false, status: null }],
  milestones: [{ id: milestoneId, accountSeq: 84, name: "Alpha", description: "Milestone body", startDate: null, color: "green", isGlobal: true, handSyncEnabled: false, isDeleted: false }],
  sprints: [{ id: runId, accountSeq: 91, name: "Current Run", description: "Run body", startDate: "2026-05-11", endDate: "2026-05-24", isDeleted: false, completedAt: null, lockedAt: null }],
};
type Mode = "normal" | "missing" | "ambiguous" | "forbidden" | "dispatch-failure";
const originalFetch = globalThis.fetch;
let comparisons = 0;

function fixture(query: RecordData, mode: Mode, overrides: RecordData) {
  const accountEntries = query._root?.[0]?.account ?? [];
  const relation = accountEntries.flatMap((entry: any) => typeof entry === "object" ? Object.keys(entry) : []).find((key: string) => /^(decks|milestones|sprints|cards)(\(|$)/.test(key));
  assert.ok(relation, `Unexpected query: ${JSON.stringify(query)}`);
  const family = relation.split("(")[0] as keyof typeof entities;
  if (family === ("cards" as any)) return { data: { user: { first: { id: "user-1", name: "Aaron", fullName: "Aaron Example" }, duplicate: { id: "user-1", name: "Aaron" }, empty: { name: "Aaron" } } } };
  let records = mode === "missing" ? [] : entities[family].map(entity => ({ ...entity, ...overrides }));
  if (mode === "ambiguous") records = [...records, { ...records[0], id: "66666666-6666-4666-8666-666666666666", accountSeq: 13 }];
  const model = { decks: "deck", milestones: "milestone", sprints: "sprint" }[family];
  return { data: { _root: { account: "account-test" }, account: { "account-test": { id: "account-test", sprintsEnabled: true, [relation]: records.map(record => record.id) } }, [model]: Object.fromEntries(records.map(record => [record.id, record])) } };
}
const normalize = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === "sessionId" ? "<session>" : item));
async function invoke(tool: any, args: RecordData, mode: Mode, overrides: RecordData, native: boolean) {
  resetRateGate();
  const requests: RecordData[] = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const path = String(url).match(/\/dispatch\/(.+)$/)?.[1] ?? "query";
    if (body.sessionId) assert.match(body.sessionId, /^[0-9a-f-]{36}$/i);
    requests.push(normalize({ path, body }));
    const status = mode === "forbidden" ? 403 : mode === "dispatch-failure" && path !== "query" ? 400 : 200;
    const payload = status !== 200 ? { error: "Synthetic forbidden or rejected request" } : path === "query" ? fixture(body.query, mode, overrides) : { payload: {} };
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  };
  let result: unknown;
  let counts: unknown;
  if (native) result = await tool.execute("synthetic", args, undefined, undefined, { cwd: process.cwd() });
  else result = await runWithAbortSignal(undefined, async () => {
    try { return await tool.execute(args); }
    finally { counts = { attempted: getOperationContext()?.requestsAttempted, dispatched: getOperationContext()?.requestsDispatched }; }
  }, process.cwd(), undefined, "PERSONAL");
  return { result, requests, counts };
}
const registrations = new Map<string, any>();
const nativeOriginals = new Map<string, any>();
function register(definition: any, registry: Map<string, any>) {
  registerCodecksTool({ registerTool: (tool: any) => registry.set(tool.name, tool) } as any, definition, definition.tool.description, true, () => "PERSONAL");
}
const catalog = composeCodecksToolCatalog(ENTITY_TOOL_DEFINITIONS);
assert.deepEqual([...catalog.keys()], ["deck_get", "deck_update", "milestone_list", "milestone_get", "milestone_update", "run_list", "run_get", "run_update", "user_lookup"]);
assert.throws(() => composeCodecksToolCatalog(ENTITY_TOOL_DEFINITIONS, ENTITY_TOOL_DEFINITIONS), /Duplicate/);
for (const definition of ENTITY_TOOL_DEFINITIONS) {
  const original = getCodecksToolDefinition(definition.exportName);
  assert.strictEqual(definition.tool, moved[definition.exportName]);
  assert.equal(definition.tool.description, original.tool.description);
  assert.deepEqual(definition.config.parameters, original.config.parameters);
  assert.deepEqual(definition.config.promptSnippet, original.config.promptSnippet);
  assert.deepEqual(definition.config.promptGuidelines, original.config.promptGuidelines);
  await assertContractIdentity(definition);
  const aliases = { id: 12, deck_id: 12, milestone_id: 84, run_id: 91, output_format: "json", clear_description: true };
  assert.deepEqual(definition.config.prepareArguments?.(aliases), original.config.prepareArguments?.(aliases));
  register(definition, registrations);
  register(original, nativeOriginals);
  assert.deepEqual(registrations.get(`codecks_${definition.exportName}`).parameters, nativeOriginals.get(`codecks_${definition.exportName}`).parameters);
}
assert.deepEqual(ENTITY_TOOL_DEFINITIONS.find(entry => entry.exportName === "user_lookup")!.config, {});

async function compare(name: keyof typeof moved, args: RecordData, mode: Mode = "normal", overrides: RecordData = {}, native = false) {
  const candidate = native ? registrations.get(`codecks_${name}`) : moved[name];
  const baseline = native ? nativeOriginals.get(`codecks_${name}`) : originals[name];
  const actual = await invoke(candidate, args, mode, overrides, native);
  const expected = await invoke(baseline, args, mode, overrides, native);
  assert.deepEqual(actual, expected, `${name}: ${mode}, native=${native}`);
  comparisons++;
  return actual;
}
const parse = (value: unknown) => JSON.parse(String(value).match(/```json\s*([\s\S]*)\s*```/)![1]);
try {
  const targets: Record<string, RecordData> = {
    deck_get: { deckId: 12 }, deck_update: { deckId: 12, description: "Changed" },
    milestone_list: { search: "alpha" }, milestone_get: { milestoneId: 84 }, milestone_update: { milestoneId: 84, description: "Changed" },
    run_list: { title: "Current" }, run_get: { runId: 91 }, run_update: { runId: 91, customLabel: "Changed", description: "Changed" }, user_lookup: { name: "aaron" },
  };
  for (const name of Object.keys(targets) as (keyof typeof moved)[]) {
    for (const format of ["text", "json"]) await compare(name, { ...targets[name], format });
    const native = await compare(name, { ...targets[name], format: "json" }, "normal", {}, true);
    assert.ok((native.result as any).content[0].text);
    if (name !== "user_lookup") {
      const forbidden = await compare(name, { ...targets[name], format: "json" }, "forbidden", {}, true);
      assert.equal(parse((forbidden.result as any).details.rawResult).ok, false);
      assert.equal((forbidden.result as any).structuredContent.ok, false);
      assert.equal((forbidden.result as any).isError, true);
    }
  }
  for (const name of ["deck_get", "milestone_get", "run_get", "deck_update", "milestone_update", "run_update"] as const) {
    const missing = await compare(name, { ...targets[name], format: "json" }, "missing");
    assert.equal(parse(missing.result).error.category, "not_found");
    assert.equal(missing.requests.filter(request => request.path !== "query").length, 0);
  }
  for (const [name, args] of [["deck_get", { title: "Development" }], ["deck_update", { deckId: "Development", description: "Body" }], ["milestone_get", { title: "Alpha" }], ["milestone_update", { milestoneId: "Alpha", description: "Body" }]] as const) {
    const ambiguous = await compare(name, { ...args, format: "json" }, "ambiguous");
    assert.equal(parse(ambiguous.result).error.category, "ambiguous_match");
    assert.ok(ambiguous.requests.every(request => request.path === "query"));
  }
  for (const [name, target] of [["deck_update", { deckId: 12 }], ["milestone_update", { milestoneId: 84 }]] as const) {
    for (const description of [undefined, null, false, 0]) {
      const rejected = await compare(name, { ...target, description, format: "json" });
      assert.equal(parse(rejected.result).error.category, "validation_error");
      assert.equal(rejected.requests.length, 0);
    }
    for (const clearArgs of [{ clearDescription: true }, { description: "" }]) {
      const cleared = await compare(name, { ...target, ...clearArgs, format: "json" });
      assert.deepEqual(cleared.requests.at(-1)?.body, { id: name === "deck_update" ? deckId : milestoneId, description: "" });
      assert.equal(parse(cleared.result).data.descriptionCleared, true);
    }
    await compare(name, { ...target, description: "Body", format: "json" }, "dispatch-failure");
  }
  const clearedRun = await compare("run_update", { runId: 91, clearCustomLabel: true, description: "", format: "json" });
  assert.deepEqual(clearedRun.requests.at(-1)?.body, { id: runId, sessionId: "<session>", name: null, description: "" });
  for (const value of [undefined, null, false, 0]) {
    await compare("deck_get", { deckId: 12, format: "json" }, "normal", { description: value, isDeleted: value, status: value });
    const milestone = await compare("milestone_get", { milestoneId: 84, format: "json" }, "normal", { description: value, date: value, handSyncEnabled: value });
    const summary = parse(milestone.result).data.milestone;
    assert.equal(summary.description, value ?? null);
    assert.equal(summary.handSyncEnabled, value ?? null);
    await compare("run_get", { runId: 91, format: "json" }, "normal", { completedAt: value, lockedAt: value, description: value });
  }
  for (const name of ["deck_get", "milestone_get", "run_get"] as const) {
    const validation = await compare(name, { format: "json" }, "normal", {}, true);
    assert.equal(parse((validation.result as any).details.rawResult).ok, false);
    assert.equal((validation.result as any).structuredContent.ok, false);
    assert.equal((validation.result as any).isError, true);
    assert.equal(validation.requests.length, 0);
  }
  await compare("milestone_get", { milestoneId: 84, format: "json" }, "normal", { isDeleted: true });
  await compare("milestone_get", { milestoneId: 84, includeDeleted: true, format: "json" }, "normal", { isDeleted: true });
  await compare("user_lookup", { name: "" });
  await compare("user_lookup", { name: "nobody" });
  console.log(`Entities extraction passed: ${comparisons} direct/original comparisons, nine definitions and independent registrations.`);
} finally {
  globalThis.fetch = originalFetch;
  resetRateGate();
}
