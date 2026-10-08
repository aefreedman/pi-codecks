import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import * as core from "../src/codecks-core.ts";
import * as context from "../src/runtime/operation-context.ts";
import * as credentials from "../src/runtime/credentials.ts";
import * as pacing from "../src/runtime/pacing.ts";
import { runQuery } from "../src/runtime/transport.ts";
import { fetchCardByAccountSeq } from "../src/shared/card-queries.ts";
import { fetchAccountDecks } from "../src/shared/entity-resolution.ts";
import { fetchAccountRuns } from "../src/shared/runs.ts";
import { fetchDoneTransitionEvents, parseDoneTransitionFromDiff } from "../src/shared/done-transitions.ts";
import { normalizeCollection } from "../src/shared/query.ts";
import { validateMutationText } from "../src/shared/mutation-text.ts";
import * as common from "../src/contracts/common.ts";
import * as getOutput from "../src/card-get-output.ts";
import { CARD_SEARCH_OUTPUT_SCHEMA } from "../src/card-search-output.ts";
import { CODECKS_EXPORTS, DEFAULT_CODECKS_EXPORTS } from "../src/pi/tool-metadata.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { composeCodecksToolCatalog, type CodecksToolDefinition } from "../src/pi/tool-definition.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { PiToolHarness } from "./pi-tool-harness.ts";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Captured independently from 3e59ea8, not generated from the refactored catalog.
// Intentionally re-pinned after adding human-readable thread and Review formatting guidance.
assert.equal(hash(CODECKS_EXPORTS.map(name => {
  const config = getCodecksToolDefinition(name).config;
  return [name, config.parameters, config.promptSnippet, config.promptGuidelines];
})),  "ba28932de4cd3d86cdc98c04ab81ceae3fd206eed9ae4d700d2123eae838130b");
assert.equal(hash(getOutput.CARD_GET_OUTPUT_SCHEMA), "cba7b98f84efc597635e17da6c7ed0e7942360131543cb197a361db5ef2bbf37");
assert.equal(hash(CARD_SEARCH_OUTPUT_SCHEMA), "c53a26fbba4ac9dcd8e718301ed4547c8d4ac398376c36ed7d2d62a7cf92fe71");
assert.strictEqual(core.runWithAbortSignal, context.runWithAbortSignal);
assert.strictEqual(core.__test.getBaseConfig, credentials.getBaseConfig);
assert.strictEqual(core.__test.resetRateGate, pacing.resetRateGate);
assert.strictEqual(core.__test.seedRateGate, pacing.seedRateGate);
assert.strictEqual(core.__test.validateMutationText, validateMutationText);
assert.strictEqual(getOutput.projectBoundedValue, common.projectBoundedValue);
assert.strictEqual(getOutput.CODECKS_READ_ERROR_CODES, common.CODECKS_READ_ERROR_CODES);
assert.strictEqual((await import("../src/runtime/pacing.ts")).withAccountScanSlot, pacing.withAccountScanSlot);
for (const name of CODECKS_EXPORTS) {
  assert.strictEqual(getCodecksToolDefinition(name).tool, core[name], `${name}: catalog must use the canonical facade tool`);
}
const state = { complete: true };
const projection = common.projectBoundedValue(Type.Object({ absent: Type.Optional(Type.String()), zero: Type.Number(), no: Type.Boolean(), nil: Type.Null(), text: Type.String({ maxLength: 1 }) }), { zero: 0, no: false, nil: null, text: "😀x", secret: "never emitted" }, state);
assert.deepEqual(projection, { zero: 0, no: false, nil: null, text: "😀" });
assert.equal(state.complete, false);
assert.deepEqual(normalizeCollection(undefined), []);
assert.deepEqual(normalizeCollection(false), [], "legacy collection normalization is unchanged");
assert.deepEqual(parseDoneTransitionFromDiff({ status: ["in_progress", "done"] }), { fromStatus: "in_progress", toStatus: "done" });
assert.equal(parseDoneTransitionFromDiff({ status: ["done", "done"] }), null);
assert.equal(validateMutationText([["content", "😀 valid"]]).length, 0);
assert.equal(validateMutationText([["content", "\ud800"]]).length, 1);

