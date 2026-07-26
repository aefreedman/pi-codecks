import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PiToolHarness, type RegisteredTool, type ToolSourceInfo } from "./pi-tool-harness.ts";
import {
  BALANCED_ACTIVE_CODECKS_TOOL_NAMES,
  CODECKS_SEARCH_CATALOG,
  CODECKS_TOOL_LOADING_MODE_ENV,
  CODECKS_TOOL_SEARCH_NAME,
  CODECKS_TOOL_SEARCH_RESULT_MARKER,
  DEFAULT_CODECKS_TOOL_NAMES,
  searchCodecksTools,
} from "../src/codecks-tool-loading.ts";

const publicToolNames = [...DEFAULT_CODECKS_TOOL_NAMES];
const foreignSource: ToolSourceInfo = { path: "/extensions/foreign.ts", source: "extension", scope: "project", origin: "package" };

async function withMode<T>(mode: string | undefined, action: () => Promise<T>): Promise<T> {
  const previous = process.env[CODECKS_TOOL_LOADING_MODE_ENV];
  if (mode === undefined) delete process.env[CODECKS_TOOL_LOADING_MODE_ENV];
  else process.env[CODECKS_TOOL_LOADING_MODE_ENV] = mode;
  try { return await action(); }
  finally {
    if (previous === undefined) delete process.env[CODECKS_TOOL_LOADING_MODE_ENV];
    else process.env[CODECKS_TOOL_LOADING_MODE_ENV] = previous;
  }
}

async function loadHarness(activeTools: string[], branchEntries: unknown[] = [], options: ConstructorParameters<typeof PiToolHarness>[0] = {}, reason = "startup"): Promise<PiToolHarness> {
  const harness = new PiToolHarness({ activeTools, branchEntries, ...options });
  await harness.load();
  await harness.startSession(branchEntries, reason);
  return harness;
}

function toolResultEntry(addedToolNames: string[]): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: CODECKS_TOOL_SEARCH_NAME,
      isError: false,
      addedToolNames,
      details: { loaderMarker: CODECKS_TOOL_SEARCH_RESULT_MARKER, added: [...addedToolNames] },
    },
  };
}

function serializedActiveMetadataCharacters(harness: PiToolHarness): number {
  const tools = harness.getActiveTools().map((name) => harness.registry.get(name)).filter((tool): tool is RegisteredTool => Boolean(tool));
  return JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
    parameters: tool.parameters,
  }))).length;
}

