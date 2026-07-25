import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Condition = "all-active" | "balanced" | "loader-only";
type JsonObject = Record<string, unknown>;
type Execution = "read-only" | "preflight-only" | "prohibited";
type EvalCase = {
  id: string;
  category: string;
  prompt: string;
  expectedOutcome: string;
  requiredExecutedTools: string[];
  permittedActivatedNames: string[];
  forbiddenTools: string[];
  execution: Execution;
  maxLoaderCalls: number;
  maxToolCalls: number;
  passCriteria: string[];
};
type EvalConfig = { piVersionPrefix: string; timeoutMs: number; maxOutputChars: number; conditions: Condition[]; mutationTools: string[] };
type Options = { trials: number; conditions: Condition[]; caseIds: string[]; model?: string; keep: boolean; includeEvents: boolean; dryRun: boolean };

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const RESULTS_DIR = join(HERE, "results");
const LOADER = "codecks_tool_search";
const MODEL_PATTERN = /^openai-codex\/gpt-5\.6-(luna|terra|sol)(:(off|minimal|low|medium|high|xhigh|max))?$/;
const ACTIVE_BY_CONDITION: Record<Condition, readonly string[]> = {
  "all-active": ["*"],
  balanced: [LOADER, "codecks_card_get", "codecks_card_search"],
  "loader-only": [LOADER],
};
const EXPECTED_MUTATION_TOOLS = [
  "codecks_dispatch", "codecks_card_create", "codecks_card_set_parent", "codecks_card_add_attachment", "codecks_card_update",
  "codecks_card_bulk_create", "codecks_card_bulk_update", "codecks_card_update_effort", "codecks_card_update_status", "codecks_card_update_priority",
  "codecks_milestone_update", "codecks_run_update", "codecks_card_update_run", "codecks_card_add_comment", "codecks_card_add_review",
  "codecks_card_add_blocker", "codecks_card_add_block", "codecks_card_reply_resolvable", "codecks_card_edit_resolvable_entry",
  "codecks_card_close_resolvable", "codecks_card_reopen_resolvable",
];

function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }
function fail(message: string): never { throw new Error(message); }
function csv(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value) => right.includes(value)); }
function timestamp(): string { return new Date().toISOString().replace(/[:.]/g, "-"); }

function usage(): string {
  return `Usage: npx tsx evals/tool-loading/run-eval.ts --model openai-codex/gpt-5.6-luna[:thinking] [options]

Options:
  --trials <1..5>                 Sequential fresh Pi subprocesses (default: 1)
  --condition <name[,name]>       all-active, balanced, loader-only (default: all)
  --cases <id[,id]>               Case IDs from cases.json (default: all)
  --model <provider/model>        Required for live runs; GPT-5.6 Codex family only
  --keep                          Keep temporary raw provider captures
  --include-events                Include sanitized event crumbs in the report
  --dry-run                       Validate files and print the subprocess plan only
  --help                          Show this help`;
}

function parseOptions(argv: string[]): Options {
  const options: Options = { trials: 1, conditions: ["all-active", "balanced", "loader-only"], caseIds: [], keep: false, includeEvents: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? fail(`Missing value for ${arg}`);
    if (arg === "--help" || arg === "-h") { console.log(usage()); process.exit(0); }
    else if (arg === "--trials") options.trials = Number(next());
    else if (arg === "--condition") options.conditions = csv(next()) as Condition[];
    else if (arg === "--cases") options.caseIds = csv(next());
    else if (arg === "--model") options.model = next();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--include-events") options.includeEvents = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else fail(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 5) fail("--trials must be an integer from 1 through 5");
  return options;
}

function validate(config: EvalConfig, cases: EvalCase[], baseline: JsonObject, options: Options): void {
  if (config.piVersionPrefix !== "0.82.") fail("config must pin the validated Pi 0.82 patch line");
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0 || !Number.isInteger(config.maxOutputChars) || config.maxOutputChars <= 0) fail("invalid numeric config bounds");
  if (!sameSet(config.conditions, ["all-active", "balanced", "loader-only"])) fail("config must declare all three loading conditions");
  if (!sameSet(config.mutationTools, EXPECTED_MUTATION_TOOLS)) fail("config mutationTools must list every package-exposed Codecks mutation exactly once");
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (!testCase.id || ids.has(testCase.id) || !testCase.category || !testCase.prompt || !testCase.expectedOutcome) fail("invalid or duplicate eval case");
    if (!Array.isArray(testCase.requiredExecutedTools) || !Array.isArray(testCase.permittedActivatedNames) || !Array.isArray(testCase.forbiddenTools) || !Array.isArray(testCase.passCriteria)) fail(`invalid tool fields in ${testCase.id}`);
    if (!new Set(testCase.permittedActivatedNames).size && testCase.requiredExecutedTools.length) fail(`execution case ${testCase.id} must permit its activated capability`);
    if (!Number.isInteger(testCase.maxLoaderCalls) || testCase.maxLoaderCalls < 0 || !Number.isInteger(testCase.maxToolCalls) || testCase.maxToolCalls < 0 || !["read-only", "preflight-only", "prohibited"].includes(testCase.execution)) fail(`invalid bounds in ${testCase.id}`);
    ids.add(testCase.id);
  }
  for (const condition of options.conditions) if (!config.conditions.includes(condition)) fail(`unknown condition: ${condition}`);
  for (const id of options.caseIds) if (!ids.has(id)) fail(`unknown case: ${id}`);
  const legacy = baseline.legacyBaseline as JsonObject | undefined;
  if (legacy?.toolCount !== 39 || legacy.schemaChars !== 14500 || legacy.descriptionChars !== 2749 || legacy.promptSnippetChars !== 1972 || legacy.promptGuidelineChars !== 13651 || legacy.completeSerializedMetadataChars !== 38478) fail("baseline.json does not match the required untouched 39-tool measurement");
}

