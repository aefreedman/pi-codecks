import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { packageRoot, pack, parsePackResult, runNpm } from "./package-archive.mjs";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pi-codecks-pack-smoke-"));
const archiveDir = path.join(tempRoot, "archive");
const consumerDir = path.join(tempRoot, "consumer");

try {
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({
      name: "pi-codecks-neutral-smoke",
      private: true,
      version: "0.0.0",
    }, null, 2)}\n`,
  );

  const packed = pack({ destination: archiveDir });
  const archivePath = path.join(archiveDir, packed.filename);
  assert.ok(existsSync(archivePath), "expected npm pack to create a tarball in the temporary directory");

  // Supply host-provided TypeBox and Pi's TUI peer (plus its two dependencies)
  // explicitly as local tarballs so the consumer test stays offline even on a cold npm cache.
  const dependencyArchives = ["typebox", "@earendil-works/pi-tui", "get-east-asian-width", "marked"].map(name => {
    const packed = parsePackResult(runNpm([
      "pack", "--json", "--ignore-scripts", "--pack-destination", archiveDir,
      path.join(packageRoot, "node_modules", name),
    ]).stdout);
    const archive = path.join(archiveDir, packed.filename);
    assert.ok(existsSync(archive), `expected locked dependency tarball: ${name}`);
    return archive;
  });

  const cleanEnv = { ...process.env, npm_config_offline: "true" };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("CODECKS_") || key.startsWith("PI_CODECKS_") || key.startsWith("OP_")) {
      delete cleanEnv[key];
    }
  }

  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=optional", ...dependencyArchives, archivePath],
    { cwd: consumerDir, env: cleanEnv },
  );

  const installedRoot = path.join(consumerDir, "node_modules", "@aefree", "pi-codecks");
  const packageJson = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@aefree/pi-codecks");
  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
  assert.deepEqual(packageJson.pi?.prompts, ["./prompts"]);
  assert.equal(packageJson.peerDependencies?.["@aefree/pi-workflow"], undefined, "packed package must not declare a workflow integration");
  assert.equal(packageJson.dependencies?.typebox, undefined, "packed package must not install a production TypeBox copy");
  assert.equal(packageJson.peerDependencies?.typebox, "*");
  assert.ok(existsSync(path.join(consumerDir, "node_modules", "typebox", "package.json")), "neutral consumer must resolve the explicitly supplied TypeBox host peer");

  for (const relativePath of [
    "index.ts",
    "src/codecks-core.ts",
    "src/codecks-renderers.ts",
    "src/codecks-external-helper.ts",
    "src/codecks-onepassword.ts",
    "src/codecks-onepassword-state.ts",
    "src/codecks-credential-error.ts",
    "src/codecks-bounded-response.ts",
    "src/integrations/codecks-onepassword-credential-helper.mjs",
    "docs/external-credential-helper-protocol.md",
    "skills/using-codecks/SKILL.md",
    "skills/codecks-velocity-reporting/SKILL.md",
    "prompts/codecks-inbox.md",
    "references/cg-changelog/codecks-workflow.md",
    "references/codecks/structured-output-index.md",
    "references/codecks/cards-domain-output.md",
    "references/codecks/entities-domain-output.md",
    "references/codecks/conversations-domain-output.md",
    "references/codecks/reports-domain-output.md",
    "README.md",
    "LICENSE",
  ]) {
    assert.ok(existsSync(path.join(installedRoot, relativePath)), `expected installed package asset: ${relativePath}`);
  }

  const installedReference = readFileSync(path.join(installedRoot, "references", "cg-changelog", "codecks-workflow.md"), "utf8");
  assert.match(installedReference, /codecks_card_list_done_within_timeframe/);

  for (const excludedPath of [
    "tests",
    "scripts",
    ".github",
    "docs/plans",
    "docs/release.md",
    "todos",
    "src/codecks-readonly-auth-contract.ts",
    "src/integrations/codecks-readonly-auth-client.mjs",
  ]) {
    assert.equal(existsSync(path.join(installedRoot, excludedPath)), false, `did not expect installed package path: ${excludedPath}`);
  }

  const fixturePath = path.join(consumerDir, "load-extension.mjs");
  writeFileSync(fixturePath, `
import assert from "node:assert/strict";
import codecksTools from "./node_modules/@aefree/pi-codecks/index.ts";

