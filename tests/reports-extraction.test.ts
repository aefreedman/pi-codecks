import assert from "node:assert/strict";
import { assertContractIdentity } from "./structured-contract-inventory.ts";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as originals from "../src/codecks-core.ts";
import * as moved from "../src/tools/reports/tools.ts";
import { REPORT_TOOL_DEFINITIONS } from "../src/tools/reports/definitions.ts";
import { composeCodecksToolCatalog } from "../src/pi/tool-definition.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { getOperationContext, runWithAbortSignal } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { setCredentialProviderForTests } from "../src/runtime/credentials.ts";
import { observationCache, runObservation } from "./velocity-fixtures.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
process.env.CODECKS_ACCOUNT = "example";
process.env.CODECKS_API_BASE = "https://api.codecks.io";
const previousFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), "pi-codecks-reports-extraction-"));
const actualRoot = join(root, "actual");
const expectedRoot = join(root, "expected");
type Name = keyof typeof moved;
type Data = Record<string, any>;
type Mode = "normal" | "forbidden" | "disabled" | "ambiguous" | "missing";
const names: Name[] = ["velocity_observations_update", "velocity_report", "run_delivered_effort", "run_average_effort"];
const nativeMoved = new Map<string, any>();
const nativeOriginal = new Map<string, any>();
const catalog = composeCodecksToolCatalog(REPORT_TOOL_DEFINITIONS);
assert.deepEqual([...catalog.keys()], names);
assert.throws(() => composeCodecksToolCatalog(REPORT_TOOL_DEFINITIONS, REPORT_TOOL_DEFINITIONS), /Duplicate/);
for (const definition of REPORT_TOOL_DEFINITIONS) {
  const original = getCodecksToolDefinition(definition.exportName);
  assert.strictEqual(definition.tool, moved[definition.exportName as Name]);
  assert.equal(definition.tool.description, original.tool.description);
  assert.deepEqual(definition.config.parameters, original.config.parameters);
  assert.deepEqual(definition.config.promptSnippet, original.config.promptSnippet);
  assert.deepEqual(definition.config.promptGuidelines, original.config.promptGuidelines);
  await assertContractIdentity(definition);
  assert.equal(definition.cardTextPresentation, undefined);
  const aliases = { output_format: "json", observations_path: "cache.json", refresh_mode: "full", overlap_days: 0, completed_runs: 3, sprint_config: "Delivery", include_current_stats: false, min_delivered_effort: 0, include_filtered_runs: false, exclude_labels: [], csv_path: "report.csv" };
  assert.deepEqual(definition.config.prepareArguments?.(aliases), original.config.prepareArguments?.(aliases));
  for (const [entry, registry] of [[definition, nativeMoved], [original, nativeOriginal]] as const) {
    registerCodecksTool({ registerTool: (tool: any) => registry.set(tool.name, tool) } as any, entry, entry.tool.description, true, () => "PERSONAL");
  }
  const actual = nativeMoved.get(`codecks_${definition.exportName}`);
  const expected = nativeOriginal.get(`codecks_${definition.exportName}`);
  assert.deepEqual(actual.parameters, expected.parameters);
  assert.deepEqual(actual.promptGuidelines, expected.promptGuidelines);
  assert.strictEqual(actual.outputSchema, definition.outputSchema);
}
const runs = [
  { id: "run-one", accountSeq: 1, startDate: "2026-02-02", endDate: "2026-02-08", completedAt: "2026-02-09T00:00:00Z", sprintConfig: { id: "config-a", name: "Delivery" }, stats: { finishStats: { progress: { done: [2, 10, 1] }, assignee: { "user-a": { done: { count: 1, effort: 6, noEffort: 0 } } } }, progress: { done: [3, 20, 0] } } },
  { id: "run-zero", accountSeq: 2, startDate: "2026-02-09", endDate: "2026-02-15", completedAt: "2026-02-16T00:00:00Z", sprintConfig: { id: "config-b", name: "Other" }, stats: { finishStats: { progress: { done: [1, 0, 1] } } } },
  { id: "run-missing", accountSeq: 3, startDate: "2026-02-16", endDate: "2026-02-22", completedAt: "2026-02-23T00:00:00Z", stats: { finishStats: null } },
  { id: "run-deleted", accountSeq: 4, isDeleted: true, completedAt: "2026-02-24T00:00:00Z" },
  { id: "run-incomplete", accountSeq: 5, completedAt: null },
];
const activities = [0, null, false, undefined].map((effort, index) => ({
  id: `activity-${index}`, createdAt: "2026-02-03T12:00:00Z", data: { diff: { status: ["started", "done"] } },
  card: { cardId: `card-${index}`, accountSeq: 101 + index, title: "Synthetic card", ...(effort !== undefined ? { effort } : {}), status: "done", deck: { id: "deck-main", title: "Main" } },
}));
function fixture(query: Data, mode: Mode) {
  const accountEntries = query._root?.[0]?.account ?? [];
  const relation = accountEntries.flatMap((entry: any) => typeof entry === "object" ? Object.keys(entry) : []).find((key: string) => /^(sprints|activities|cards)(\(|$)/.test(key));
  assert.ok(relation, `Unexpected request: ${JSON.stringify(query)}`);
  if (relation.startsWith("cards")) return { data: { user: mode === "missing" ? {} : { a: { id: "user-a", name: "Alex" }, ...(mode === "ambiguous" ? { b: { id: "user-b", name: "Alex" } } : {}) } } };
  return { data: { _root: { account: "account-test" }, account: { "account-test": { id: "account-test", sprintsEnabled: mode !== "disabled", [relation]: relation === "sprints" ? runs : activities } } } };
}
// Only caller-root differences and wall-clock cache refresh provenance are normalized.
function normalize(value: any): any {
  if (typeof value === "string") return value.split(actualRoot).join("<workspace>").split(expectedRoot).join("<workspace>").split(JSON.stringify(actualRoot).slice(1, -1)).join("<workspace>").split(JSON.stringify(expectedRoot).slice(1, -1)).join("<workspace>").replace(/("(?:createdAt|lastRefreshAt)"\s*:\s*")[^"]+/g, "$1<refresh-time>");
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return value;
}
function parse(value: unknown): Data {
  return JSON.parse(String(value).match(/```json\s*([\s\S]*)\s*```/)![1]);
}
async function invoke(name: Name, args: Data, workspace: string, candidate: boolean, mode: Mode, native: boolean) {
  resetRateGate();
  const requests: unknown[] = [];
  let credentialResolutions = 0;
  setCredentialProviderForTests({ id: "synthetic-reports", resolve: async () => {
    credentialResolutions++;
    return { token: "cdxut_synthetic-reports-token", providerId: "synthetic-reports" };
  } });
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.method, "POST");
    assert.ok(!String(url).includes("dispatch"), "Reports must never write Codecks");
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), body });
    return new Response(JSON.stringify(mode === "forbidden" ? { error: "Synthetic forbidden" } : fixture(body.query, mode)), { status: mode === "forbidden" ? 403 : 200, headers: { "Content-Type": "application/json" } });
  };
  let counts: unknown;
  const result = native
    ? await (candidate ? nativeMoved : nativeOriginal).get(`codecks_${name}`).execute("synthetic", args, undefined, undefined, { cwd: workspace })
    : await runWithAbortSignal(undefined, async () => {
      try { return await (candidate ? moved : originals)[name].execute(args); }
      finally { counts = { attempted: getOperationContext()?.requestsAttempted, dispatched: getOperationContext()?.requestsDispatched }; }
    }, workspace, undefined, "PERSONAL");
  const files: Data = {};
  for (const file of await readdir(workspace)) {
    if (/\.(?:json|csv|md)$/.test(file)) files[file] = await readFile(join(workspace, file), "utf8");
  }
  if (name === "velocity_report") assert.equal(credentialResolutions, 0, "Offline reports must not resolve credentials");
  return { result, requests, counts, credentialResolutions, files };
}
let comparisons = 0;
async function compare(name: Name, args: Data, mode: Mode = "normal", native = false) {
  const actual = await invoke(name, args, actualRoot, true, mode, native);
  const expected = await invoke(name, args, expectedRoot, false, mode, native);
  assert.deepEqual(normalize(actual), normalize(expected), `${name}: ${mode}, native=${native}`);
  comparisons++;
  return { ...actual, payload: args.format === "json" ? parse(native ? (actual.result as any).details.rawResult : actual.result) : undefined };
}
try {
  for (const workspace of [actualRoot, expectedRoot]) {
    await mkdir(workspace);
    const cache = observationCache();
    (cache.organization as any).profile = "PERSONAL";
    cache.runs.mixed = runObservation({ key: "mixed", runId: "mixed", configuration: { id: "config-b", name: "Other", color: null } });
    await writeFile(join(workspace, "cache.json"), JSON.stringify(cache));
    await writeFile(join(workspace, "wrong-account.json"), JSON.stringify({ ...cache, organization: { ...cache.organization, account: "other" } }));
    await mkdir(join(workspace, "alias-target"));
    await symlink(workspace, join(workspace, "alias-target", "link"), process.platform === "win32" ? "junction" : "dir");
  }
  for (const format of ["text", "json"]) {
    for (const name of names) {
      const args = name === "velocity_report" ? { observationsPath: "cache.json", csvPath: "report.csv", summaryMarkdownPath: "report.md", excludeDecks: ["deck-main"], excludeLabels: [], additionalExcludeLabels: ["vacation"], format }
        : name === "velocity_observations_update" ? { observationsPath: `refresh-${format}.json`, refreshMode: "full", fromDate: "2026-02-02", toDate: "2026-03-01", overlapDays: 0, format }
        : { completedRuns: 4, includeCurrentStats: true, minDeliveredEffort: 0, format };
      const result = await compare(name, args);
      if (name === "velocity_report") assert.equal(result.requests.length, 0, "Offline reports never fetch or resolve credentials");
      if (name === "velocity_observations_update") {
        assert.equal(result.requests.length, 2);
        const cache = JSON.parse(result.files[`refresh-${format}.json`]);
        assert.equal(cache.refresh.overlapDays, 0);
        assert.equal(Object.keys(cache.runs).length, 3);
        assert.deepEqual(Object.values(cache.deliveredCards).map((card: any) => card.effort), [0, null, null, null]);
        assert.deepEqual(Object.values(cache.runs).map((run: any) => run.runWide.effort), [10, 0, null]);
      }
    }
  }
  for (const name of names) {
    const args = name === "velocity_report" ? { observationsPath: "cache.json", format: "json" }
      : name === "velocity_observations_update" ? { observationsPath: "native.json", refreshMode: "full", fromDate: "2026-02-02", toDate: "2026-03-01", format: "json" }
      : { format: "json" };
    const native = await compare(name, args, "normal", true);
    assert.equal((native.result as any).structuredContent.ok, true, "Native success DTO");
    assert.equal((native.result as any).isError, false);
    if (name !== "velocity_report") {
      const failure = await compare(name, { ...args, observationsPath: "forbidden.json" }, "forbidden", true);
      assert.equal(failure.payload!.ok, false);
      assert.equal((failure.result as any).structuredContent.ok, false);
      assert.equal((failure.result as any).isError, true);
    }
  }
  for (const name of ["run_delivered_effort", "run_average_effort"] as const) {
    await compare(name, { user: "Alex", format: "json" }, "ambiguous");
    await compare(name, { user: "Nobody", format: "json" }, "missing");
    await compare(name, { format: "json" }, "disabled");
    const filtered = await compare(name, { sprintConfig: "Delivery", includeFilteredRuns: false, format: "json" });
    assert.equal(filtered.payload!.data.matchedCompletedRuns, 1);
  }
  const effort = await compare("run_delivered_effort", { includeCurrentStats: true, format: "json" });
  assert.deepEqual(effort.payload!.data.totals, { count: 3, effort: 10, noEffort: 2 });
  assert(effort.payload!.warnings.some((warning: string) => warning.includes("missing stats.finishStats")));
  const average = await compare("run_average_effort", { format: "json" });
  assert.equal(average.payload!.data.averageEffort, 10);
  assert.equal(average.payload!.data.filteredRunCount, 2);
  const userScoped = await compare("run_delivered_effort", { user: "11111111-1111-4111-8111-111111111111", format: "json" });
  assert.deepEqual(userScoped.payload!.data.totals, { count: 0, effort: 0, noEffort: 0 });
  assert.equal(userScoped.requests.length, 1, "UUID user scope avoids cosmetic user queries");
  const windowed = await compare("velocity_observations_update", { observationsPath: "windowed.json", refreshMode: "date_window", fromDate: "2026-02-02", toDate: "2026-03-01", overlapDays: 10, format: "json" });
  assert.equal(windowed.payload!.data.cache.refresh.mode, "full", "Preserve visibility-safe effective full refresh");
  assert.equal(windowed.payload!.data.cache.refresh.overlapDays, 10);
  const incremental = await compare("velocity_observations_update", { observationsPath: "refresh-json.json", overlapDays: 10, format: "json" });
  assert.equal(incremental.requests.length, 0);
  assert.match(incremental.payload!.error.message, /visibility.*full refresh/);
  for (const args of [{ observationsPath: "" }, { refreshMode: "date_window" }, { refreshMode: "invalid" }, { fromDate: "2026-02-30" }, { observationsPath: "../outside.json" }]) {
    const failure = await compare("velocity_observations_update", { observationsPath: "invalid.json", ...args, format: "json" });
    assert.equal(failure.payload!.ok, false);
  }
  for (const args of [{}, { observationsPath: "wrong-account.json" }, { observationsPath: "../outside.json" }, { observationsPath: "cache.json", csvPath: "cache.json" }, { observationsPath: "cache.json", csvPath: "alias-target/link/cache.json" }, { observationsPath: "cache.json", measure: "run_attributed", excludeDecks: ["deck-main"] }]) {
    const failure = await compare("velocity_report", { ...args, format: "json" });
    assert.equal(failure.payload!.ok, false);
    assert.equal(failure.requests.length, 0);
  }
  const csv = await readFile(join(actualRoot, "report.csv"), "utf8");
  const markdown = await readFile(join(actualRoot, "report.md"), "utf8");
  assert.match(csv, /raw_delivered_card/);
  assert.match(markdown, /## Transformations/);
  assert(!(await readdir(actualRoot)).some(file => /\.tmp/.test(file)), "Atomic writes leave no scratch files");
} finally {
  globalThis.fetch = previousFetch;
  setCredentialProviderForTests();
  resetRateGate();
  await rm(root, { recursive: true, force: true });
}
console.log(`reports extraction tests passed (${comparisons} direct/original comparisons; four independent definitions)`);