function initiallyActive(condition: Condition, tool: string): boolean { return ACTIVE_BY_CONDITION[condition].includes("*") || ACTIVE_BY_CONDITION[condition].includes(tool); }
function expectedLoaderCalls(condition: Condition, testCase: EvalCase): number {
  if (testCase.permittedActivatedNames.length === 0) return 0;
  return testCase.permittedActivatedNames.some((tool) => !initiallyActive(condition, tool)) ? 1 : 0;
}
function expectedInitialToolCount(condition: Condition): number {
  if (condition === "all-active") return 39;
  if (condition === "balanced") return 3;
  return 1;
}

function findTools(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) { for (const item of payload) { const found = findTools(item); if (found) return found; } return undefined; }
  if (!payload || typeof payload !== "object") return undefined;
  const object = payload as JsonObject;
  if (Array.isArray(object.tools)) return object.tools;
  for (const value of Object.values(object)) { const found = findTools(value); if (found) return found; }
  return undefined;
}
function nativeMarkers(value: unknown, marks = { toolSearchCall: 0, toolSearchOutput: 0 }): typeof marks {
  if (Array.isArray(value)) for (const item of value) nativeMarkers(item, marks);
  else if (value && typeof value === "object") {
    const object = value as JsonObject;
    if (object.type === "tool_search_call") marks.toolSearchCall += 1;
    if (object.type === "tool_search_output") marks.toolSearchOutput += 1;
    for (const item of Object.values(object)) nativeMarkers(item, marks);
  }
  return marks;
}
function parseCapture(path: string): { providerRequests: number; initialToolCount?: number; initialToolSerializedChars?: number; native: { toolSearchCall: number; toolSearchOutput: number }; parseErrors: number } {
  const result = { providerRequests: 0, initialToolCount: undefined as number | undefined, initialToolSerializedChars: undefined as number | undefined, native: { toolSearchCall: 0, toolSearchOutput: 0 }, parseErrors: 0 };
  if (!existsSync(path)) return result;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)) {
    try {
      const payload = (JSON.parse(line) as { payload?: unknown }).payload;
      result.providerRequests += 1;
      if (result.initialToolCount === undefined) {
        const tools = findTools(payload);
        if (tools) { result.initialToolCount = tools.length; result.initialToolSerializedChars = JSON.stringify(tools).length; }
      }
      const marks = nativeMarkers(payload);
      result.native.toolSearchCall += marks.toolSearchCall;
      result.native.toolSearchOutput += marks.toolSearchOutput;
    } catch { result.parseErrors += 1; }
  }
  return result;
}

async function runProcess(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, maxOutputChars: number): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; outputLimitExceeded: boolean; wallTimeMs: number }> {
  const started = performance.now();
  return await new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd: PACKAGE_ROOT, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = ""; let stderr = ""; let timedOut = false; let outputLimitExceeded = false; let settled = false;
    const terminate = () => { if (process.platform === "win32" && child.pid) spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else child.kill("SIGTERM"); };
    const finish = (exitCode: number | null) => { if (settled) return; settled = true; clearTimeout(timer); done({ stdout, stderr, exitCode, timedOut, outputLimitExceeded, wallTimeMs: Math.round(performance.now() - started) }); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    const collect = (target: "stdout" | "stderr") => (chunk: Buffer) => { const text = chunk.toString("utf8"); if (target === "stdout") stdout += text; else stderr += text; if (stdout.length + stderr.length > maxOutputChars && !outputLimitExceeded) { outputLimitExceeded = true; terminate(); } };
    child.stdout.on("data", collect("stdout")); child.stderr.on("data", collect("stderr")); child.once("error", () => finish(null)); child.once("close", finish);
  });
}