const tools = new Map();
const sessionStartHandlers = [];
codecksTools({
  registerTool(tool) { tools.set(tool.name, tool); },
  on(event, handler) { if (event === "session_start") sessionStartHandlers.push(handler); },
  getActiveTools() { return []; },
  getAllTools() { return [...tools.values()]; },
  setActiveTools() {},
});
assert.ok(tools.has("codecks_card_get"), "core Codecks tools must load without workflow");
assert.ok(tools.has("codecks_tool_search"), "dynamic Codecks tool loading must remain available without workflow");
const migrated = ["codecks_card_get","codecks_card_search","codecks_card_get_batch","codecks_card_list_missing_effort","codecks_card_list_done_within_timeframe","codecks_card_get_vision_board","codecks_card_create","codecks_card_set_parent","codecks_card_update_run","codecks_card_add_attachment","codecks_card_update","codecks_card_update_status","codecks_card_add_to_hand","codecks_card_remove_from_hand","codecks_card_update_effort","codecks_card_update_priority","codecks_card_bulk_create","codecks_card_bulk_update","codecks_deck_get","codecks_deck_update","codecks_milestone_list","codecks_milestone_get","codecks_milestone_update","codecks_run_list","codecks_run_get","codecks_run_update","codecks_user_lookup","codecks_card_add_comment","codecks_card_add_review","codecks_card_add_blocker","codecks_card_add_block","codecks_card_reply_resolvable","codecks_card_edit_resolvable_entry","codecks_card_close_resolvable","codecks_card_reopen_resolvable","codecks_card_list_resolvables","codecks_list_open_resolvable_cards","codecks_list_logged_in_user_actionable_resolvables","codecks_velocity_observations_update","codecks_velocity_report","codecks_run_delivered_effort","codecks_run_average_effort"];
assert.equal(migrated.length, 42);
for (const name of migrated) assert.ok(tools.get(name)?.outputSchema, name + ": packed native schema");
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw Error("packed fixture must stay offline"); };
for (const name of ["codecks_deck_update", "codecks_card_update_effort", "codecks_card_add_comment"]) {
  const failed = await tools.get(name).execute("packed-native-error", {}, undefined, undefined, { cwd: process.cwd() });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.ok, false);
  assert.equal(failed.structuredContent.error.code, "validation_error");
}
assert.equal(networkCalls, 0);
const cardTool = tools.get("codecks_card_get");
const result = Object.freeze({ content: Object.freeze([{ type: "text", text: "exact published evidence" }]) });
const theme = { fg: (_color, text) => text, bold: text => text };
assert.match(cardTool.renderResult(result, { expanded: true }, theme).render(80).join("\\n"), /exact published evidence/);
assert.equal(result.content[0].text, "exact published evidence");
const sessionManager = { getBranch: () => [] };
for (const handler of sessionStartHandlers) await handler({ reason: "packed-standalone" }, { sessionManager });
console.log("isolated packed extension loaded");
`);
  const tsxLoader = pathToFileURL(path.join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const runFixture = () => spawnSync(process.execPath, ["--import", tsxLoader, fixturePath], {
    cwd: consumerDir,
    env: cleanEnv,
    encoding: "utf8",
  });
  const standaloneResult = runFixture();
  assert.equal(standaloneResult.status, 0, `standalone packed extension load failed:\n${standaloneResult.stdout}\n${standaloneResult.stderr}`);
  assert.match(standaloneResult.stdout, /isolated packed extension loaded/);

  const helperPath = path.join(consumerDir, "inert-packed-helper.mjs");
  const malformedHelperPath = path.join(consumerDir, "inert-malformed-helper.mjs");
  writeFileSync(helperPath, `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prohibited = Object.keys(process.env).some((key) => {
    const normalized = key.toUpperCase();
    return /^CODECKS_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF)$/.test(normalized)
      || normalized === "PI_CODECKS_ONEPASSWORD_REFERENCE"
      || /^CODECKS_PROFILE_[A-Z0-9_]+_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF|ONEPASSWORD_REFERENCE)$/.test(normalized)
      || ["CODECKS_PROFILE", "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_CREDENTIAL_HELPER_MODULE"].includes(normalized);
  });
  process.stdout.write(prohibited ? "not-json" : JSON.stringify({ version: 1, credential: "cdxat_packed-synthetic-helper-token" }));
});
`);
  writeFileSync(malformedHelperPath, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("not-json"));\n`);
  const helperSmokePath = path.join(consumerDir, "external-helper-smoke.mjs");
  writeFileSync(helperSmokePath, `
import assert from "node:assert/strict";
import * as core from "./node_modules/@aefree/pi-codecks/src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "packed-helper-account";
process.env.CODECKS_TOKEN = "ambient-token-that-must-not-reach-helper";
process.env.CODECKS_PROFILE = "ORG";
process.env.CODECKS_CREDENTIAL_PROVIDER = "external-helper";
process.env.CODECKS_CREDENTIAL_HELPER_MODULE = ${JSON.stringify(helperPath)};
assert.deepEqual(await core.__test.resolveAuthenticatedConfig(), {
  account: "packed-helper-account", baseUrl: "https://api.codecks.io", token: "cdxat_packed-synthetic-helper-token", kind: "ORG", profileKey: "ORG",
});
process.env.CODECKS_CREDENTIAL_HELPER_MODULE = ${JSON.stringify(malformedHelperPath)};
await assert.rejects(core.__test.resolveAuthenticatedConfig(), {
  message: "External Codecks credential helper returned an invalid response.",
});
console.log("installed external helper succeeds and fails closed");
`);
  const helperResult = spawnSync(process.execPath, ["--import", tsxLoader, helperSmokePath], {
    cwd: consumerDir,
    env: cleanEnv,
    encoding: "utf8",
  });
  assert.equal(helperResult.status, 0, `installed external-helper smoke failed:\n${helperResult.stdout}\n${helperResult.stderr}`);
  assert.match(helperResult.stdout, /installed external helper succeeds and fails closed/);

  // Node runs the cwd-local inert 'run' script on all platforms, avoiding Windows shebang assumptions.
  const packedOpPath = process.execPath;
  const packedOpScript = path.join(consumerDir, "run");
  writeFileSync(packedOpScript, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const [command, flag, delimiter, child, ...childArgs] = ["run", ...process.argv.slice(2)];
if (command !== "run" || flag !== "--no-masking" || delimiter !== "--" || !child || process.env.OP_SERVICE_ACCOUNT_TOKEN !== "packed-inert-service-token") process.exit(64);
if (process.env.PACKED_OP_MODE === "malformed") { process.stdout.write("not-json"); process.exit(0); }
const nested = spawn(child, childArgs, { env: { ...process.env, PI_CODECKS_ONEPASSWORD_CREDENTIAL: "cdxat_packed-synthetic-onepassword-token" }, stdio: ["ignore", "pipe", "pipe"] });
nested.stdout.pipe(process.stdout); nested.stderr.pipe(process.stderr); nested.once("close", (status) => process.exit(status ?? 1));
`);
  chmodSync(packedOpScript, 0o755);
  const onepasswordSmokePath = path.join(consumerDir, "onepassword-smoke.mjs");
  writeFileSync(onepasswordSmokePath, `
import assert from "node:assert/strict";
import * as core from "./node_modules/@aefree/pi-codecks/src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "packed-onepassword-account";
process.env.CODECKS_TOKEN = "ambient-token-that-must-not-be-used";
process.env.CODECKS_CREDENTIAL_PROVIDER = "onepassword";
process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE = ${JSON.stringify(packedOpPath)};
process.env.PI_CODECKS_ONEPASSWORD_REFERENCE = "op://inert/vault/item";
process.env.OP_SERVICE_ACCOUNT_TOKEN = "packed-inert-service-token";
let fetches = 0;
globalThis.fetch = async (_input, init) => {
  fetches++;
  assert.equal(init.headers.Authorization, "Bearer cdxat_packed-synthetic-onepassword-token");
  assert.equal(init.headers["X-Auth-Token"], undefined);
  return new Response(JSON.stringify({ data: {} }), { status: 200 });
};
const queryResult = await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
assert.equal(fetches, 1, 'the installed helper must actually resolve, not merely return an error string');
assert.match(String(queryResult), /Codecks Query Result/);
process.env.PACKED_OP_MODE = "malformed";
await assert.rejects(core.__test.resolveAuthenticatedConfig(), { credentialCategory: 'credential_helper_unavailable', provider: 'onepassword' });
delete process.env.PACKED_OP_MODE;
process.env.CODECKS_ONEPASSWORD_REUSE_TTL_MS = '60000';
const reused1 = await core.__test.resolveAuthenticatedConfig();
const reused2 = await core.__test.resolveAuthenticatedConfig();
assert.equal(reused1.credentialGeneration, reused2.credentialGeneration);
globalThis.fetch = async () => new Response(JSON.stringify({ data: { _root: { account: { cards: [
  { cardId: 'inert-card', accountSeq: 42, title: 'Inert', content: 'Inert body', status: 'started' }
] } } } }), { status: 200 });
const batch = String(await core.card_get_batch.execute({ cardIds: ['seq:42', 'seq:42'] }));
assert.match(batch, /\"complete\": true/);
assert.match(batch, /Inert body/);
console.log("installed built-in onepassword provider succeeds with --no-masking and fails closed");
`);
  const onepasswordResult = spawnSync(process.execPath, ["--import", tsxLoader, onepasswordSmokePath], {
    cwd: consumerDir,
    env: cleanEnv,
    encoding: "utf8",
  });
  assert.equal(onepasswordResult.status, 0, `installed onepassword smoke failed:\n${onepasswordResult.stdout}\n${onepasswordResult.stderr}`);
  assert.match(onepasswordResult.stdout, /installed built-in onepassword provider succeeds with --no-masking and fails closed/);

  console.log("Packed tarball smoke test passed in a credential-free temporary project with inert external-helper and built-in onepassword coverage.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
