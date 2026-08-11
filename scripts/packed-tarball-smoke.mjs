import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { packageRoot, pack, runNpm } from "./package-archive.mjs";

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
      // The extension imports TypeBox at runtime; make it explicit for the
      // neutral packed-consumer smoke test.
      dependencies: { typebox: `file:${path.join(packageRoot, "node_modules", "typebox")}` },
    }, null, 2)}\n`,
  );

  const packed = pack({ destination: archiveDir });
  const archivePath = path.join(archiveDir, packed.filename);
  assert.ok(existsSync(archivePath), "expected npm pack to create a tarball in the temporary directory");

  const cleanEnv = { ...process.env, npm_config_offline: "true" };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("CODECKS_") || key.startsWith("PI_CODECKS_")) {
      delete cleanEnv[key];
    }
  }

  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--omit=optional", archivePath],
    { cwd: consumerDir, env: cleanEnv },
  );

  const installedRoot = path.join(consumerDir, "node_modules", "@aefree", "pi-codecks");
  const packageJson = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(packageJson.name, "@aefree/pi-codecks");
  assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
  assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
  assert.deepEqual(packageJson.pi?.prompts, ["./prompts"]);
  assert.equal(packageJson.peerDependencies?.["@aefree/pi-workflow"], undefined, "packed package must not declare a workflow integration");

  for (const relativePath of [
    "index.ts",
    "src/codecks-core.ts",
    "src/codecks-external-helper.ts",
    "src/codecks-onepassword.ts",
    "src/integrations/codecks-onepassword-credential-helper.mjs",
    "docs/external-credential-helper-protocol.md",
    "skills/using-codecks/SKILL.md",
    "skills/codecks-velocity-reporting/SKILL.md",
    "prompts/codecks-inbox.md",
    "references/cg-changelog/codecks-workflow.md",
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
      || /^CODECKS_PROFILE_[A-Z0-9_]+_(?:TOKEN|API_TOKEN|TOKEN_REF|TOKEN_OP_REF)$/.test(normalized)
      || ["CODECKS_PROFILE", "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_CREDENTIAL_HELPER_MODULE"].includes(normalized);
  });
  process.stdout.write(prohibited ? "not-json" : JSON.stringify({ version: 1, credential: "packed-inert-helper-token" }));
});
`);
  writeFileSync(malformedHelperPath, `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("not-json"));\n`);
  const helperSmokePath = path.join(consumerDir, "external-helper-smoke.mjs");
  writeFileSync(helperSmokePath, `
import assert from "node:assert/strict";
import * as core from "./node_modules/@aefree/pi-codecks/src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "packed-helper-account";
process.env.CODECKS_TOKEN = "ambient-token-that-must-not-reach-helper";
process.env.CODECKS_PROFILE = "packed-profile";
process.env.CODECKS_CREDENTIAL_PROVIDER = "external-helper";
process.env.CODECKS_CREDENTIAL_HELPER_MODULE = ${JSON.stringify(helperPath)};
assert.deepEqual(await core.__test.resolveAuthenticatedConfig(), {
  account: "packed-helper-account", baseUrl: "https://api.codecks.io", token: "packed-inert-helper-token",
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

  const packedOpPath = path.join(consumerDir, "inert-packed-op");
  writeFileSync(packedOpPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const [command, flag, delimiter, child, ...childArgs] = process.argv.slice(2);
if (command !== "run" || flag !== "--no-masking" || delimiter !== "--" || !child || process.env.OP_SERVICE_ACCOUNT_TOKEN !== "packed-inert-service-token") process.exit(64);
if (process.env.PACKED_OP_MODE === "malformed") { process.stdout.write("not-json"); process.exit(0); }
const nested = spawn(child, childArgs, { env: { ...process.env, PI_CODECKS_ONEPASSWORD_CREDENTIAL: "packed-inert-onepassword-token" }, stdio: ["ignore", "pipe", "pipe"] });
nested.stdout.pipe(process.stdout); nested.stderr.pipe(process.stderr); nested.once("close", (status) => process.exit(status ?? 1));
`);
  chmodSync(packedOpPath, 0o755);
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
globalThis.fetch = async (_input, init) => {
  assert.equal(init.headers["X-Auth-Token"], "packed-inert-onepassword-token");
  return new Response(JSON.stringify({ data: {} }), { status: 200 });
};
await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
process.env.PACKED_OP_MODE = "malformed";
await assert.rejects(core.__test.resolveAuthenticatedConfig(), /External Codecks credential helper is unavailable/);
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
