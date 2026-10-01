import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as originals from "../src/codecks-core.ts";
import * as reads from "../src/tools/cards/reads.ts";
import * as writes from "../src/tools/cards/writes.ts";
import * as bulk from "../src/tools/cards/bulk.ts";
import { CARD_TOOL_DEFINITIONS } from "../src/tools/cards/definitions.ts";
import { composeCodecksToolCatalog } from "../src/pi/tool-definition.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { runWithAbortSignal, getOperationContext } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { snapshotAttachmentSource, assertUnchangedAttachmentSource } from "../src/tools/cards/helpers.ts";
import { projectCardGetOutput } from "../src/card-get-output.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
const moved = { ...reads, ...writes, ...bulk };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = await mkdtemp(join(tmpdir(), "pi-codecks-cards-extraction-"));
const originalFetch = globalThis.fetch;
const temporaryEnvironment = new Map(["TEMP", "TMP", "TMPDIR"].map(key => [key, process.env[key]]));
for (const key of temporaryEnvironment.keys()) process.env[key] = scratch;
const userId = "33333333-3333-4333-8333-333333333333";
const cardId = "11111111-1111-4111-8111-111111111111";
const parse = (value: unknown) => JSON.parse(String(value).match(/```json\s*([\s\S]*?)\s*```/)![1]);
const normalize = (value: any, workspace: string): any => {
  if (typeof value === "string") return value.replace(/"(?:createdAt|generatedAt)": "[^"]+"/g, '"createdAt": "<timestamp>"').replace(/"(?:elapsedMs|totalDurationMs|durationMs|queueWaitMs|rateGateWaitMs)": \d+/g, '"elapsedMs": 0').replaceAll(workspace, "<workspace>").replace(/pi-codecks-bulk-(?:create|update)-[^"\s\\/]+/g, "<artifact>").replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, match => match === userId || match === cardId ? match : "<session>");
  if (Array.isArray(value)) return value.map(item => normalize(item, workspace));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !["createdAt", "generatedAt", "elapsedMs", "totalDurationMs", "durationMs", "queueWaitMs", "rateGateWaitMs"].includes(key)).map(([key, item]) => [key, normalize(item, workspace)]));
  return value;
};
try {
const catalog = composeCodecksToolCatalog(CARD_TOOL_DEFINITIONS);
assert.equal(catalog.size, 19, "nineteen tools, plus two native read functions and one batch payload function");
assert.equal(Object.keys(moved).length, 22);
assert.strictEqual(reads.card_get_batch.executePayload, reads.executeCardGetBatchPayload);
assert.equal(Object.hasOwn(originals, "executeCardGetBatchPayload"), false, "no facade export expansion");
assert.throws(() => composeCodecksToolCatalog(CARD_TOOL_DEFINITIONS, CARD_TOOL_DEFINITIONS), /Duplicate/);
const registrations = new Map<string, any>();
const baselineRegistrations = new Map<string, any>();
function register(definition: any, registry: Map<string, any>) {
  registerCodecksTool({ registerTool: (tool: any) => registry.set(tool.name, tool) } as any, definition, definition.tool.description, true, () => "PERSONAL");
}
for (const definition of CARD_TOOL_DEFINITIONS) {
  const original = getCodecksToolDefinition(definition.exportName);
  assert.strictEqual(definition.tool, moved[definition.exportName]);
  assert.deepEqual(definition.config.parameters, original.config.parameters);
  assert.deepEqual(definition.config.promptSnippet, original.config.promptSnippet);
  assert.deepEqual(definition.config.promptGuidelines, original.config.promptGuidelines);
  assert.strictEqual(definition.outputSchema, original.outputSchema);
  assert.strictEqual(definition.projectOutput, original.projectOutput);
  assert.equal(definition.cardTextPresentation, original.cardTextPresentation);
  assert.equal(definition.tool.description, original.tool.description);
  const aliases = { id: 42, card_id: 42, run_id: 91, output_format: "json", location: "backlog", dry_run: true };
  assert.deepEqual(definition.config.prepareArguments?.(aliases), original.config.prepareArguments?.(aliases));
  assert.equal(!!definition.read, ["card_get", "card_search"].includes(definition.exportName));
  assert.equal(!!definition.executePayload, definition.exportName === "card_get_batch");
  register(definition, registrations); register(original, baselineRegistrations);
  assert.deepEqual(registrations.get(`codecks_${definition.exportName}`).parameters, baselineRegistrations.get(`codecks_${definition.exportName}`).parameters);
}
for (const name of ["card_get", "card_search"] as const) {
  const saved = moved[name].read;
  const sentinel = { text: "late-bound", payload: {} };
  moved[name].read = async () => sentinel as any;
  try { assert.strictEqual(await catalog.get(name)!.read!({}), sentinel); }
  finally { moved[name].read = saved; }
}

let comparisons = 0;
async function invoke(name: string, args: any, candidate: boolean, mode: "normal" | "forbidden" = "normal", native = false) {
  resetRateGate();
  const workspace = await mkdtemp(join(scratch, "run-"));
  const requests: any[] = [];
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const path = String(input).match(/\/dispatch\/(.+)$/)?.[1] ?? "query";
    requests.push({ path, body });
    if (mode === "forbidden") return new Response(JSON.stringify({ error: "Synthetic forbidden" }), { status: 403 });
    if (path !== "query") return new Response(JSON.stringify({ payload: { card: { id: "created", accountSeq: 1 } } }));
    const query = body.query;
    if (JSON.stringify(query).includes("loggedInUser")) return new Response(JSON.stringify({ data: { _root: { loggedInUser: userId }, user: { [userId]: { id: userId, name: "Synthetic user" } } } }));
    const card = { cardId, accountSeq: 42, title: "Existing", content: "Existing\n\nBody", status: "not_started", derivedStatus: "not_started", isDoc: false, effort: 0, priority: "b", dueDate: null };
    const relation = query._root?.[0]?.account?.flatMap((entry: any) => typeof entry === "object" ? Object.keys(entry) : []).find((key: string) => key.startsWith("cards"));
    const data = relation ? { _root: { account: "fixture" }, account: { fixture: { [relation]: [cardId] } }, card: { [cardId]: card } } : { card: { [cardId]: card } };
    return new Response(JSON.stringify({ data }));
  };
  const fn = candidate ? moved[name] : originals[name];
  let counts: any;
  let result: any;
  try {
  if (native) result = await (candidate ? registrations : baselineRegistrations).get(`codecks_${name}`).execute("synthetic", args, undefined, undefined, { cwd: workspace });
  else result = await runWithAbortSignal(undefined, async () => {
    try { return name.startsWith("readCard") ? await fn(args) : await fn.execute(args); }
    finally { counts = { attempted: getOperationContext()?.requestsAttempted, dispatched: getOperationContext()?.requestsDispatched }; }
  }, workspace, undefined, "PERSONAL");
  } catch (error: any) { result = { thrown: { name: error.name, message: error.message, category: error.category, details: error.details } }; }
  let artifact: any;
  if (typeof result === "string" && result.includes("```json")) {
    const payload = parse(result);
    if (payload.data?.artifact?.path) artifact = JSON.parse(readFileSync(payload.data.artifact.path, "utf8"));
  }
  return normalize({ result, requests, counts, artifact }, workspace);
}
async function compare(name: string, args: any, mode: "normal" | "forbidden" = "normal", native = false) {
  const actual = await invoke(name, args, true, mode, native);
  const expected = await invoke(name, args, false, mode, native);
  assert.deepEqual(actual, expected, `${name} ${mode} native=${native}`);
  comparisons++;
  return actual;
}
  // Direct coverage of every extracted public operation; invalid inputs must stay request-free.
  for (const definition of CARD_TOOL_DEFINITIONS) {
    for (const format of ["text", "json"]) await compare(definition.exportName, { format });
  }
  for (const name of ["card_get", "card_get_batch", "card_get_formatted", "card_update", "card_update_status", "card_update_effort", "card_update_priority", "card_set_parent", "card_update_run"]) {
    const args = { cardId, cardIds: [cardId], content: "Changed body", status: "started", effort: 0, priority: "high", parentCardId: null, runId: null, format: "json" };
    await compare(name, args);
    await compare(name, args, "forbidden", true);
  }
  await compare("readCardGet", { cardId });
  await compare("readCardSearch", { title: "Existing", limit: 2 });
  for (const name of ["card_get", "card_search"]) await compare(name, { cardId, title: "Existing", format: "json" }, "normal", true);
  const create = await compare("card_create", { title: "Synthetic title", content: "Body", effort: 0, format: "json" });
  assert.equal(create.requests.filter((item: any) => item.path === "cards/create").length, 1);
  const preview = await compare("card_bulk_create", { cards: [{ title: "Alpha", correlationKey: "one" }], dryRun: true, format: "json" });
  assert.equal(preview.requests.filter((item: any) => item.path !== "query").length, 0);
  const fingerprint = parse(preview.result).data.previewFingerprint;
  await compare("card_bulk_create", { cards: [{ title: "Alpha", correlationKey: "one" }], dryRun: false, expectedPreviewFingerprint: fingerprint, format: "json" });
  const update = await compare("card_bulk_update", { updates: [{ cardId, effort: 0 }], dryRun: true, format: "json" });
  await compare("card_bulk_update", { updates: [{ cardId, effort: 0 }], dryRun: false, expectedPreviewFingerprint: parse(update.result).data.previewFingerprint, format: "json" });

  // Attachment hooks are domain-owned and enforce containment and source drift.
  const attachment = join(scratch, "attachment.txt");
  await writeFile(attachment, "before");
  const snapshot = await snapshotAttachmentSource(attachment, scratch);
  assertUnchangedAttachmentSource(snapshot, await snapshotAttachmentSource(attachment, scratch));
  await writeFile(attachment, "changed source");
  const changed = await snapshotAttachmentSource(attachment, scratch);
  assert.throws(() => assertUnchangedAttachmentSource(snapshot, changed));
  await assert.rejects(() => snapshotAttachmentSource(resolve(scratch, "..", "outside.txt"), scratch));
  const read = await invoke("readCardGet", { cardId }, true);
  const dto = projectCardGetOutput(read.result.payload);
  assert.equal(dto.ok, true); assert.equal(dto.card.effort, 0); assert.equal(dto.card.isDoc, false); assert.equal(dto.card.dueDate, null);

  // Reuse the existing synthetic behavioral fixtures, without editing their files/harness.
  // Each temporary script imports a test-only bridge whose tools/native reads are the
  // extracted objects, while __test references the same canonical runtime hooks.
  // Relative fixture imports remain anchored to the original tests directory.
  const abs = (path: string) => pathToFileURL(resolve(root, path)).href;
  const bridge = join(scratch, "cards-direct.mts");
  await writeFile(bridge, `export * from ${JSON.stringify(abs("src/codecks-core.ts"))};\nexport { ${Object.keys(reads).join(", ")} } from ${JSON.stringify(abs("src/tools/cards/reads.ts"))};\nexport { ${Object.keys(writes).join(", ")} } from ${JSON.stringify(abs("src/tools/cards/writes.ts"))};\nexport { ${Object.keys(bulk).join(", ")} } from ${JSON.stringify(abs("src/tools/cards/bulk.ts"))};\n`);
  const suites = ["card-get-tool", "card-get-observation", "card-get-output", "card-search-output", "card-search-preview", "card-reference-normalization", "done-timeframe-validation", "vision-board-tool", "bulk-create-preview-fingerprint", "bulk-create-characterization", "bulk-create-progress-reliability", "bulk-update-reliability", "backlog-hardening", "codecks-mutation-dispatch"];
  const requireFromRoot = createRequire(join(root, "package.json"));
  // Audit and resolve all fixture imports before executing any script. Compare the
  // require/default resolution with ESM import conditions; never substitute a CJS entry.
  const scripts = await Promise.all(suites.map(async suite => {
    const source = await readFile(join(root, "tests", `${suite}.test.ts`), "utf8");
    const script = source.replace(/(["'])(\.{1,2}\/[^"']+)\1/g, (_match, _quote, specifier) => JSON.stringify(specifier === "../src/codecks-core.ts" ? pathToFileURL(bridge).href : abs(join("tests", specifier))));
    const resolvedScript = script.replace(/(from\s+|import\(\s*)(["'])([^"']+)\2/g, (match, prefix, quote, specifier) => {
      if (/^(node:|file:|\.)/.test(specifier)) return match;
      const requireUrl = pathToFileURL(requireFromRoot.resolve(specifier)).href;
      const importUrl = import.meta.resolve(specifier);
      assert.equal(requireUrl, importUrl, `Fixture package export conditions differ: ${specifier}`);
      return `${prefix}${JSON.stringify(importUrl)}`;
    });
    return { suite, script: resolvedScript };
  }));
  for (const { suite, script } of scripts) {
    const scriptPath = join(scratch, `${suite}.mts`);
    await writeFile(scriptPath, script);
    const result = spawnSync(process.execPath, [join(root, "node_modules/tsx/dist/cli.mjs"), scriptPath], { cwd: root, encoding: "utf8", env: process.env, timeout: 180_000 });
    assert.equal(result.status, 0, `${suite} against extracted tools:\n${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
    console.log(`direct extracted fixture suite passed: ${suite}`);
  }
  console.log(`cards extraction passed: ${comparisons} side-by-side comparisons, 19 definitions, 22 direct exports, 14 extracted fixture suites`);
} finally {
  globalThis.fetch = originalFetch;
  resetRateGate();
  for (const [key, value] of temporaryEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(scratch, { recursive: true, force: true });
}
