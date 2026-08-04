import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRegisteredTools } from "./pi-tool-harness.ts";
import { observationCache } from "./velocity-fixtures.ts";

const root = await mkdtemp(join(tmpdir(), "pi-codecks-velocity-"));
try {
  await mkdir(join(root, "input"), { recursive: true });
  await writeFile(join(root, "input", "observations.json"), `${JSON.stringify(observationCache(), null, 2)}\n`, "utf8");
  await writeFile(join(root, "input", "roster.yaml"), "members:\n  - name: Alex | QA\n    userId: user-a\n", "utf8");

  const tools = await loadRegisteredTools();
  const updater = tools.get("codecks_velocity_observations_update");
  const report = tools.get("codecks_velocity_report");
  assert(updater, "observation updater must be registered");
  assert(report, "cache-consuming report must be registered");
  assert.deepEqual(Object.keys(updater.parameters?.properties ?? {}), ["observationsPath", "refreshMode", "fromDate", "toDate", "overlapDays", "scanLimit", "pageSize", "format"]);
  assert(Object.keys(report.parameters?.properties ?? {}).includes("measure"));
  assert(Object.keys(report.parameters?.properties ?? {}).includes("gapPolicy"));

  const invoke = async (args: Record<string, unknown>): Promise<any> => {
    const result = await report.execute("test", args, undefined, undefined, { cwd: root });
    const text = result.content[0].text as string;
    const fenced = text.match(/```json\n([\s\S]*?)\n```/);
    return JSON.parse(fenced?.[1] ?? text);
  };

  const json = await invoke({
    observationsPath: "input/observations.json",
    rosterPath: "input/roster.yaml",
    csvPath: "output/report.csv",
    summaryMarkdownPath: "output/report.md",
    format: "json",
  });
  assert.equal(json.ok, true);
  assert.equal(json.data.schemaVersion, 2);
  assert.equal(json.data.measure, "calendar_delivered");
  assert(json.data.transformations.length > 0);
  assert.match(await readFile(join(root, "output", "report.csv"), "utf8"), /raw_delivered_card/);
  assert.match(await readFile(join(root, "output", "report.md"), "utf8"), /## Transformations/);

  const csvOnly = await invoke({ observationsPath: "input/observations.json", csvPath: "output/only.csv", format: "json" });
  assert.equal(csvOnly.ok, true);
  assert.match(await readFile(join(root, "output", "only.csv"), "utf8"), /summary/);

  const alias = await invoke({ observationsPath: "input/observations.json", csvPath: "input/observations.json", format: "json" });
  assert.equal(alias.ok, false);
  assert.match(alias.error.message, /same file/);
  await symlink(join(root, "input"), join(root, "input-alias"), process.platform === "win32" ? "junction" : "dir");
  const symlinkAlias = await invoke({ observationsPath: "input/observations.json", csvPath: "input-alias/observations.json", format: "json" });
  assert.equal(symlinkAlias.ok, false);
  assert.match(symlinkAlias.error.message, /same file/);
  const traversal = await invoke({ observationsPath: "../outside.json", format: "json" });
  assert.equal(traversal.ok, false);
  assert.match(traversal.error.message, /outside the active workspace/);
  const missingPath = await invoke({ format: "json" });
  assert.equal(missingPath.ok, false);
  assert.match(missingPath.error.message, /observationsPath is required/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("velocity registered-tool contract tests passed");
