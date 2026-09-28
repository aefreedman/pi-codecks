import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Resolve pi-ai through the installed SDK (not ambient module resolution). Its public
// event-stream factory produces the same provider stream used by real Pi models.
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piAiUrl = (() => {
  try { return import.meta.resolve("@earendil-works/pi-ai"); }
  catch { return new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", sdkUrl).href; }
})();
const piAi = await import(piAiUrl);
const fixture = await mkdtemp(join(tmpdir(), "pi-codecks-real-host-"));
const agentDir = join(fixture, "agent");
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
const keys = new Set([...Object.keys(process.env).filter(key => /^(?:CODECKS_|PI_CODECKS_)/.test(key)), "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_PROFILE", "CODECKS_ACCOUNT", "CODECKS_PROFILE_ORG_TOKEN", "CODECKS_PROFILE_PERSONAL_TOKEN", "PI_CODECKS_TOOL_LOADING_MODE"]);
const previous = Object.fromEntries([...keys].map(key => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
const originalFetch = globalThis.fetch;
let fetchCount = 0;
globalThis.fetch = (async () => { fetchCount++; throw Error("Network is forbidden in Pi host smoke"); }) as typeof fetch;
process.env.CODECKS_CREDENTIAL_PROVIDER = "environment";
process.env.CODECKS_PROFILE = "ORG";
process.env.CODECKS_ACCOUNT = "synthetic-host-only";
process.env.CODECKS_PROFILE_ORG_TOKEN = "cdxat_synthetic_not_used";
process.env.CODECKS_PROFILE_PERSONAL_TOKEN = "cdxut_synthetic_not_used";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";

const starts: string[] = [];
let settledExtensions = 0;
let settledSessions = 0;
let modelCalls = 0;
let toolCalls = 0;
let activeAction: { profile: "ORG" | "PERSONAL"; scope: "task" | "session" } | undefined;
const timeout = <T>(work: Promise<T>, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), 15000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
let unlisten: (() => void) | undefined;
let unlistenErrors: (() => void) | undefined;
const extensionErrors: unknown[] = [];
try {
const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
modelRuntime.registerProvider("pi-codecks-lifecycle-local", {
  api: "pi-codecks-scripted-local",
  baseUrl: "http://127.0.0.1:9/never-connect",
  apiKey: "synthetic-model-only",
  models: [{ id: "scripted-host", name: "Scripted local host", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 256 }],
  streamSimple: (model, context) => {
    modelCalls++;
    const stream = piAi.createAssistantMessageEventStream();
    const message = { role: "assistant" as const, content: [] as Array<Record<string, unknown>>, api: model.api, provider: model.provider, model: model.id, usage, stopReason: "pending", timestamp: Date.now() };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (context.messages.at(-1)?.role !== "toolResult") {
        if (!activeAction) throw Error("Unplanned model turn");
        const call = { type: "toolCall", id: `synthetic-tool-${++toolCalls}`, name: "codecks_profile_select", arguments: activeAction };
        message.content.push(call);
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        message.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message });
      } else {
        const content = { type: "text", text: "local host turn finished" };
        message.content.push(content);
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: content.text, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: content.text, partial: message });
        message.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message });
      }
    });
    return stream;
  },
});
const model = modelRuntime.getModel("pi-codecks-lifecycle-local", "scripted-host");
assert.ok(model, "local provider model must register");
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const createRuntime = async ({ cwd, sessionManager, sessionStartEvent }: { cwd: string; sessionManager: SessionManager; sessionStartEvent?: { type: "session_start"; reason: "startup" | "new" | "resume" | "fork" | "reload"; previousSessionFile?: string } }) => {
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime, settingsManager,
    resourceLoaderOptions: {
      additionalExtensionPaths: [extensionPath],
      extensionFactories: [(pi) => {
        pi.on("session_start", event => { starts.push(event.reason); });
        pi.on("agent_settled", () => { settledExtensions++; });
      }],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "Use only the scripted profile selection tool in this isolated lifecycle smoke.",
    },
  });
  assert.deepEqual(services.diagnostics.filter(d => d.type === "error"), [], "host resource diagnostics");
  assert.deepEqual(services.resourceLoader.getExtensions().errors, [], "real extension loader errors");
  return { ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model, thinkingLevel: "off", tools: ["codecks_profile_select"] })), services, diagnostics: services.diagnostics };
};
const bind = async () => {
  unlisten?.(); unlistenErrors?.();
  const session = runtime!.session;
  unlistenErrors = session.extensionRunner.onError(error => { extensionErrors.push(error); });
  await session.bindExtensions({});
  assert.ok(session.getActiveToolNames().includes("codecks_profile_select"), "edited Codecks extension must expose its registered profile tool");
  const profileTool = session.getAllTools().find(tool => tool.name === "codecks_profile_select");
  assert.equal(profileTool && resolve(profileTool.sourceInfo.path), extensionPath, "real host must load the edited checkout extension, not an inline imitation");
  unlisten = session.subscribe(event => { if (event.type === "agent_settled") settledSessions++; });
  assert.equal(session.sessionFile, undefined, "Pi session must remain in memory");
  return session;
};
const runTurn = async (name: string, profile: "ORG" | "PERSONAL", scope: "task" | "session", expectedProfile: string, changed: boolean) => {
  activeAction = { profile, scope };
  const beforeSettled = settledSessions;
  await timeout(runtime!.session.prompt(`host-smoke:${name}`), name);
  assert.equal(settledSessions, beforeSettled + 1, `${name}: real host must settle once`);
  const results = runtime!.session.messages.filter(m => m.role === "toolResult" && m.toolName === "codecks_profile_select");
  const result = results.at(-1);
  assert.ok(result, `${name}: Pi must execute the registered tool`);
  const text = result.content.filter(part => part.type === "text").map(part => part.text).join(" ");
  assert.match(text, changed ? new RegExp(`Codecks profile selected: ${expectedProfile}`) : new RegExp(`${profile} Codecks profile is not configured`));
  assert.equal(result.details?.changed, changed, `${name}: tool details must report changed state`);
  assert.equal(result.details?.profile, expectedProfile, `${name}: actual selected profile`);
  activeAction = undefined;
};
  runtime = await createAgentSessionRuntime(createRuntime, { cwd: fixture, agentDir, sessionManager: SessionManager.inMemory(fixture), sessionStartEvent: { type: "session_start", reason: "startup" } });
  await bind();
  await runTurn("task-select", "PERSONAL", "task", "PERSONAL", true);
  delete process.env.CODECKS_PROFILE_PERSONAL_TOKEN;
  await runTurn("post-task-settled", "PERSONAL", "task", "ORG", false);
  process.env.CODECKS_PROFILE_PERSONAL_TOKEN = "cdxut_synthetic_not_used";
  await runTurn("session-select", "PERSONAL", "session", "PERSONAL", true);
  delete process.env.CODECKS_PROFILE_PERSONAL_TOKEN;
  await runTurn("session-persists", "PERSONAL", "task", "PERSONAL", false);
  await timeout(runtime.newSession(), "newSession");
  await bind();
  await runTurn("new-session-reset", "PERSONAL", "task", "ORG", false);
  process.env.CODECKS_PROFILE_PERSONAL_TOKEN = "cdxut_synthetic_not_used";
  await runTurn("pre-fork-select", "PERSONAL", "session", "PERSONAL", true);
  const lastUserEntry = runtime.session.sessionManager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").at(-1);
  assert.ok(lastUserEntry, "in-memory fork must use a real persisted-in-memory user entry");
  await timeout(runtime.fork(lastUserEntry.id, { position: "at" }), "fork");
  await bind();
  delete process.env.CODECKS_PROFILE_PERSONAL_TOKEN;
  await runTurn("fork-reset", "PERSONAL", "task", "ORG", false);
  assert.deepEqual(starts, ["startup", "new", "fork"], "real session_start reasons");
  assert.equal(settledExtensions, 7, "real extension agent_settled count");
  assert.equal(settledSessions, 7, "real host stable-idle event count");
  assert.equal(modelCalls, 14, "one scripted tool call and final response per prompt");
  assert.equal(toolCalls, 7);
  assert.deepEqual(extensionErrors, [], "host must surface no extension errors");
  assert.equal(fetchCount, 0, "no Codecks or provider network request");
  console.log("Real Pi host lifecycle smoke passed: startup/new/fork session_start, seven agent_settled tool turns, deterministic local provider, no network.");
} finally {
  unlisten?.(); unlistenErrors?.();
  if (runtime) await runtime.dispose();
  globalThis.fetch = originalFetch;
  for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(fixture, { recursive: true, force: true });
}