function sanitizeEvent(event: JsonObject): JsonObject {
  const result: JsonObject = { type: event.type };
  if (typeof event.toolName === "string") result.toolName = event.toolName;
  if (typeof event.isError === "boolean") result.isError = event.isError;
  return result;
}

function parseTrial(processResult: Awaited<ReturnType<typeof runProcess>>, capturePath: string, condition: Condition, testCase: EvalCase, config: EvalConfig, includeEvents: boolean): JsonObject {
  const toolCalls: string[] = []; const activated: string[] = []; const toolErrors: string[] = []; const events: JsonObject[] = [];
  let invalidJsonLines = 0; let assistantErrors = 0;
  for (const line of processResult.stdout.split(/\r?\n/).filter(Boolean)) {
    let event: JsonObject;
    try { event = JSON.parse(line) as JsonObject; } catch { invalidJsonLines += 1; continue; }
    if (includeEvents) events.push(sanitizeEvent(event));
    if (event.type === "tool_execution_start" && typeof event.toolName === "string") toolCalls.push(event.toolName);
    if (event.type === "tool_execution_end") {
      if (event.isError === true && typeof event.toolName === "string") toolErrors.push(event.toolName);
      const details = ((event.result as JsonObject | undefined)?.details as JsonObject | undefined);
      if (Array.isArray(details?.added)) activated.push(...details.added.filter((name): name is string => typeof name === "string"));
    }
    if (event.type === "message_end") {
      const message = event.message as JsonObject | undefined;
      if (message?.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage.length) assistantErrors += 1;
    }
  }
  const counts = Object.fromEntries([...new Set(toolCalls)].map((tool) => [tool, toolCalls.filter((call) => call === tool).length]));
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];
  const loaderExpected = expectedLoaderCalls(condition, testCase);
  for (const tool of testCase.requiredExecutedTools) checks.push({ name: `required:${tool}`, pass: counts[tool] === 1, detail: `observed ${counts[tool] ?? 0}` });
  checks.push({ name: "outcome-capability", pass: testCase.requiredExecutedTools.every((tool) => counts[tool] === 1), detail: testCase.expectedOutcome });
  for (const tool of testCase.forbiddenTools) checks.push({ name: `forbidden:${tool}`, pass: !counts[tool], detail: `observed ${counts[tool] ?? 0}` });
  checks.push({ name: "loader-count", pass: (counts[LOADER] ?? 0) === loaderExpected, detail: `expected ${loaderExpected}, observed ${counts[LOADER] ?? 0}` });
  checks.push({ name: "loader-bound", pass: (counts[LOADER] ?? 0) <= testCase.maxLoaderCalls, detail: `${counts[LOADER] ?? 0}/${testCase.maxLoaderCalls}` });
  const actualActivated = [...new Set(activated)];
  const expectedActivated = loaderExpected ? testCase.permittedActivatedNames.filter((tool) => !initiallyActive(condition, tool)) : [];
  checks.push({ name: "exact-permitted-activation", pass: sameSet(actualActivated, expectedActivated), detail: `expected ${expectedActivated.join(", ") || "none"}; observed ${actualActivated.join(", ") || "none"}` });
  const mutationCalls = toolCalls.filter((tool) => config.mutationTools.includes(tool));
  checks.push({ name: "mutation-guard", pass: mutationCalls.length === 0, detail: mutationCalls.join(", ") || "no mutation call" });
  if (testCase.execution === "prohibited") checks.push({ name: "prohibited-execution", pass: toolCalls.every((tool) => tool === LOADER), detail: toolCalls.join(", ") || "none" });
  const codecksCalls = toolCalls.filter((tool) => tool.startsWith("codecks_"));
  checks.push({ name: "case-tool-bound", pass: codecksCalls.length <= testCase.maxToolCalls, detail: `${codecksCalls.length}/${testCase.maxToolCalls}` });
  const capture = parseCapture(capturePath);
  const markerPairs = Math.min(capture.native.toolSearchCall, capture.native.toolSearchOutput);
  checks.push({ name: "provider-initial-tool-composition", pass: capture.initialToolCount === expectedInitialToolCount(condition), detail: `expected ${expectedInitialToolCount(condition)}, observed ${capture.initialToolCount ?? "missing"}` });
  checks.push({ name: "native-deferred-markers", pass: loaderExpected ? markerPairs >= 1 : markerPairs === 0, detail: `call=${capture.native.toolSearchCall}, output=${capture.native.toolSearchOutput}` });
  checks.push({ name: "no-tool-errors", pass: toolErrors.length === 0, detail: toolErrors.join(", ") || "none" });
  checks.push({ name: "no-assistant-errors", pass: assistantErrors === 0, detail: String(assistantErrors) });
  checks.push({ name: "not-timed-out", pass: !processResult.timedOut, detail: `${processResult.wallTimeMs}ms` });
  checks.push({ name: "bounded-output", pass: !processResult.outputLimitExceeded, detail: `${processResult.stdout.length + processResult.stderr.length}/${config.maxOutputChars}` });
  checks.push({ name: "process-exit", pass: processResult.exitCode === 0, detail: String(processResult.exitCode) });
  checks.push({ name: "clean-jsonl", pass: invalidJsonLines === 0, detail: String(invalidJsonLines) });
  return { condition, caseId: testCase.id, category: testCase.category, execution: testCase.execution, pass: checks.every((check) => check.pass), checks, wallTimeMs: processResult.wallTimeMs, exitCode: processResult.exitCode, timedOut: processResult.timedOut, toolCalls, toolCallCounts: counts, activated: actualActivated, providerRequests: capture.providerRequests, initialToolSchema: { toolCount: capture.initialToolCount, serializedChars: capture.initialToolSerializedChars }, nativeToolSearch: capture.native, captureParseErrors: capture.parseErrors, ...(includeEvents ? { events } : {}) };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const config = readJson<EvalConfig>(join(HERE, "config.json"));
  const cases = readJson<{ cases: EvalCase[] }>(join(HERE, "cases.json")).cases;
  const baseline = readJson<JsonObject>(join(HERE, "baseline.json"));
  validate(config, cases, baseline, options);
  const selected = options.caseIds.length ? cases.filter((testCase) => options.caseIds.includes(testCase.id)) : cases;
  if (!options.dryRun && !options.model) fail("--model is required for a live model evaluation");
  if (options.model && !MODEL_PATTERN.test(options.model)) fail("--model must be an approved openai-codex/gpt-5.6-(luna|terra|sol), optionally with a supported thinking level");
  const piCli = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const baseArgs = [piCli, "--mode", "json", "--no-session", "--no-approve", "--no-context-files", "--no-extensions", "-e", join(PACKAGE_ROOT, "index.ts"), "-e", join(HERE, "mutation-guard.ts"), "-e", join(HERE, "provider-capture.ts"), "--no-skills", "--no-prompt-templates", "--no-builtin-tools"];
  if (options.dryRun) {
    console.log(`VALID: ${selected.length} cases × ${options.conditions.length} conditions × ${options.trials} fresh trial(s)`);
    console.log(`Pi subprocess: ${process.execPath} ${baseArgs.join(" ")} --model <approved-gpt-5.6> <case-prompt>`);
    console.log("Live runs are read-only by design; eval mutation-guard.ts blocks every Codecks mutation before tool execution.");
    return;
  }
  if (!existsSync(piCli)) fail(`Pi CLI is missing from this worktree: ${piCli}`);
  const piVersionPath = join(PACKAGE_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "package.json");
  const piVersion = existsSync(piVersionPath) ? (readJson<{ version?: string }>(piVersionPath).version ?? "unknown") : "missing";
  if (!piVersion.startsWith(config.piVersionPrefix)) fail(`this eval requires Pi ${config.piVersionPrefix}x; found ${piVersion}`);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const trials: JsonObject[] = [];
  for (const condition of options.conditions) for (const testCase of selected) for (let trial = 1; trial <= options.trials; trial += 1) {
    const capturePath = join(tmpdir(), `pi-codecks-tool-loading-${process.pid}-${Date.now()}-${condition}-${testCase.id}-${trial}.jsonl`);
    const processResult = await runProcess([...baseArgs, "--model", options.model!, testCase.prompt], { ...process.env, PI_CODECKS_TOOL_LOADING_MODE: condition, PI_CODECKS_EVAL_PROVIDER_CAPTURE: capturePath }, config.timeoutMs, config.maxOutputChars);
    const summary = parseTrial(processResult, capturePath, condition, testCase, config, options.includeEvents);
    if (options.keep) summary.rawCapturePath = capturePath; else rmSync(capturePath, { force: true });
    trials.push({ trial, ...summary });
    console.log(`${condition} ${testCase.id} #${trial}: ${summary.pass ? "PASS" : "FAIL"} (${summary.wallTimeMs}ms)`);
  }
  const passed = trials.filter((trial) => trial.pass === true).length;
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), model: options.model, baseline, options: { trials: options.trials, conditions: options.conditions, cases: selected.map((testCase) => testCase.id), rawCapturesKept: options.keep, includeEvents: options.includeEvents }, aggregate: { trials: trials.length, passed, failed: trials.length - passed }, trials };
  const reportPath = join(RESULTS_DIR, `tool-loading-${timestamp()}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Aggregate: ${passed}/${trials.length} passed; sanitized summary: ${reportPath}`);
  if (passed !== trials.length) process.exitCode = 1;
}

void main().catch((error: unknown) => { console.error(error instanceof Error ? `ERROR: ${error.message}` : "ERROR: evaluation failed"); process.exitCode = 1; });
