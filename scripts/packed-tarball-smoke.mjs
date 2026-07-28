import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      // The extension imports TypeBox at runtime; make it explicit without
      // installing optional peers such as pi-workflow.
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

  for (const relativePath of [
    "index.ts",
    "src/codecks-core.ts",
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

  for (const excludedPath of ["tests", "scripts", ".github", "docs/plans", "todos"]) {
    assert.equal(existsSync(path.join(installedRoot, excludedPath)), false, `did not expect installed package path: ${excludedPath}`);
  }

  assert.equal(existsSync(path.join(consumerDir, "node_modules", "@aefree", "pi-workflow")), false, "workflow must be absent from the isolated packed consumer");

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
for (const handler of sessionStartHandlers) await handler({ reason: "packed-workflow-absent" }, { sessionManager });
console.log("isolated packed extension loaded without workflow");
`);
  const tsxLoader = pathToFileURL(path.join(packageRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const runFixture = () => spawnSync(process.execPath, ["--import", tsxLoader, fixturePath], {
    cwd: consumerDir,
    env: cleanEnv,
    encoding: "utf8",
  });
  const absentResult = runFixture();
  assert.equal(absentResult.status, 0, `workflow-absent packed extension load failed:\n${absentResult.stdout}\n${absentResult.stderr}`);
  assert.match(absentResult.stdout, /isolated packed extension loaded without workflow/);

  const brokenWorkflowRoot = path.join(consumerDir, "node_modules", "@aefree", "pi-workflow");
  mkdirSync(path.join(brokenWorkflowRoot, "contracts"), { recursive: true });
  writeFileSync(path.join(brokenWorkflowRoot, "package.json"), `${JSON.stringify({
    name: "@aefree/pi-workflow",
    type: "module",
    exports: { "./contracts/v1": "./contracts/v1.js" },
  }, null, 2)}\n`);
  writeFileSync(path.join(brokenWorkflowRoot, "contracts", "v1.js"), "throw new Error('broken workflow contract fixture');\n");
  const brokenResult = runFixture();
  assert.notEqual(brokenResult.status, 0, "a present broken workflow contract must fail visibly");
  assert.match(`${brokenResult.stdout}\n${brokenResult.stderr}`, /broken workflow contract fixture/);

  console.log("Packed tarball smoke test passed in a credential-free temporary project with isolated optional-workflow loading.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