const originalFetch = globalThis.fetch;
const originalAccount = process.env.CODECKS_ACCOUNT;
const originalProfile = process.env.CODECKS_PROFILE;
const originalPersonalAccount = process.env.CODECKS_PROFILE_PERSONAL_ACCOUNT;
process.env.CODECKS_ACCOUNT = "synthetic-foundation";
delete process.env.CODECKS_PROFILE_PERSONAL_ACCOUNT;
process.env.CODECKS_PROFILE = "ORG";
let resolutions = 0;
const sent: string[] = [];
core.__test.setCredentialProviderForTests({ id: "foundation-synthetic", async resolve(request) {
  resolutions++;
  await Promise.resolve();
  return { token: request.profileKey === "PERSONAL" ? "cdxut_synthetic_foundation" : "cdxat_synthetic_foundation", providerId: "foundation-synthetic" };
} });
globalThis.fetch = async (_url, init) => {
  sent.push(String((init?.headers as Record<string, string>).Authorization).match(/cdx(?:at|ut)_synthetic_foundation/)?.[0] ?? "missing synthetic authorization");
  const q = JSON.parse(String(init?.body)).query;
  assert.ok(q, "only fake local query transport is allowed");
  return new Response(JSON.stringify({ data: { _root: { account: { id: "account", sprintsEnabled: true, cards: [{ cardId: "card", accountSeq: 123, title: "Card" }], decks: [{ id: "deck", title: "Deck" }], sprints: [{ id: "run", accountSeq: 1, name: "Run" }], activities: [] } } } }));
};
try {
  pacing.resetRateGate();
  const signals = [new AbortController().signal, new AbortController().signal];
  const contexts = await Promise.all(["ORG", "PERSONAL"].map((profile, index) => core.runWithAbortSignal(signals[index], async () => {
    const outer = context.getOperationContext()!;
    assert.equal(outer.profileKey, profile);
    assert.equal(context.getActiveWorkspaceRoot(), `workspace-${index}`);
    assert.strictEqual(context.getActiveAbortSignal(), signals[index]);
    const first = credentials.getAuthenticatedConfig();
    assert.strictEqual(first, credentials.getAuthenticatedConfig(), "one credential promise per operation");
    assert.equal((await first).kind, profile);
    await context.withOperationContextIfMissing(async () => assert.strictEqual(context.getOperationContext(), outer));
    await context.runWithAbortSignal(undefined, async () => {
      assert.notStrictEqual(context.getOperationContext(), outer);
      assert.equal(context.getOperationContext()?.profileKey, "ORG");
      assert.equal(context.getActiveAbortSignal(), undefined);
    }, "nested", undefined, "ORG");
    assert.strictEqual(context.getOperationContext(), outer);
    await runQuery({ _root: [{ account: ["id"] }] });
    assert.equal(outer.requestsAttempted, 1);
    assert.equal(outer.requestsDispatched, 1);
    return outer;
  }, `workspace-${index}`, undefined, profile)));
  assert.notStrictEqual(contexts[0], contexts[1]);
  assert.equal(resolutions, 2);
  assert.equal(context.getOperationContext(), undefined);
  assert.deepEqual(sent.sort(), ["cdxat_synthetic_foundation", "cdxut_synthetic_foundation"]);
  await context.runWithAbortSignal(undefined, async () => {
    assert.equal((await fetchCardByAccountSeq(123))?.cardId, "card");
    assert.equal((await fetchAccountDecks())[0]?.id, "deck");
    assert.equal((await fetchAccountRuns())[0]?.id, "run");
    assert.deepEqual(await fetchDoneTransitionEvents({ sinceIso: "2026-01-01T00:00:00Z", until: new Date("2026-02-01"), scanLimit: 50, pageSize: 25 }), { events: [], scannedActivities: 0, scanLimitReached: false });
    assert.equal(context.getOperationContext()?.requestsAttempted, 4);
  });
  assert.equal(resolutions, 3, "different shared query families reuse the operation credential");
  assert.equal(core.__test.getRateGateState().timestamps.length, 6, "facade and all extracted queries share one physical gate");
  core.__test.seedRateGate([Date.now() - 6000]);
  await pacing.enforceRateLimit();
  assert.equal(core.__test.getRateGateState().timestamps.length, 1);
  core.__test.observeServerCooldown(new Response("", { status: 429, headers: { "Retry-After": "1" } }));
  assert.ok(pacing.getRateGateState().cooldownUntil > 0);
  pacing.resetRateGate();
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(context.runWithAbortSignal(aborted.signal, () => runQuery({})), (error: any) => error.category === "caller_aborted");
  assert.equal(sent.length, 6, "aborted operation never dispatches");
  // Two held scan slots, bounded shared queue, cancellation removes its waiter.
  await pacing.acquireAccountScanSlot(); await pacing.acquireAccountScanSlot();
  const controller = new AbortController();
  const pending = context.runWithAbortSignal(controller.signal, () => pacing.acquireAccountScanSlot());
  controller.abort();
  await assert.rejects(pending, (error: any) => error.category === "caller_aborted");
  const queued = Array.from({ length: 8 }, () => pacing.acquireAccountScanSlot());
  await assert.rejects(pacing.acquireAccountScanSlot(), (error: any) => error.category === "scan_queue_full");
  pacing.releaseAccountScanSlot(); pacing.releaseAccountScanSlot();
  for (const waiter of queued) { await waiter; pacing.releaseAccountScanSlot(); }
  await pacing.withAccountScanSlot(async () => {});
} finally {
  globalThis.fetch = originalFetch;
  core.__test.setCredentialProviderForTests();
  pacing.resetRateGate();
  for (const [name, value] of [["CODECKS_ACCOUNT", originalAccount], ["CODECKS_PROFILE", originalProfile], ["CODECKS_PROFILE_PERSONAL_ACCOUNT", originalPersonalAccount]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

const harness = new PiToolHarness(); await harness.load();
assert.deepEqual([...harness.registry.keys()], [...DEFAULT_CODECKS_EXPORTS.map(name => `codecks_${name}`), "codecks_profile_select", "codecks_tool_search"]);
for (const name of CODECKS_EXPORTS) assert.strictEqual(getCodecksToolDefinition(name).tool, (core as any)[name]);
const contributed: CodecksToolDefinition = { exportName: "synthetic", tool: { execute: () => { throw Error("native read must win"); } }, config: { parameters: Type.Object({}) }, read: async args => {
  assert.deepEqual(args, { format: "json" });
  assert.equal(context.getOperationContext()?.profileKey, "PERSONAL");
  return { text: "legacy", payload: { ok: false, error: { code: "api_error", message: "Synthetic failure" } } };
}, outputSchema: Type.Object({ ok: Type.Boolean() }), projectOutput: payload => payload as Record<string, any> };
assert.strictEqual(composeCodecksToolCatalog([contributed]).get("synthetic"), contributed);
assert.throws(() => composeCodecksToolCatalog([contributed], [contributed]), /Duplicate/);
registerCodecksTool(harness.api as any, contributed, "Synthetic", false, () => "PERSONAL");
const result = await harness.registry.get("codecks_synthetic")!.execute("test", { format: "json" }, undefined, undefined, { cwd: "synthetic-workspace" });
assert.deepEqual(result.structuredContent, { ok: false, error: { code: "api_error", message: "Synthetic failure" } }); assert.equal(result.isError, true); assert.equal(result.content[0].text, "legacy");
assert.strictEqual((harness.registry.get("codecks_synthetic") as any).outputSchema, contributed.outputSchema);

// Supplemental architecture guard: all new shared/runtime modules are acyclic,
// and neither has a dependency on the retained facade or a domain implementation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const graph = new Map<string, string[]>();
for (const folder of ["runtime", "shared", "contracts"]) for (const name of readdirSync(resolve(root, "src", folder))) {
  if (!name.endsWith(".ts")) continue;
  const file = resolve(root, "src", folder, name), text = readFileSync(file, "utf8");
  const imports = [...text.matchAll(/from "(\.[^"]+)"/g)].map(m => resolve(dirname(file), `${m[1]}.ts`));
  assert.ok(imports.every(path => !/[/\\](?:tools|pi)[/\\]|[/\\]codecks-core\.ts$/.test(path)), `${file} must not depend on domains, Pi, or facade`);
  graph.set(file, imports);
}
const visit = (file: string, stack: string[]) => {
  assert.ok(!stack.includes(file), `cycle: ${[...stack, file].join(" -> ")}`);
  for (const next of graph.get(file) ?? []) visit(next, [...stack, file]);
};
for (const file of graph.keys()) visit(file, []);
console.log("Foundation seams: baseline schemas, canonical imports/state, ALS isolation, shared queries, cancellation, scan queue, independent domain registration and acyclic boundaries passed.");
