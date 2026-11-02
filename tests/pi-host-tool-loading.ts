import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, ModelRuntime, SessionManager, SettingsManager, type CreateAgentSessionRuntimeFactory } from "@earendil-works/pi-coding-agent";
import { BALANCED_ACTIVE_CODECKS_TOOL_NAMES, DEFAULT_CODECKS_TOOL_NAMES } from "../src/codecks-tool-loading.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const version = JSON.parse(await readFile(new URL("../package.json", sdk), "utf8")).version;
assert.equal(version, manifest.devDependencies["@earendil-works/pi-coding-agent"]);
const ai = await import(import.meta.resolve("@earendil-works/pi-ai"));
const fixture = await mkdtemp(join(tmpdir(), "codecks-tool-loading-"));
const previousFetch = globalThis.fetch, previousMode = process.env.PI_CODECKS_TOOL_LOADING_MODE;
let fetches = 0, modelCalls = 0, emitLoader = false, lateTool = false;
globalThis.fetch = (async () => { fetches++; throw Error("No network allowed"); }) as typeof fetch;
const errors: unknown[] = [], starts: string[] = [];
const loader = "codecks_tool_search", deferred = "codecks_milestone_get";
let selection: { tools?: string[]; noTools?: "all" | "builtin" } = { noTools: "builtin" };
let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(fixture, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("loading-local", { api: "loading-scripted", baseUrl: "http://127.0.0.1:9/never", apiKey: "synthetic-inert", models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 256 }], streamSimple: model => {
    modelCalls++;
    const stream = ai.createAssistantMessageEventStream();
    const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (emitLoader) {
        emitLoader = false;
        const call = { type: "toolCall", id: `load-${modelCalls}`, name: loader, arguments: { toolNames: [deferred] } };
        message.content.push(call); message.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      } else message.content.push({ type: "text", text: "Local fixture complete" });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  } });
  const create: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({ cwd, agentDir: join(fixture, "agent"), modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), resourceLoaderOptions: {
      additionalExtensionPaths: [resolve("index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Local fixture only",
      extensionFactories: [pi => {
        pi.on("session_start", event => { starts.push(event.reason); });
        pi.registerTool({ name: "foreign_fixture", label: "Foreign", description: "Inert foreign tool", parameters: Type.Object({}), async execute() { throw Error("Not called"); } });
        if (lateTool) pi.registerTool({ name: "late_fixture", label: "Late", description: "Newly registered inert tool", parameters: Type.Object({}), async execute() { throw Error("Not called"); } });
      }],
    } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    assert.deepEqual(services.diagnostics.filter(d => d.type === "error"), []);
    return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModel("loading-local", "fixture"), thinkingLevel: "off", ...selection }), services, diagnostics: services.diagnostics };
  };
  const bind = async () => { await runtime!.session.bindExtensions({ onError: e => errors.push(e) }); };
  const active = () => runtime!.session.getActiveToolNames();
  for (const mode of ["balanced", "loader-only", "all-active"]) {
    process.env.PI_CODECKS_TOOL_LOADING_MODE = mode;
    runtime = await createAgentSessionRuntime(create, { cwd: fixture, agentDir: join(fixture, "agent"), sessionManager: SessionManager.inMemory(fixture) }); await bind();
    const expected = mode === "all-active" ? [...DEFAULT_CODECKS_TOOL_NAMES] : mode === "balanced" ? [loader, ...BALANCED_ACTIVE_CODECKS_TOOL_NAMES] : [loader];
    assert.deepEqual(new Set(active()), new Set(["foreign_fixture", ...expected]), `${mode} native defaults`);
    await runtime.dispose(); runtime = undefined;
  }
  process.env.PI_CODECKS_TOOL_LOADING_MODE = "loader-only";
  for (const explicit of [{ tools: [deferred, "foreign_fixture"] }, { noTools: "all" as const }, { tools: [] }]) {
    selection = explicit;
    runtime = await createAgentSessionRuntime(create, { cwd: fixture, agentDir: join(fixture, "agent"), sessionManager: SessionManager.inMemory(fixture) }); await bind();
    assert.deepEqual(new Set(active()), new Set(explicit.tools ?? []), "--tools/--no-tools selection survives session_start");
    await runtime.dispose(); runtime = undefined;
  }
  selection = {};
  runtime = await createAgentSessionRuntime(create, { cwd: fixture, agentDir: join(fixture, "agent"), sessionManager: SessionManager.create(fixture, join(fixture, "sessions")) }); await bind();
  emitLoader = true; await runtime.session.prompt("Activate only the synthetic requested tool");
  assert.ok(active().includes(deferred));
  const loadedLeaf = runtime.session.sessionManager.getLeafId()!;
  const loadedOrder = active();
  runtime.session.setActiveToolsByName([...loadedOrder].reverse());
  assert.deepEqual(active(), loadedOrder, "unchanged tools keep their order");
  runtime.session.setActiveToolsByName(active().filter(n => n !== deferred));
  await runtime.session.prompt("Record explicit removal");
  const removedLeaf = runtime.session.sessionManager.getLeafId()!;
  const sessionFile = runtime.session.sessionFile!;
  assert.ok(sessionFile);
  await runtime.session.reload();
  assert.ok(!active().includes(deferred), "reload must not replay stale loader history");
  assert.ok(active().includes("foreign_fixture"));
  await runtime.newSession(); await bind();
  assert.ok(!active().includes(deferred), "new session uses defaults");
  await runtime.switchSession(sessionFile); await bind();
  assert.ok(!active().includes(deferred), "resume preserves explicit removal despite successful loader history");
  await runtime.session.navigateTree(loadedLeaf, { summarize: false });
  assert.ok(active().includes(deferred), "tree restores activated branch loadout");
  await runtime.session.navigateTree(removedLeaf, { summarize: false });
  assert.ok(!active().includes(deferred), "tree restores explicit removal");
  lateTool = true;
  await runtime.session.reload();
  assert.ok(active().includes("late_fixture"), "new default-active tool is exposed after reload");
  assert.ok(!active().includes(deferred), "new registration does not reactivate removed deferred tool");
  await runtime.session.navigateTree(loadedLeaf, { summarize: false });
  assert.ok(active().includes("late_fixture"), "tree preserves newly registered tool absent from historical loadout");
  assert.ok(active().includes(deferred));
  await runtime.session.prompt("Record the activated branch before reopening its file");
  await runtime.newSession(); await bind();
  await runtime.switchSession(sessionFile); await bind();
  assert.ok(active().includes(deferred), "resume preserves native loader activation on the selected branch");
  assert.ok(active().includes("late_fixture"), "resume retains newly registered default-active tool");
  assert.equal(starts.filter(reason => reason === "reload").length, 2, "reload must run real session_start handlers");
  assert.deepEqual(errors, []); assert.equal(fetches, 0);
  console.log(JSON.stringify({ status: "passed", pi: version, modelCalls, fetches, modes: 3, explicitSelections: 3, lifecycle: ["new", "resume", "reload", "tree", "late-registration", "stable-order"], starts }));
} finally {
  await runtime?.dispose(); globalThis.fetch = previousFetch;
  if (previousMode === undefined) delete process.env.PI_CODECKS_TOOL_LOADING_MODE; else process.env.PI_CODECKS_TOOL_LOADING_MODE = previousMode;
  await rm(fixture, { recursive: true, force: true });
}
