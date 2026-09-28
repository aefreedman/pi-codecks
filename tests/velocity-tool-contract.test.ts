import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadRegisteredTools } from "./pi-tool-harness.ts";
import { observationCache } from "./velocity-fixtures.ts";
import * as core from "../src/codecks-core.ts";

const configKeys = ["CODECKS_ACCOUNT", "CODECKS_PROFILE", "CODECKS_API_BASE", "CODECKS_PROFILE_ORG_ACCOUNT", "CODECKS_PROFILE_ORG_API_BASE"] as const;
const previousConfig = new Map(configKeys.map((key) => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
for (const key of configKeys) delete process.env[key];
process.env.CODECKS_ACCOUNT = "example";
process.env.CODECKS_API_BASE = "https://api.codecks.io";
let credentialResolutions = 0;
let networkRequests = 0;
core.__test.setCredentialProviderForTests({ id: "offline-fixture", resolve: async () => { credentialResolutions++; throw new Error("Offline report must not resolve a credential."); } });
globalThis.fetch = (async () => { networkRequests++; throw new Error("Offline report must not fetch."); }) as typeof fetch;

const root = await mkdtemp(join(tmpdir(), "pi-codecks-velocity-"));
try {
  await mkdir(join(root, "input"), { recursive: true });
  const scopedCache = observationCache();
  (scopedCache.organization as typeof scopedCache.organization & { profile: string }).profile = "ORG";
  await writeFile(join(root, "input", "observations.json"), `${JSON.stringify(scopedCache, null, 2)}\n`, "utf8");
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
  assert.equal(json.data.organization.account, "example", "valid offline reports preserve cache provenance");

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

  const rejectCache = async (label: string, expectedError: RegExp): Promise<void> => {
    const path = `input/${label}.json`;
    const csvPath = `output/${label}.csv`;
    const markdownPath = `output/${label}.md`;
    const reportResult = await invoke({ observationsPath: path, csvPath, summaryMarkdownPath: markdownPath, format: "json" });
    assert.equal(reportResult.ok, false, `${label} offline report must fail closed`);
    assert.match(reportResult.error.message, expectedError);
    await assert.rejects(stat(join(root, csvPath)), { code: "ENOENT" });
    await assert.rejects(stat(join(root, markdownPath)), { code: "ENOENT" });
    const updateResult = await updater.execute("test", { observationsPath: path, refreshMode: "full", format: "json" }, undefined, undefined, { cwd: root });
    const updateText = updateResult.content[0].text as string;
    const updateJson = JSON.parse(updateText.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? updateText);
    assert.equal(updateJson.ok, false, `${label} update must reject before network, even in full mode`);
    assert.match(updateJson.error.message, expectedError);
    assert.equal(credentialResolutions, 0);
    assert.equal(networkRequests, 0);
  };
  await writeFile(join(root, "input", "other-account.json"), JSON.stringify({ ...scopedCache, organization: { ...scopedCache.organization, account: "other-account" } }));
  await rejectCache("other-account", /belongs to Codecks organization/);
  await writeFile(join(root, "input", "other-base.json"), JSON.stringify({ ...scopedCache, organization: { ...scopedCache.organization, baseUrl: "https://other.invalid" } }));
  await rejectCache("other-base", /API base differs/);
  assert.equal(credentialResolutions, 0);
  assert.equal(networkRequests, 0);
} finally {
  core.__test.setCredentialProviderForTests();
  globalThis.fetch = previousFetch;
  for (const key of configKeys) {
    const value = previousConfig.get(key);
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}

console.log("velocity registered-tool contract tests passed");
