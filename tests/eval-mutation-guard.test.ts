import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import guard, { CODECKS_MUTATION_TOOL_NAMES } from "../evals/tool-loading/mutation-guard.ts";
import { CODECKS_SEARCH_CATALOG } from "../src/codecks-tool-loading.ts";
import { PiToolHarness } from "./pi-tool-harness.ts";

const harness = new PiToolHarness();
await harness.load();
let handler: any;
guard({ on: (event: string, callback: any) => { assert.equal(event, "tool_call"); handler = callback; } } as any);
let executions = 0;
async function dispatch(toolName: string, input: Record<string, unknown> = {}) {
  assert(harness.registry.has(toolName), `${toolName} must really be registered`);
  const result = await handler({ toolName, input });
  if (!result?.block) executions++; // fake transport; never invoke provider-backed execute
  return Boolean(result?.block);
}
for (const entry of CODECKS_SEARCH_CATALOG.filter((entry) => entry.tags.includes("mutation"))) {
  assert(CODECKS_MUTATION_TOOL_NAMES.has(entry.name), `unguarded registered mutation: ${entry.name}`);
}
// Explicit effect classification forces review of newly registered tools even
// when their catalog entry forgets a mutation tag.
const readsAndSessionTools = [
  "codecks_profile_select", "codecks_tool_search", "codecks_card_get", "codecks_card_get_batch", "codecks_card_search", "codecks_card_get_formatted", "codecks_card_get_vision_board", "codecks_card_list_done_within_timeframe",
  "codecks_card_list_missing_effort", "codecks_deck_get", "codecks_milestone_list", "codecks_milestone_get", "codecks_run_list", "codecks_run_get", "codecks_run_delivered_effort", "codecks_run_average_effort", "codecks_user_lookup",
  "codecks_card_list_resolvables", "codecks_list_open_resolvable_cards", "codecks_list_logged_in_user_actionable_resolvables", "codecks_query",
];
assert.deepEqual(new Set(harness.registry.keys()), new Set([...CODECKS_MUTATION_TOOL_NAMES, "codecks_velocity_observations_update", "codecks_velocity_report", ...readsAndSessionTools]), "new registrations require effect classification");
const config = JSON.parse(readFileSync(new URL("../evals/tool-loading/config.json", import.meta.url), "utf8"));
assert.deepEqual(new Set(config.mutationTools), CODECKS_MUTATION_TOOL_NAMES);
for (const name of CODECKS_MUTATION_TOOL_NAMES) {
  assert(await dispatch(name));
  assert(await dispatch(name, { dryRun: true, preflight: true })); // bulk previews also publish artifacts
}
assert(await dispatch("codecks_velocity_observations_update"));
const report = harness.registry.get("codecks_velocity_report")!;
for (const key of ["csvPath", "summaryMarkdownPath"]) {
  assert(Object.hasOwn(report.parameters!.properties, key));
  assert(await dispatch(report.name, { [key]: "report-output" }));
}
for (const key of ["csv_path", "summary_markdown_path"]) assert(await dispatch(report.name, { [key]: "report-output" }));
assert.equal(executions, 0, "blocked calls must never reach fake dispatch");
assert.equal(await dispatch(report.name, { observationsPath: "cache.json" }), false, "report without artifacts is permitted");
assert.equal(await dispatch("codecks_card_get"), false);
assert.equal(executions, 2);
await harness.shutdownSession();
console.log("PASS: Codecks eval guard covers registered tracker mutations and local outputs; blocked calls never execute");
