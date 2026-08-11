import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCustomCheck, type CheckContext } from "./checks.ts";

type Condition = "available" | "baseline" | "forced";
type EvalConfig = {
  version: 1;
  skillName: string;
  skillPath: string;
  extensionPaths: string[];
  allowExtensionExecution: boolean;
  tools: string[];
  allowHostMutation: boolean;
  conditions: Condition[];
  trials: number;
  timeoutMs: number;
  maxToolCalls: number;
};
type PromptKind = "explicit" | "implicit" | "contextual" | "negative-control";
type EvalCase = { id: string; prompt: string; fixture: string; prompt_kind?: PromptKind; should_trigger: boolean; expected_checks: string[] };
type Snapshot = Record<string, string>;
type DimensionName = "triggering" | "behavior" | "efficiency" | "infrastructure";

const TRIGGER_CHECKS = new Set(["skill_loaded", "skill_not_loaded"]);
const EFFICIENCY_CHECKS = new Set(["bounded_tool_calls", "avoids_unnecessary_artifact_read"]);
const INFRASTRUCTURE_CHECKS = new Set(["answer_not_empty", "no_files_changed", "some_file_changed", "no_tool_errors"]);
const checkDimension = (checkId: string): DimensionName => TRIGGER_CHECKS.has(checkId) ? "triggering" : EFFICIENCY_CHECKS.has(checkId) ? "efficiency" : INFRASTRUCTURE_CHECKS.has(checkId) ? "infrastructure" : "behavior";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(join(here, "eval.config.json"), "utf8")) as EvalConfig;
const cases = JSON.parse(await readFile(join(here, "cases.json"), "utf8")) as EvalCase[];
const supportedConditions = new Set<Condition>(["available", "baseline", "forced"]);
if (config.version !== 1) throw new Error(`Unsupported eval config version: ${String(config.version)}`);
if (typeof config.skillName !== "string" || !config.skillName.trim() || typeof config.skillPath !== "string" || !config.skillPath.trim()) throw new Error("skillName and skillPath are required strings");
if (!Array.isArray(config.extensionPaths) || config.extensionPaths.some((item) => typeof item !== "string") || new Set(config.extensionPaths).size !== config.extensionPaths.length) throw new Error("extensionPaths must contain unique strings");
if (typeof config.allowExtensionExecution !== "boolean" || typeof config.allowHostMutation !== "boolean") throw new Error("authorization fields must be booleans");
if (!Array.isArray(config.tools) || config.tools.length === 0 || config.tools.some((item) => typeof item !== "string" || !item.trim()) || new Set(config.tools).size !== config.tools.length) throw new Error("tools must contain unique non-empty strings");
if (!Array.isArray(config.conditions) || config.conditions.length === 0 || new Set(config.conditions).size !== config.conditions.length || config.conditions.some((item) => !supportedConditions.has(item))) throw new Error("conditions must contain unique supported values");
if (!Number.isInteger(config.trials) || config.trials < 1 || config.trials > 5) throw new Error("trials must be between 1 and 5");
if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 3_600_000) throw new Error("timeoutMs must be between 1000 and 3600000");
if (!Number.isInteger(config.maxToolCalls) || config.maxToolCalls < 1) throw new Error("maxToolCalls must be positive");
if (!Array.isArray(cases) || cases.length === 0) throw new Error("cases.json must contain at least one case");
const caseIds = new Set<string>();
for (const item of cases) {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(item.id) || caseIds.has(item.id)) throw new Error(`Invalid or duplicate case id: ${String(item.id)}`);
  caseIds.add(item.id);
  if (!item.prompt?.trim() || !item.fixture?.trim() || isAbsolute(item.fixture) || item.fixture.split(/[\\/]/).includes("..") || typeof item.should_trigger !== "boolean" || !Array.isArray(item.expected_checks) || item.expected_checks.length === 0 || item.expected_checks.some((check) => typeof check !== "string" || !check.trim()) || new Set(item.expected_checks).size !== item.expected_checks.length) throw new Error(`Invalid case definition: ${item.id}`);
  if (item.prompt_kind && !["explicit", "implicit", "contextual", "negative-control"].includes(item.prompt_kind)) throw new Error(`Invalid prompt_kind for case ${item.id}`);
  if (item.prompt_kind && (item.prompt_kind === "negative-control") !== !item.should_trigger) throw new Error(`prompt_kind and should_trigger disagree for case ${item.id}`);
  if (!existsSync(join(here, "fixtures", item.fixture))) throw new Error(`Missing fixture for case ${item.id}: ${item.fixture}`);
}
if (config.extensionPaths.length > 0 && !config.allowExtensionExecution) throw new Error("Extension execution is not authorized by eval.config.json");
if (config.tools.some((tool) => ["bash", "edit", "write"].includes(tool)) && !config.allowHostMutation) throw new Error("Host mutation tools are not authorized by eval.config.json");

