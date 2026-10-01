import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../src/codecks-core.ts";
import { CARD_TOOL_DEFINITIONS } from "../src/tools/cards/definitions.ts";
import { ENTITY_TOOL_DEFINITIONS } from "../src/tools/entities/definitions.ts";
import { CONVERSATION_TOOL_DEFINITIONS } from "../src/tools/conversations/definitions.ts";
import { REPORT_TOOL_DEFINITIONS } from "../src/tools/reports/definitions.ts";
import { RAW_TOOL_DEFINITIONS } from "../src/tools/raw-definitions.ts";
import { CODECKS_EXPORTS } from "../src/pi/tool-metadata.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { composeCodecksToolCatalog } from "../src/pi/tool-definition.ts";
import { CARD_GET_BATCH_OUTPUT_SCHEMA } from "../src/tools/cards/card-get-batch-output.ts";
import { CARD_GET_OUTPUT_SCHEMA } from "../src/card-get-output.ts";
import { CARD_SEARCH_OUTPUT_SCHEMA } from "../src/card-search-output.ts";
import { readCardGet, readCardSearch } from "../src/tools/cards/reads.ts";
import { snapshotAttachmentSource, assertUnchangedAttachmentSource } from "../src/tools/cards/helpers.ts";
import { runWithAbortSignal } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";

const groups = [RAW_TOOL_DEFINITIONS, ENTITY_TOOL_DEFINITIONS, CONVERSATION_TOOL_DEFINITIONS, CARD_TOOL_DEFINITIONS, REPORT_TOOL_DEFINITIONS];
const catalog = composeCodecksToolCatalog(...groups);
assert.equal(catalog.size, 47);
assert.deepEqual([...catalog.keys()].sort(), [...CODECKS_EXPORTS].sort());
assert.deepEqual(Object.keys(core).sort(), [...CODECKS_EXPORTS, "__test", "readCardGet", "readCardSearch", "runWithAbortSignal", "runExternalProviderIdentityCheck"].sort());
for (const [name, definition] of catalog) {
  assert.strictEqual(getCodecksToolDefinition(name), definition);
  assert.strictEqual(core[name], definition.tool, `${name}: one canonical operation`);
  assert.equal(typeof definition.tool.execute, "function");
  if (name !== "card_get" && name !== "card_search" && name !== "card_get_batch") {
    assert.equal(definition.executePayload, undefined);
    assert.equal(definition.read, undefined);
    assert.equal(definition.outputSchema, undefined);
    assert.equal(definition.projectOutput, undefined);
  }
}
assert.strictEqual(getCodecksToolDefinition("card_get_batch").outputSchema, CARD_GET_BATCH_OUTPUT_SCHEMA);
assert.equal(typeof getCodecksToolDefinition("card_get_batch").executePayload, "function");
assert.strictEqual(getCodecksToolDefinition("card_get").outputSchema, CARD_GET_OUTPUT_SCHEMA);
assert.strictEqual(getCodecksToolDefinition("card_search").outputSchema, CARD_SEARCH_OUTPUT_SCHEMA);
assert.strictEqual(core.readCardGet, readCardGet);
assert.strictEqual(core.readCardSearch, readCardSearch);
assert.strictEqual(core.runWithAbortSignal, runWithAbortSignal);
assert.strictEqual(core.__test.resetRateGate, resetRateGate);
assert.strictEqual(core.__test.snapshotAttachmentSource, snapshotAttachmentSource);
assert.strictEqual(core.__test.assertUnchangedAttachmentSource, assertUnchangedAttachmentSource);
// Invalid raw requests fail locally, even without any credentials or transport.
const fetchBefore = globalThis.fetch;
let requests = 0;
try {
  globalThis.fetch = async () => { requests++; throw Error("Unexpected transport"); };
  assert.match(String(await core.query.execute({ query: "not json" })), /validation_error/);
  assert.match(String(await core.dispatch.execute({ path: "", payload: {}, format: "json" })), /validation_error/);
  assert.match(String(await core.dispatch.execute({ path: "integrations/create", payload: {}, format: "json" })), /out_of_scope/);
  assert.equal(requests, 0);
} finally { globalThis.fetch = fetchBefore; }

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:ts|mjs)$/.test(path)) files.push(path);
  }
};
walk(resolve(root, "src"));
files.push(resolve(root, "index.ts"));
const graph = new Map<string, string[]>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const owner = relative(root, file).replaceAll("\\", "/");
  const deps = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["'](\.[^"']+)["']/g)].map(match => {
    const base = resolve(dirname(file), match[1]);
    const target = [base, `${base}.ts`, `${base}.mjs`, resolve(base, "index.ts")].find(path => existsSync(path) && files.includes(path));
    assert.ok(target, `${owner}: missing internal import ${match[1]}`);
    return target!;
  });
  const paths = deps.map(path => relative(root, path).replaceAll("\\", "/"));
  if (/^src\/(?:runtime|shared|contracts)\//.test(owner)) {
    assert.ok(paths.every(path => !/^src\/(?:tools|pi)\//.test(path) && path !== "src/codecks-core.ts" && path !== "index.ts"), `${owner}: infrastructure dependency direction`);
  }
  if (/^src\/tools\//.test(owner)) {
    assert.ok(paths.every(path => path !== "src/codecks-core.ts" && path !== "index.ts" && !/^src\/pi\/(?:tool-catalog|register-tools)/.test(path)), `${owner}: domain must not import composition`);
    const domain = owner.match(/^src\/tools\/(cards|entities|conversations|reports)\//)?.[1];
    if (domain) assert.ok(paths.every(path => !/^src\/tools\/(cards|entities|conversations|reports)\//.test(path) || path.startsWith(`src/tools/${domain}/`)), `${owner}: no cross-domain backdoor`);
  }
  if (owner !== "src/codecks-core.ts") assert.ok(!paths.includes("src/codecks-core.ts"), `${owner}: facade is consumers-only`);
  if (owner !== "src/runtime/operation-context.ts") assert.doesNotMatch(text, /new AsyncLocalStorage/);
  graph.set(file, deps);
}
const done = new Set<string>();
const visit = (file: string, stack: string[]) => {
  assert.ok(!stack.includes(file), `cycle: ${[...stack, file].map(path => relative(root, path)).join(" -> ")}`);
  if (done.has(file)) return;
  for (const next of graph.get(file) ?? []) visit(next, [...stack, file]);
  done.add(file);
};
for (const file of files) visit(file, []);
assert.deepEqual([...readFileSync(resolve(root, "src/codecks-core.ts"), "utf8").matchAll(/^export const (\w+)/gm)].map(match => match[1]), ["__test"], "facade contains only established test-hook composition");
assert.doesNotMatch(readFileSync(resolve(root, "src/pi/tool-catalog.ts"), "utf8"), /retainedDefinitions|TOOL_CONFIG|codecks-core/);
console.log(`Modular architecture: ${catalog.size} canonical tools, exact established exports, three native contracts, raw local failures, singleton identities and ${files.length}-module acyclic graph passed.`);
