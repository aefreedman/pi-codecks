import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { pack, packageRoot, parsePackResult, runNpm } from "./package-archive.mjs";

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pi-codecks-pack-smoke-"));
const archiveDir = path.join(tempRoot, "archive");
const consumerDir = path.join(tempRoot, "consumer");

try {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(archiveDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    path.join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "pi-codecks-neutral-smoke", private: true, version: "0.0.0" }, null, 2)}\n`,
  );

  const packed = pack({ destination: archiveDir });
  const archivePath = path.join(archiveDir, packed.filename);
  const packSibling = (directory) => {
    const result = parsePackResult(runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", archiveDir], { cwd: path.resolve(packageRoot, "..", directory) }).stdout);
    return path.join(archiveDir, result.filename);
  };
  const dependencyArchives = [packSibling("pi-capability-registry"), packSibling("pi-workflow")];
  assert.ok(existsSync(archivePath), "expected npm pack to create a tarball in the temporary directory");

  const cleanEnv = { ...process.env, npm_config_offline: "true" };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("CODECKS_") || key.startsWith("PI_CODECKS_")) {
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

  const coinstalledWorkflow = JSON.parse(readFileSync(path.join(consumerDir, "node_modules", "@aefree", "pi-workflow", "package.json"), "utf8"));
  assert.equal(coinstalledWorkflow.name, "@aefree/pi-workflow");
  assert.equal(coinstalledWorkflow.version, "0.1.0");
  assert.equal(existsSync(path.join(installedRoot, "node_modules", "@aefree")), false, "decomposition dependencies must not be copied inside pi-codecks");
  const installedReference = readFileSync(path.join(installedRoot, "references", "cg-changelog", "codecks-workflow.md"), "utf8");
  assert.match(installedReference, /codecks_card_list_done_within_timeframe/);

  for (const excludedPath of ["tests", "scripts", ".github", "docs/plans", "todos"]) {
    assert.equal(existsSync(path.join(installedRoot, excludedPath)), false, `did not expect installed package path: ${excludedPath}`);
  }

  console.log("Packed tarball smoke test passed in a credential-free temporary project.");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