function resolvePiCliPath(): string {
  const candidates = [
    process.env.PI_CLI_PATH,
    process.env.APPDATA && join(process.env.APPDATA, "npm/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    process.env.npm_config_prefix && join(process.env.npm_config_prefix, "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    join(dirname(process.execPath), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  ].filter((value): value is string => Boolean(value));
  const match = candidates.find(existsSync);
  if (!match) throw new Error("Could not resolve Pi CLI. Set PI_CLI_PATH to the Pi dist/cli.js file.");
  return match;
}

function parseArgs(args: string[]) {
  let trials = config.trials;
  let selectedConditions = config.conditions;
  let caseIds: string[] = [];
  let model: string | undefined;
  let keep = false;
  let includeRaw = false;
  let includeEvents = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--trials") trials = Number(args[++index]);
    else if (value === "--condition") {
      const requested = args[++index];
      selectedConditions = requested === "all" ? config.conditions : [requested as Condition];
    } else if (value === "--cases") caseIds = args[++index].split(",").filter(Boolean);
    else if (value === "--model") model = args[++index];
    else if (value === "--keep") keep = true;
    else if (value === "--include-raw") includeRaw = true;
    else if (value === "--include-events") includeEvents = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(trials) || trials < 1 || trials > 5) throw new Error("--trials must be between 1 and 5");
  if (new Set(selectedConditions).size !== selectedConditions.length) throw new Error("Duplicate conditions are not allowed");
  for (const condition of selectedConditions) if (!supportedConditions.has(condition) || !config.conditions.includes(condition)) throw new Error(`Condition is not enabled: ${condition}`);
  return { trials, selectedConditions, caseIds, model, keep, includeRaw, includeEvents };
}

async function walk(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await walk(root, full));
    else if (entry.isFile()) result.push(full);
  }
  return result;
}

async function snapshot(root: string): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const path of await walk(root)) {
    const content = await readFile(path);
    result[relative(root, path).replaceAll("\\", "/")] = createHash("sha256").update(content).digest("hex");
  }
  return result;
}

function changedPaths(before: Snapshot, after: Snapshot): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((path) => before[path] !== after[path]).sort();
}

function assistantText(message: any): string {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("");
}

function sameAssistant(left: any, right: any): boolean {
  if (left?.role !== "assistant" || right?.role !== "assistant") return false;
  if (left.responseId && right.responseId) return left.responseId === right.responseId;
  return left.stopReason === right.stopReason && assistantText(left) === assistantText(right);
}

function validateEventLifecycle(events: any[]): boolean {
  if (events.length === 0 || events[0]?.type !== "session" || events[0].version !== 3) return false;
  let agentOpen = false;
  let turnOpen = false;
  let messageRole: string | undefined;
  let agentStarts = 0;
  let settledCount = 0;
  const activeTools = new Set<string>();
  const completedTools = new Set<string>();
  let finalAssistant: any;
  let finalTurnMessage: any;
  let finalAgentMessages: any[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const event = events[index];
    if (!event || typeof event !== "object" || typeof event.type !== "string" || settledCount > 0) return false;
    switch (event.type) {
      case "session": return false;
      case "agent_start":
        if (agentOpen || turnOpen || messageRole || activeTools.size > 0) return false;
        agentOpen = true; agentStarts += 1; break;
      case "turn_start":
        if (!agentOpen || turnOpen || messageRole) return false;
        turnOpen = true; break;
      case "message_start":
        if (!agentOpen || !turnOpen || messageRole || typeof event.message?.role !== "string") return false;
        messageRole = event.message.role; break;
      case "message_end":
        if (!agentOpen || !turnOpen || !messageRole || event.message?.role !== messageRole) return false;
        if (event.message.role === "assistant") finalAssistant = event.message;
        messageRole = undefined; break;
      case "tool_execution_start":
        if (!agentOpen || !turnOpen || typeof event.toolCallId !== "string" || activeTools.has(event.toolCallId) || completedTools.has(event.toolCallId)) return false;
        activeTools.add(event.toolCallId); break;
      case "tool_execution_update":
        if (!activeTools.has(event.toolCallId)) return false;
        break;
      case "tool_execution_end":
        if (!activeTools.delete(event.toolCallId)) return false;
        completedTools.add(event.toolCallId); break;
      case "turn_end":
        if (!agentOpen || !turnOpen || messageRole || activeTools.size > 0 || event.message?.role !== "assistant") return false;
        finalTurnMessage = event.message; turnOpen = false; break;
      case "agent_end":
        if (!agentOpen || turnOpen || messageRole || activeTools.size > 0 || !Array.isArray(event.messages)) return false;
        finalAgentMessages = event.messages; agentOpen = false; break;
      case "agent_settled":
        if (agentOpen || turnOpen || messageRole || activeTools.size > 0 || index !== events.length - 1) return false;
        settledCount += 1; break;
      default:
        break;
    }
  }
  return agentStarts > 0 && settledCount === 1 && Boolean(finalAssistant)
    && sameAssistant(finalAssistant, finalTurnMessage)
    && finalAgentMessages.some((message) => sameAssistant(finalAssistant, message));
}

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise<void>((resolveKill) => killer.on("close", () => resolveKill()));
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  try { process.kill(-child.pid, "SIGKILL"); } catch { if (child.exitCode === null) child.kill("SIGKILL"); }
}

