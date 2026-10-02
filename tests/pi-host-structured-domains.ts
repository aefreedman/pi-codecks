import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CONTRACTS } from "./structured-contract-inventory.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piAi = await import(new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", sdkUrl).href);
const fixture = await mkdtemp(join(tmpdir(), "pi-structured-domains-"));
const previousFetch = globalThis.fetch;
const cardId = "11111111-1111-4111-8111-111111111111";
let scenario = "", turns = 0, modelCalls = 0;
let action: { name: string; arguments: Record<string, unknown> };
const requests: any[] = [], events: any[] = [], nested: any[] = [], extensionErrors: any[] = [], artifacts = new Set<string>();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
globalThis.fetch = (async (input, init) => {
  const url = String(input), body = JSON.parse(String(init?.body));
  // Extension loader owns its module graph; singleton/ALS identities are checked
  // directly by foundation-seams and every domain suite, not a second tsx graph.
  assert.ok(url.startsWith("https://api.codecks.io/"), "fixture rejects foreign transports");
  assert.equal(init?.method, "POST");
  const path = url.includes("/dispatch/") ? url.split("/dispatch/")[1] : "query";
  requests.push({ path, body });
  if (path !== "query") {
    assert.ok(["decks/update", "cards/update", "resolvables/create"].includes(path), path);
    if (scenario === "uncertain") return new Response(JSON.stringify({ error: "synthetic unavailable" }), { status: 503 });
    return new Response(JSON.stringify({ data: { cardId: "created", accountSeq: 1 } }));
  }
  assert.ok(body.query);
  const data: any = { _root: { account: "a", loggedInUser: "u" }, account: { a: { id: "a", sprintsEnabled: true } }, user: { u: { id: "u", name: "Self", kind: "human", isIntegration: false } }, card: { [cardId]: { cardId, accountSeq: 0, title: "Synthetic 😀", content: "Synthetic body", effort: 0, isDoc: false, status: "not_started", deck: { id: "d", title: "Deck" }, masterTags: [], childCards: [], resolvables: ["r"] } }, deck: { d: { id: "d", accountSeq: 12, title: "Deck", description: null, isDeleted: false } }, sprint: { s: { id: "s", accountSeq: 1, name: "Run", completedAt: "2026-02-09T00:00:00Z", startDate: "2026-02-02", endDate: "2026-02-08", stats: { finishStats: { progress: { done: [1, 0, 0] } } } } }, resolvable: { r: { id: "r", card: cardId, context: "comment", isClosed: false, entries: ["e"] } }, resolvableEntry: { e: { entryId: "e", author: "u", content: "External 😀", version: 0, resolvable: "r" } } };
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (/^cards(?:\(|$)/.test(key)) data.account.a[key] = [cardId];
      if (/^decks(?:\(|$)/.test(key)) data.account.a[key] = ["d"];
      if (/^sprints(?:\(|$)/.test(key)) data.account.a[key] = ["s"];
      if (/^card\(/.test(key)) data[key] = cardId;
      if (/^resolvable\(/.test(key)) data[key] = "r";
      if (/^resolvables(?:\(|$)/.test(key)) data.card[cardId][key] = ["r"];
      if (/^entries(?:\(|$)/.test(key)) data.resolvable.r[key] = ["e"];
      visit(child);
    }
  }; visit(body.query);
  return new Response(JSON.stringify({ data }));
}) as typeof fetch;
let session: any;
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(fixture, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("domains-local", {
    api: "domains-scripted", baseUrl: "http://127.0.0.1:9/never-connect", apiKey: "synthetic-inert",
    models: [{ id: "fixture", name: "Local domains fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 256 }],
    streamSimple: (model, context) => {
      modelCalls++;
      const stream = piAi.createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (context.messages.at(-1)?.role !== "toolResult") {
          const call = { type: "toolCall", id: `domains-${++turns}`, ...action }; message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message }); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message });
        } else { message.content.push({ type: "text", text: "Fixture complete" }); message.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message }); }
      });
      return stream;
    },
  });
  const services = await createAgentSessionServices({ cwd: fixture, agentDir: join(fixture, "agent"), modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }), resourceLoaderOptions: {
    additionalExtensionPaths: [resolve("index.ts")], extensionFactories: [createCodemodeExtension({ mode: "on", models: false }), pi => {
      pi.on("tool_call", event => { if (event.toolName === "codecks_deck_get" && scenario === "blocked") return { block: true, reason: "synthetic domain block" }; });
      pi.registerTool({ name: "domains_nested", label: "Domains nested", description: "Non-codemode consumer", parameters: Type.Object({ tool: Type.String(), args: Type.Record(Type.String(), Type.Unknown()), abort: Type.Optional(Type.Boolean()) }), async execute(_id, params, _signal, _update, ctx) {
        const controller = new AbortController(); if (params.abort) controller.abort();
        const outcome = await ctx.executeTool(params.tool, params.args, { signal: controller.signal }); nested.push(outcome);
        return { content: [{ type: "text", text: JSON.stringify({ childIsError: outcome.isError, dto: outcome.result.structuredContent }) }], details: { childIsError: outcome.isError } };
      } });
    }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Local fixture only.",
  } });
  assert.deepEqual(services.diagnostics.filter(d => d.type === "error"), []);
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const model = modelRuntime.getModel("domains-local", "fixture"); assert.ok(model);
  const tools = ["deck_get", "deck_update", "card_update_effort", "card_bulk_update", "card_add_comment", "card_list_resolvables", "run_average_effort"].map(n => `codecks_${n}`);
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(fixture), model, thinkingLevel: "off", tools: [...tools, "codemode", "domains_nested"] }));
  await session.bindExtensions({}); session.extensionRunner.onError((error: any) => extensionErrors.push(error));
  for (const tool of tools) assert.deepEqual(session.getToolDefinition(tool).outputSchema, CONTRACTS[tool.slice(8)].schema);
  session.subscribe((event: any) => { if (event.type === "tool_execution_end") events.push({ scenario, ...event }); });
  const text = (result: any) => result.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  const run = async (name: string, tool: string, args: Record<string, unknown>) => {
    scenario = name; action = { name: tool, arguments: args }; resetRateGate();
    const before = requests.length, start = events.length;
    console.log(`host scenario: ${name}`);
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([session.prompt(`domains:${name}`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Timeout: ${name}`)), 20000); })]); }
    finally { clearTimeout(timer!); }
    const children = events.slice(start).filter(e => e.toolName.startsWith("codecks_"));
    const parent = session.messages.filter((m: any) => m.role === "toolResult").at(-1);
    for (const child of children) if (child.result.structuredContent) {
      const dto = child.result.structuredContent;
      assert.equal(Value.Check(CONTRACTS[child.toolName.slice(8)].schema as any, dto), true, JSON.stringify(dto));
      assert.equal(child.isError, !dto.ok);
      if (dto.data?.artifact?.path) artifacts.add(dto.data.artifact.path);
    }
    return { parent, children, requests: requests.slice(before) };
  };
  const script = (tool: string, args: any) => ({ code: `const dto = await tools.${tool}(${JSON.stringify(args)}); if (!dto || typeof dto !== 'object') throw Error('text fallback'); text(dto);` });
  const cases = [
    { tool: "codecks_deck_get", args: { deckId: 12 }, dispatches: 0, queries: 1 },
    { tool: "codecks_deck_update", args: { deckId: 12, clearDescription: true }, dispatches: 1, queries: 1 },
    { tool: "codecks_card_update_effort", args: { cardId: "seq:0", effort: 0 }, dispatches: 1, queries: 1 },
    { tool: "codecks_card_add_comment", args: { cardId, content: "Fixture comment" }, dispatches: 1, queries: 2 },
    { tool: "codecks_card_list_resolvables", args: { cardId, limit: 1 }, dispatches: 0, queries: 3 },
    { tool: "codecks_run_average_effort", args: { minDeliveredEffort: 0 }, dispatches: 0, queries: 1 },
  ];
  for (const entry of cases) for (const consumer of ["direct", "codemode", "nested"]) {
    const args = { ...entry.args, format: consumer === "direct" ? "json" : "text" };
    const result = await run(`${entry.tool}:${consumer}`, consumer === "direct" ? entry.tool : consumer === "codemode" ? "codemode" : "domains_nested", consumer === "direct" ? args : consumer === "codemode" ? script(entry.tool, args) : { tool: entry.tool, args });
    assert.equal(result.children.length, 1);
    assert.equal(result.parent.isError, false, text(result.parent));
    assert.equal(result.children[0].result.structuredContent.ok, true, JSON.stringify(result.children[0].result));
    assert.equal(result.requests.filter(r => r.path !== "query").length, entry.dispatches);
    assert.equal(result.requests.filter(r => r.path === "query").length, entry.queries);
    assert.ok(text(result.children[0].result).length > 0);
    if (consumer === "direct") assert.match(text(result.parent), /```json/);
    else { assert.doesNotMatch(text(result.children[0].result), /```json/); assert.ok(result.children[0].parentToolCallId); }
    if (consumer === "nested") assert.deepEqual(nested.at(-1).result.structuredContent, result.children[0].result.structuredContent);
    if (entry.tool === "codecks_deck_get") assert.equal(result.children[0].result.structuredContent.data.deck.description, null);
    if (entry.tool === "codecks_card_update_effort") assert.equal(result.children[0].result.structuredContent.effects.requested.effort, 0);
  }
  const bulkArgs = { updates: [{ cardId: "seq:0", effort: 0, correlationKey: "row-😀" }], dryRun: true, format: "text" };
  const preview = await run("bulk-preview", "codemode", script("codecks_card_bulk_update", bulkArgs));
  const dto = preview.children[0].result.structuredContent;
  assert.equal(dto.ok, true); assert.equal(dto.data.results.length, 1); assert.equal(preview.requests.filter(r => r.path !== "query").length, 0);
  assert.match(dto.data.previewFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(await readFile(dto.data.artifact.path, "utf8")).previewFingerprint, dto.data.previewFingerprint);
  const applied = await run("bulk-apply", "domains_nested", { tool: "codecks_card_bulk_update", args: { ...bulkArgs, dryRun: false, expectedPreviewFingerprint: dto.data.previewFingerprint } });
  assert.equal(applied.children[0].result.structuredContent.ok, true); assert.equal(applied.requests.filter(r => r.path !== "query").length, 1);
  assert.equal(applied.children[0].result.structuredContent.data.results[0].certainty, "dispatch_returned");
  for (const consumer of ["direct", "codemode", "nested"]) {
    const args = { deckId: 12 }; // no changed fields, definitely unsent semantic error
    const result = await run(`semantic:${consumer}`, consumer === "direct" ? "codecks_deck_update" : consumer === "codemode" ? "codemode" : "domains_nested", consumer === "direct" ? args : consumer === "codemode" ? script("codecks_deck_update", args) : { tool: "codecks_deck_update", args });
    assert.equal(result.children[0].isError, true); assert.equal(result.children[0].result.structuredContent.ok, false);
    assert.equal(result.children[0].result.structuredContent.effect.certainty, "not_dispatched");
    assert.equal(result.parent.isError, consumer === "direct"); assert.equal(result.requests.length, 0);
  }
  const uncertain = await run("uncertain", "codemode", script("codecks_deck_update", { deckId: 12, description: "Changed" }));
  assert.equal(uncertain.parent.isError, false); assert.equal(uncertain.children[0].isError, true);
  assert.equal(uncertain.children[0].result.structuredContent.effect.certainty, "indeterminate");
  assert.equal(uncertain.children[0].result.structuredContent.effect.replaySafe, false);
  assert.equal(uncertain.requests.filter(r => r.path !== "query").length, 1);
  const blocked = await run("blocked", "codemode", { code: "try { await tools.codecks_deck_get({deckId:12}); throw Error('must reject'); } catch (error) { text(String(error)); }" });
  assert.equal(blocked.requests.length, 0); assert.equal(blocked.parent.isError, false); assert.equal(blocked.children[0].isError, true); assert.equal(blocked.children[0].result.structuredContent, undefined); assert.match(text(blocked.parent), /synthetic domain block/);
  const aborted = await run("aborted", "domains_nested", { tool: "codecks_deck_update", args: { deckId: 12, description: "Changed" }, abort: true });
  assert.equal(aborted.requests.length, 0); assert.equal(nested.at(-1).isError, true);
  const jsonEvent = await import(new URL("./modes/json-event.js", sdkUrl).href);
  for (const event of events.filter(e => e.result.structuredContent)) {
    const converted = JSON.parse(JSON.stringify(jsonEvent.toJsonEvent(event)));
    assert.deepEqual(converted.result.structuredContent, event.result.structuredContent); assert.equal(converted.isError, event.isError);
  }
  for (const message of session.messages.filter((m: any) => m.role === "toolResult")) assert.equal(Object.hasOwn(message, "structuredContent"), false);
  assert.deepEqual(extensionErrors, []);
  assert.equal(turns, 26); assert.equal(modelCalls, 52);
  console.log(JSON.stringify({ status: "passed", pi: "1.0.0", turns, modelCalls, fakeFetches: requests.length, realTransports: 0, consumers: ["direct", "codemode", "non-codemode nested", "SDK final events", "JSON event conversion"], wireJSON: "not executed", wireRPC: "not executed" }));
} finally {
  session?.dispose(); globalThis.fetch = previousFetch; resetRateGate();
  for (const path of artifacts) await rm(dirname(path), { recursive: true, force: true });
  await rm(fixture, { recursive: true, force: true });
}
