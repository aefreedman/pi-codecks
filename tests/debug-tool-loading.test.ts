import assert from "node:assert/strict";

process.env.CODECKS_ENABLE_DEBUG_TOOLS = "1";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "loader-only";

const { PiToolHarness } = await import("./pi-tool-harness.ts");
const {
  CODECKS_TOOL_SEARCH_NAME,
  DEBUG_CODECKS_TOOL_NAMES,
  DEFAULT_CODECKS_TOOL_NAMES,
} = await import("../src/codecks-tool-loading.ts");

const debugNames = [...DEBUG_CODECKS_TOOL_NAMES];
const harness = new PiToolHarness({ activeTools: [...DEFAULT_CODECKS_TOOL_NAMES, ...debugNames] });
await harness.load();
await harness.startSession();

assert.equal(harness.registry.size, 42, "debug opt-in registers the 39 default tools, two debug tools, and loader");
assert(debugNames.every((name) => harness.registry.has(name)), "both opt-in debug definitions should be registered");
assert.deepEqual(new Set(harness.getActiveTools()), new Set([CODECKS_TOOL_SEARCH_NAME]), "loader-only defers opt-in debug tools like ordinary deferred tools");

const loader = harness.registry.get(CODECKS_TOOL_SEARCH_NAME)!;
const result = await loader.execute("debug-loader", { query: "diagnostic logged in user resolvables", toolNames: [debugNames[1]] });
assert.deepEqual(result.details.added, [debugNames[1]], "an explicitly requested registered diagnostic tool can activate");
assert(harness.getActiveTools().includes(debugNames[1]));

console.log("PASS: Codecks debug dynamic registration test succeeded");