async function runTrial(testCase: EvalCase, condition: Condition, trial: number, options: ReturnType<typeof parseArgs>) {
  const workspace = await mkdtemp(join(tmpdir(), `pi-skill-eval-${testCase.id}-${condition}-${trial}-`));
  try {
  await cp(join(here, "fixtures", testCase.fixture), workspace, { recursive: true });
  const before = await snapshot(workspace);
  const skillPath = resolve(here, config.skillPath);
  const args = ["--mode", "json", "--no-session", "--no-approve", "--no-context-files", "--no-extensions"];
  for (const extension of config.extensionPaths) args.push("--extension", resolve(here, extension));
  args.push("--no-skills");
  if (condition !== "baseline") args.push("--skill", skillPath);
  args.push("--tools", config.tools.join(","));
  if (options.model) args.push("--model", options.model);
  const prompt = condition === "forced" ? `/skill:${config.skillName} ${testCase.prompt}` : testCase.prompt;
  args.push(prompt);

  const started = Date.now();
  const child = spawn(process.execPath, [resolvePiCliPath(), ...args], {
    cwd: workspace,
    windowsHide: true,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let outputOverflow = false;
  let timedOut = false;
  let termination: Promise<void> | undefined;
  const maxCapturedBytes = 2 * 1024 * 1024;
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", (chunk) => {
    if (stdout.length + chunk.length > maxCapturedBytes) { outputOverflow = true; termination ??= terminate(child); return; }
    stdout += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    if (stderr.length + chunk.length > maxCapturedBytes) { outputOverflow = true; termination ??= terminate(child); return; }
    stderr += chunk;
  });
  const timeout = setTimeout(() => { timedOut = true; termination = terminate(child); }, config.timeoutMs);
  const exitCode = await new Promise<number | null>((resolveExit) => child.on("close", resolveExit));
  clearTimeout(timeout);
  if (termination) await termination;

  let malformedEventLines = 0;
  const events = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { malformedEventLines += 1; return []; }
  });
  const toolCalls = events.filter((event: any) => event.type === "tool_execution_start").map((event: any) => ({ name: String(event.toolName), args: event.args }));
  const toolErrors = events.filter((event: any) => event.type === "tool_execution_end" && event.isError).length;
  const assistantEnds = events.filter((event: any) => event.type === "message_end" && event.message?.role === "assistant");
  const finalAssistant = assistantEnds.at(-1)?.message;
  const answer = assistantText(finalAssistant);
  const streamValid = malformedEventLines === 0 && finalAssistant?.stopReason === "stop" && validateEventLifecycle(events);
  const usage = assistantEnds.at(-1)?.message?.usage ?? {};
  const after = await snapshot(workspace);
  const changes = changedPaths(before, after);
  const skillMarker = skillPath.replaceAll("\\", "/");
  const skillLoaded = condition === "forced" || toolCalls.some((call: any) => {
    if (call.name !== "read") return false;
    const args = JSON.stringify(call.args).replaceAll("\\", "/");
    return args.includes(skillMarker) || args.includes(`/${config.skillName}/SKILL.md`);
  });
  const context: CheckContext = { answer, guidance: "", changedPaths: changes, toolCalls, toolErrors, condition, skillLoaded, auditRoot: workspace };

  const evaluate = (checkId: string): boolean | null => {
    if (checkId === "skill_loaded") return condition === "baseline" ? null : skillLoaded;
    if (checkId === "skill_not_loaded") return condition === "baseline" || condition === "forced" ? null : !skillLoaded;
    if (checkId === "answer_not_empty") return answer.trim().length > 0;
    if (checkId === "no_files_changed") return changes.length === 0;
    if (checkId === "some_file_changed") return changes.length > 0;
    if (checkId === "bounded_tool_calls") return toolCalls.length <= config.maxToolCalls;
    if (checkId === "no_tool_errors") return toolErrors === 0;
    const custom = evaluateCustomCheck(checkId, context);
    if (custom === undefined) throw new Error(`Unknown check id: ${checkId}`);
    return custom;
  };
  const checks = Object.fromEntries(testCase.expected_checks.map((check) => [check, evaluate(check)]));
  const executionHealthy = exitCode === 0 && !timedOut && !outputOverflow && streamValid;
  const dimensions = Object.fromEntries((["triggering", "behavior", "efficiency", "infrastructure"] as DimensionName[]).map((dimension) => {
    const entries = Object.entries(checks).filter(([checkId, value]) => checkDimension(checkId) === dimension && value !== null);
    const passed = entries.filter(([, value]) => value === true).length;
    return [dimension, { passed, total: entries.length, complete: entries.length === 0 ? null : passed === entries.length, checks: Object.fromEntries(entries) }];
  }));
  const workflowDimensions = [dimensions.behavior, dimensions.efficiency, dimensions.infrastructure].filter((dimension) => dimension.total > 0);
  const workflowPassed = executionHealthy && workflowDimensions.length > 0 && workflowDimensions.every((dimension) => dimension.complete === true);
  const negativeControlPassed = executionHealthy && dimensions.triggering.complete === true && [dimensions.efficiency, dimensions.infrastructure].filter((dimension) => dimension.total > 0).every((dimension) => dimension.complete === true);
  const result = {
    id: testCase.id,
    condition,
    trial,
    shouldTrigger: testCase.should_trigger,
    promptKind: testCase.prompt_kind,
    passed: testCase.should_trigger ? workflowPassed : negativeControlPassed,
    triggerPassed: dimensions.triggering.complete,
    checks,
    dimensions,
    observations: { skillLoaded, toolErrors, timedOut, outputOverflow, streamValid, malformedEventLines, stopReason: finalAssistant?.stopReason },
    metrics: {
      durationMs: Date.now() - started,
      toolCalls: toolCalls.length,
      changedPaths: changes,
      exitCode,
      usage: { input: usage.input ?? 0, output: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0, cost: usage.cost?.total ?? 0 },
    },
    ...(options.includeRaw ? { answer: answer.slice(0, 20_000), stderr: stderr.slice(-4_000) } : {}),
    ...(options.includeEvents ? { eventTraceJsonl: stdout.slice(0, 200_000) } : {}),
    workspace: options.keep ? workspace : undefined,
  };
  return result;
  } finally {
    if (!options.keep) await rm(workspace, { recursive: true, force: true });
  }
}