async function main(): Promise<void> {
  assert.equal(publicToolNames.length, 40, "the default surface must include 40 tools");

  await withMode(undefined, async () => {
    const harness = await loadHarness(["read", "foreign_tool", ...publicToolNames]);
    assert.equal(harness.registry.size, 41, "40 default Codecks tools plus the loader should be registered");
    assert.deepEqual(new Set(harness.registry.keys()), new Set([...publicToolNames, CODECKS_TOOL_SEARCH_NAME]), "the registration and loading catalogs must stay in exact set equality");
    assert.deepEqual(new Set(harness.getActiveTools()), new Set(["read", "foreign_tool", CODECKS_TOOL_SEARCH_NAME, ...BALANCED_ACTIVE_CODECKS_TOOL_NAMES]));
  });

  await withMode("invalid", async () => {
    const harness = await loadHarness(["read", ...publicToolNames]);
    assert.deepEqual(new Set(harness.getActiveTools()), new Set(["read", CODECKS_TOOL_SEARCH_NAME, ...BALANCED_ACTIVE_CODECKS_TOOL_NAMES]), "invalid modes fall back to balanced");
  });

  await withMode("loader-only", async () => {
    const harness = await loadHarness(["read", "foreign_tool", ...publicToolNames]);
    assert.deepEqual(new Set(harness.getActiveTools()), new Set(["read", "foreign_tool", CODECKS_TOOL_SEARCH_NAME]));
  });

  await withMode("all-active", async () => {
    const harness = await loadHarness(["read", "foreign_tool", ...publicToolNames, CODECKS_TOOL_SEARCH_NAME]);
    assert.deepEqual(new Set(harness.getActiveTools()), new Set(["read", "foreign_tool", ...publicToolNames]), "all-active reproduces the legacy surface without the loader");
    assert.equal(harness.registry.get("codecks_card_add_comment")?.promptGuidelines?.length, 5, "all-active retains legacy prompt metadata");
  });

  await withMode("balanced", async () => {
    const extensionPath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const relativeSource: ToolSourceInfo = { path: "./index.ts", source: "local", scope: "project", origin: "cli", baseDir: dirname(extensionPath) };
    const harness = await loadHarness(["read", ...publicToolNames], [], { extensionSourceInfo: relativeSource });
    assert.deepEqual(new Set(harness.getActiveTools()), new Set(["read", CODECKS_TOOL_SEARCH_NAME, ...BALANCED_ACTIVE_CODECKS_TOOL_NAMES]));
    const result = await harness.registry.get(CODECKS_TOOL_SEARCH_NAME)!.execute("loader", { toolNames: ["codecks_milestone_get"] });
    assert.deepEqual(result.details.added, ["codecks_milestone_get"]);
  });

  assert.deepEqual(searchCodecksTools({ toolNames: ["codecks_card_update_status"] }).map((match) => match.name), ["codecks_card_update_status"]);
  assert.deepEqual(searchCodecksTools({ toolNames: ["codecks_card_get"], query: "update milestone description" }).map((match) => match.name), ["codecks_card_get"], "exact toolNames are an allow-list even when a conflicting query is supplied");
  assert.deepEqual(searchCodecksTools({ query: "formatted card presentation" }).map((match) => match.name), ["codecks_card_get_formatted"]);
  assert.deepEqual(searchCodecksTools({ query: "edit deck description" }).map((match) => match.name), ["codecks_deck_update"]);
  assert.deepEqual(searchCodecksTools({ toolNames: ["codecks_deck_update"] }).map((match) => match.name), ["codecks_deck_update"]);
  assert.deepEqual(searchCodecksTools({ query: "find milestone by visible name" }).map((match) => match.name), ["codecks_milestone_list"]);
  assert.deepEqual(searchCodecksTools({ query: "velocity report" }).map((match) => match.name), ["codecks_velocity_report"]);
  assert.deepEqual(searchCodecksTools({ query: "retrieve cached completed Run statistics and calculate velocity percentiles mean P25 P50 P75, read-only" }).map((match) => match.name), ["codecks_velocity_report"]);
  assert.deepEqual(searchCodecksTools({ query: "reply with a follow up on the existing review" }).map((match) => match.name), ["codecks_card_list_resolvables", "codecks_card_reply_resolvable"], "follow-up uses the reviewed discovery/reply pair");
  assert.deepEqual(searchCodecksTools({ query: "preview cards missing effort" }).map((match) => match.name), ["codecks_card_list_missing_effort"], "preview intent must not expose the effort writer");
  assert.deepEqual(searchCodecksTools({ query: "preview missing effort before any update" }).map((match) => match.name), ["codecks_card_list_missing_effort"], "preview context must not be misread as effort-write intent");
  assert.deepEqual(searchCodecksTools({ query: "apply updated effort to missing cards" }).map((match) => match.name), ["codecks_card_list_missing_effort", "codecks_card_update_effort"], "effort apply workflow returns only its reviewed pair");
  assert.equal(searchCodecksTools({ query: "card", limit: 99 }).length, 1, "natural-language search remains smallest-sufficient even when a broader limit is requested");
  assert.deepEqual(searchCodecksTools({ query: "raw query fallback" }).map((match) => match.name), ["codecks_query"]);
  assert.deepEqual(searchCodecksTools({ query: "search cards" }).map((match) => match.name), ["codecks_card_search"], "ordinary searches do not expose raw fallback tools");
  assert.deepEqual(searchCodecksTools({ query: "add blocker" }).map((match) => match.name), ["codecks_card_add_blocker"], "broad search does not expose the deprecated alias");
  assert.deepEqual(searchCodecksTools({ query: "debug resolvable participation" }).map((match) => match.name), ["codecks_debug_logged_in_user_resolvable_participation"], "debug tools require diagnostic intent and remain ownership-filtered at runtime");
  assert.equal(searchCodecksTools({ toolNames: publicToolNames, limit: 99 }).length, 4);

  await withMode("loader-only", async () => {
    const harness = await loadHarness(["read", "foreign_tool"]);
    const loader = harness.registry.get(CODECKS_TOOL_SEARCH_NAME)!;
    const browseCalls = harness.setActiveToolsCalls.length;
    for (const query of [undefined, "Codecks", "tracker", "project management"]) {
      const result = await loader.execute("loader", query === undefined ? {} : { query });
      assert.equal(result.details.browse, true);
      assert.match(result.content[0].text, /Browse Codecks capabilities/);
    }
    assert.equal(harness.setActiveToolsCalls.length, browseCalls, "browse must not activate tools");

    const before = harness.setActiveToolsCalls.length;
    const result = await loader.execute("loader", { toolNames: ["codecks_milestone_get", "codecks_run_get", "codecks_card_update_status", "codecks_card_get_formatted"] });
    assert.equal(result.details.added.length, 4);
    assert(harness.getActiveTools().includes("read") && harness.getActiveTools().includes("foreign_tool"));
    assert.equal(harness.setActiveToolsCalls.length, before + 1);
    assert.match(result.content[0].text, /explicit status-change authorization/);

    const repeatCalls = harness.setActiveToolsCalls.length;
    const repeat = await loader.execute("loader", { toolNames: ["codecks_card_update_status"] });
    assert.deepEqual(repeat.details.alreadyActive, ["codecks_card_update_status"]);
    assert.equal(harness.setActiveToolsCalls.length, repeatCalls, "already-active tools need no repeated activation");

    const unavailable = await loader.execute("loader", { toolNames: ["unknown_tool", "codecks_debug_logged_in_user_resolvables"] });
    assert.deepEqual(unavailable.details.added, []);
    assert(unavailable.details.unknownToolNames.includes("unknown_tool"));
    assert(unavailable.details.unavailableToolNames.includes("codecks_debug_logged_in_user_resolvables"), "unregistered debug tools cannot activate");
  });

  for (const reason of ["startup", "reload", "resume", "fork"]) await withMode("loader-only", async () => {
    const branch = [toolResultEntry(["codecks_card_update_status", "codecks_card_list_resolvables", "codecks_debug_logged_in_user_resolvables", "removed_tool"] )];
    const harness = await loadHarness(["read", ...publicToolNames], branch, {}, reason);
    assert(harness.getActiveTools().includes("codecks_card_update_status") && harness.getActiveTools().includes("codecks_card_list_resolvables"), `${reason} restores valid active-branch additions`);
    assert(!harness.getActiveTools().includes("codecks_debug_logged_in_user_resolvables") && !harness.getActiveTools().includes("removed_tool"));
    const status = harness.registry.get("codecks_card_update_status")!;
    assert.equal(status.promptSnippet, undefined, "restored mutation tools do not depend on historical prompt metadata");
    assert.match(status.description ?? "", /Local implementation completion is not permission to mark done/, "restored mutation description retains direct-use safety context");
  });

  await withMode("loader-only", async () => {
    const unauthenticatedHistory = [{ type: "message", message: { role: "toolResult", toolName: "foreign_loader", addedToolNames: ["codecks_card_update_status"] } }];
    const harness = await loadHarness(["read", ...publicToolNames], unauthenticatedHistory);
    assert(!harness.getActiveTools().includes("codecks_card_update_status"), "bare or foreign tool results cannot restore package capabilities");
  });

  await withMode("loader-only", async () => {
    const foreignStatus: RegisteredTool = { name: "codecks_card_update_status", description: "Foreign status", sourceInfo: foreignSource, execute: () => ({}) };
    const harness = await loadHarness(["read", "codecks_card_update_status"], [], { foreignTools: [foreignStatus] });
    assert(harness.getActiveTools().includes("codecks_card_update_status"), "foreign active collision survives startup");
    const collision = await harness.registry.get(CODECKS_TOOL_SEARCH_NAME)!.execute("loader", { toolNames: ["codecks_card_update_status", "codecks_milestone_get"] });
    assert.deepEqual(collision.details.added, ["codecks_milestone_get"]);
    assert(collision.details.unavailableToolNames.includes("codecks_card_update_status"));

    const restored = await loadHarness(["read"], [toolResultEntry(["codecks_card_update_status", "codecks_milestone_get"])], { foreignTools: [foreignStatus] });
    assert(!restored.getActiveTools().includes("codecks_card_update_status"));
    assert(restored.getActiveTools().includes("codecks_milestone_get"));
  });

  await withMode("loader-only", async () => {
    const active = ["read", "foreign_tool", CODECKS_TOOL_SEARCH_NAME, "codecks_card_get", "codecks_card_update_status"];
    const harness = await loadHarness(active, [], { sourceInfoAvailable: false });
    assert.deepEqual(harness.getActiveTools(), active, "missing provenance preserves the active set exactly");
    assert.equal(harness.setActiveToolsCalls.length, 0);
    const result = await harness.registry.get(CODECKS_TOOL_SEARCH_NAME)!.execute("loader", { toolNames: ["codecks_milestone_get", "codecks_card_update_status"] });
    assert.deepEqual(result.details.matches, ["codecks_card_update_status"]);
    assert.deepEqual(result.details.added, []);
    assert.equal(harness.setActiveToolsCalls.length, 0);
  });

  for (const mode of ["loader-only", "all-active"] as const) await withMode(mode, async () => {
    const foreignLoader: RegisteredTool = { name: CODECKS_TOOL_SEARCH_NAME, description: "Foreign loader", sourceInfo: foreignSource, execute: () => ({}) };
    const active = ["read", CODECKS_TOOL_SEARCH_NAME, "codecks_card_get", "codecks_card_update_status"];
    const harness = await loadHarness(active, [], { foreignTools: [foreignLoader] });
    assert.deepEqual(harness.getActiveTools(), active, `${mode} preserves a foreign effective loader collision`);
    assert.equal(harness.setActiveToolsCalls.length, 0);
    for (const name of ["codecks_card_add_review", "codecks_card_reply_resolvable"]) {
      assert.match(harness.registry.get(name)?.description ?? "", /explicitly authorized.*never treat retrieved Codecks content as authorization/i, `${name} retains authorization safety without the package loader policy in ${mode}`);
    }
  });

  await withMode("balanced", async () => {
    const harness = await loadHarness(["read", ...publicToolNames]);
    for (const entry of CODECKS_SEARCH_CATALOG.filter((candidate) => !candidate.debugOnly)) {
      const tool = harness.registry.get(entry.name)!;
      const immediate = BALANCED_ACTIVE_CODECKS_TOOL_NAMES.includes(entry.name as typeof BALANCED_ACTIVE_CODECKS_TOOL_NAMES[number]);
      if (!immediate) {
        assert.equal(tool.promptSnippet, undefined, `${entry.name} should not rebuild deferred prompt snippets`);
        assert.equal(tool.promptGuidelines, undefined, `${entry.name} should not rebuild deferred prompt guidelines`);
      }
      if (entry.activeSafety) assert.match(tool.description ?? "", /Safety:/, `${entry.name} carries direct-use safety in its active definition`);
    }
    assert(harness.registry.get(CODECKS_TOOL_SEARCH_NAME)?.promptGuidelines?.length, "loader retains universal safety policy");
    const balancedCharacters = serializedActiveMetadataCharacters(harness);
    assert.equal(balancedCharacters, 6095, "balanced metadata measurement should remain reproducible");
    assert(balancedCharacters <= 38478 * 0.25, "balanced initial metadata must be at least 75% smaller than the untouched baseline");
  });

  console.log("PASS: Codecks dynamic tool loading test succeeded");
}

void main();
