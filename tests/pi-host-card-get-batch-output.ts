import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { CARD_GET_BATCH_OUTPUT_SCHEMA, isCardGetBatchOutput } from "../src/tools/cards/card-get-batch-output.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piAiUrl = (() => { try { return import.meta.resolve("@earendil-works/pi-ai"); } catch { return new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", sdkUrl).href; } })();
const piAi = await import(piAiUrl);
const fixture = await mkdtemp(join(tmpdir(), "pi-card-get-batch-output-"));
const originalFetch = globalThis.fetch;
let scenario = "", fetches = 0, modelCalls = 0, turns = 0;
let action: { name: string; arguments: Record<string, unknown> };
const events: any[] = [], nested: any[] = [], errors: any[] = [];
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
globalThis.fetch = (async (_input, init) => {
  fetches++;
  const query = JSON.parse(String(init?.body)).query;
  assert.ok(query, "only fake Codecks query transport is allowed");
  const relation = query._root[0].account.flatMap((entry: any) => Object.keys(entry)).find((key: string) => key.startsWith("cards("));
  assert.ok(relation); assert.match(relation, /accountSeq/);
  if (scenario === "api-error") return new Response(JSON.stringify({ errors: [{ message: "synthetic API failure" }] }));
  const cards: any[] = scenario === "empty" ? [] : [{ cardId: "fixture-card", accountSeq: 0, title: "Fixture", content: null, effort: 0, isDoc: false, dueDate: null, deck: { title: "Deck" } }];
  if (scenario === "bytes") cards[0].content = "😀".repeat(32768);
  if (scenario === "clipping") cards[0].title = "😀".repeat(2049);
  return new Response(JSON.stringify({ data: { _root: { account: "fixture" }, account: { fixture: { [relation]: cards.map(card => card.cardId) } }, card: Object.fromEntries(cards.map(card => [card.cardId, card])) } }));
}) as typeof fetch;
let session: any;
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(fixture, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("batch-local", {
    api: "batch-scripted", baseUrl: "http://127.0.0.1:9/never-connect", apiKey: "synthetic-model-inert",
    models: [{ id: "fixture", name: "Local batch fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 256 }],
    streamSimple: (model, context) => {
      modelCalls++;
      const stream = piAi.createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (context.messages.at(-1)?.role !== "toolResult") {
          const call = { type: "toolCall", id: `batch-${++turns}`, ...action }; message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message }); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message });
        } else { message.content.push({ type: "text", text: "Batch fixture complete" }); message.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message }); }
      });
      return stream;
    },
  });
  const services = await createAgentSessionServices({ cwd: fixture, agentDir: join(fixture, "agent"), modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { additionalExtensionPaths: [resolve("index.ts")], extensionFactories: [createCodemodeExtension({ mode: "on", models: false }), pi => {
      pi.on("tool_call", event => { if (event.toolName === "codecks_card_get_batch" && scenario === "blocked") return { block: true, reason: "synthetic batch policy block" }; });
      pi.registerTool({ name: "batch_nested", label: "Batch nested", description: "Non-codemode nested fixture", parameters: Type.Object({ abort: Type.Optional(Type.Boolean()) }), async execute(_id, params, _signal, _update, ctx) {
        const controller = new AbortController(); if (params.abort) controller.abort();
        const outcome = await ctx.executeTool("codecks_card_get_batch", { cardIds: ["seq:0", "seq:1", "seq:0"], format: "text" }, { signal: controller.signal });
        nested.push(outcome);
        return { content: [{ type: "text", text: JSON.stringify({ isError: outcome.isError, dto: outcome.result.structuredContent }) }], details: { childIsError: outcome.isError } };
      } });
    }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Run the supplied local fixture only." },
  });
  assert.deepEqual(services.diagnostics.filter(d => d.type === "error"), []); assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const model = modelRuntime.getModel("batch-local", "fixture"); assert.ok(model);
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(fixture), model, thinkingLevel: "off", tools: ["codecks_card_get_batch", "codemode", "batch_nested"] }));
  await session.bindExtensions({}); session.extensionRunner.onError((error: any) => errors.push(error));
  assert.deepEqual(session.getToolDefinition("codecks_card_get_batch").outputSchema, CARD_GET_BATCH_OUTPUT_SCHEMA);
  session.subscribe((event: any) => { if (event.type === "tool_execution_end") events.push({ scenario, ...event }); });
  const text = (result: any) => result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
  const run = async (name: string, tool: string, args: Record<string, unknown>) => {
    scenario = name; action = { name: tool, arguments: args }; const start = events.length, before = fetches;
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([session.prompt(`batch:${name}`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Timeout: ${name}`)), 20000); })]); }
    finally { clearTimeout(timer!); }
    return { parent: session.messages.filter((m: any) => m.role === "toolResult").at(-1), children: events.slice(start).filter(e => e.toolName === "codecks_card_get_batch"), fetches: fetches - before };
  };
  const args = { cardIds: ["seq:0", "seq:1", "seq:0"] };
  const script = (input: Record<string, unknown>) => ({ code: `const value = await tools.codecks_card_get_batch(${JSON.stringify(input)}); if (!value || typeof value !== 'object') throw Error('text fallback'); text(value);` });
  const direct = await run("direct", "codecks_card_get_batch", args);
  assert.equal(direct.fetches, 1); assert.equal(direct.parent.isError, false); assert.match(text(direct.parent), /```json/);
  const dto = direct.children[0].result.structuredContent; assert.ok(isCardGetBatchOutput(dto)); assert.equal(dto.data.found, 2); assert.equal(dto.data.missing, 1);
  assert.equal(dto.data.items[0].card.card.content, null); assert.equal(dto.data.items[0].card.card.effort, 0); assert.equal(dto.data.items[0].card.card.isDoc, false);
  assert.equal(Object.hasOwn(dto.data.items[0].card.card.deck, "id"), false);
  const coded = await run("codemode-text", "codemode", script({ ...args, format: "text" }));
  assert.equal(coded.parent.isError, false); assert.equal(coded.children[0].isError, false); assert.equal(coded.fetches, 1); assert.deepEqual(coded.children[0].result.structuredContent, dto); assert.match(text(coded.parent), /"schemaVersion":1/); assert.match(text(coded.children[0].result), /Card Batch Data/); assert.doesNotMatch(text(coded.children[0].result), /```json/);
  const other = await run("non-codemode", "batch_nested", {}); assert.equal(other.fetches, 1); assert.deepEqual(nested.at(-1).result.structuredContent, dto); assert.equal(nested.at(-1).isError, false); assert.ok(other.children[0].parentToolCallId);
  const directError = await run("direct-error", "codecks_card_get_batch", { cardIds: ["123e4567-e89b-12d3-a456-426614174000"] }); assert.equal(directError.fetches, 0); assert.equal(directError.parent.isError, true); assert.equal(directError.children[0].result.structuredContent.error.code, "validation_error");
  for (const name of ["api-error", "bytes", "clipping", "empty"]) {
    const result = await run(name, "codemode", script(args)); const child = result.children[0], value = child.result.structuredContent;
    assert.ok(isCardGetBatchOutput(value)); assert.equal(result.parent.isError, false); assert.equal(result.fetches, 1);
    assert.equal(child.isError, ["api-error", "bytes"].includes(name)); assert.equal(child.isError, !value.ok);
    if (name === "api-error") { assert.equal(value.data.items[0].status, "failed"); assert.equal(Object.hasOwn(value.data, "found"), false); }
    if (name === "bytes") { assert.equal(value.completeness.read, "complete"); assert.equal(value.data.found, 2); assert.equal(value.data.projectionErrors, 2); assert.equal(value.data.items[0].error.error.code, "output_too_large"); }
    if (name === "clipping") { assert.equal(value.completeness.projection, false); assert.equal(Array.from(value.data.items[0].card.card.title).length, 2048); }
    if (name === "empty") { assert.equal(value.data.found, 0); assert.equal(value.data.missing, 3); assert.equal(value.completeness.read, "complete"); }
  }
  const blocked = await run("blocked", "codemode", { code: "try { await tools.codecks_card_get_batch({cardIds:['seq:0']}); throw Error('must reject'); } catch (error) { text(String(error)); }" });
  assert.equal(blocked.fetches, 0); assert.equal(blocked.parent.isError, false); assert.equal(blocked.children[0].isError, true); assert.equal(blocked.children[0].result.structuredContent, undefined); assert.match(text(blocked.parent), /synthetic batch policy block/);
  const aborted = await run("aborted", "batch_nested", { abort: true }); assert.equal(aborted.fetches, 0); assert.equal(nested.at(-1).isError, true); assert.equal(aborted.children[0].isError, true);
  // SDK final-event receipt and JSON conversion/serialization, not CLI/RPC wire proof.
  const jsonEvent = await import(new URL("./modes/json-event.js", sdkUrl).href);
  for (const event of events.filter(e => e.toolName === "codecks_card_get_batch" && e.result.structuredContent)) {
    const serialized = JSON.parse(JSON.stringify(jsonEvent.toJsonEvent(event))); assert.deepEqual(serialized.result.structuredContent, event.result.structuredContent); assert.equal(serialized.isError, event.isError);
  }
  for (const message of session.messages.filter((m: any) => m.role === "toolResult")) assert.equal(Object.hasOwn(message, "structuredContent"), false, "ordinary transcript does not persist DTOs");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", pi: "0.99.2", turns, modelCalls, fakeFetches: fetches, realTransports: 0, scenarios: 10, consumers: ["direct", "codemode", "non-codemode nested", "SDK final events", "JSON event conversion"], wireRPC: "not executed" }));
} finally { session?.dispose(); globalThis.fetch = originalFetch; await rm(fixture, { recursive: true, force: true }); }