const options = parseArgs(process.argv.slice(2));
let selected = options.caseIds.length > 0 ? cases.filter((item) => options.caseIds.includes(item.id)) : cases;
if (options.caseIds.length > 0 && selected.length !== options.caseIds.length) throw new Error("One or more --cases IDs were not found");
const results: any[] = [];
for (const testCase of selected) {
  for (const condition of options.selectedConditions) {
    if (condition === "forced" && !testCase.should_trigger) continue;
    for (let trial = 1; trial <= options.trials; trial += 1) {
      process.stderr.write(`Running ${testCase.id} [${condition}] trial ${trial}...\n`);
      results.push(await runTrial(testCase, condition, trial, options));
    }
  }
}
const summarizeDimension = (rows: any[], dimension: DimensionName) => {
  const applicable = rows.filter((item) => item.dimensions[dimension].total > 0);
  return { passed: applicable.filter((item) => item.dimensions[dimension].complete === true).length, total: applicable.length };
};
const summarizeRows = (rows: any[]) => ({
  workflow: { passed: rows.filter((item) => item.passed).length, total: rows.length },
  triggering: summarizeDimension(rows, "triggering"),
  behavior: summarizeDimension(rows, "behavior"),
  efficiency: summarizeDimension(rows, "efficiency"),
  infrastructure: summarizeDimension(rows, "infrastructure"),
});
const summary = {
  ...summarizeRows(results),
  byCondition: Object.fromEntries(options.selectedConditions.map((condition) => [condition, summarizeRows(results.filter((item) => item.condition === condition))])),
};
const report = { generatedAt: new Date().toISOString(), config, options, summary, results };
const outputPath = join(here, "latest-results.json");
const temporaryOutputPath = join(here, `.latest-results.tmp-${process.pid}-${Date.now()}.json`);
try {
  await writeFile(temporaryOutputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryOutputPath, outputPath);
} finally {
  await rm(temporaryOutputPath, { force: true });
}
console.log(JSON.stringify({ outputPath, ...summary }, null, 2));
