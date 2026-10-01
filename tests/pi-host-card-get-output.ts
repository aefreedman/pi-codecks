import assert from "node:assert/strict";
import { access, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import { createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isCardSearchOutput, CARD_SEARCH_OUTPUT_SCHEMA } from "../src/card-search-output.ts";
import { isCardGetOutput, CARD_GET_OUTPUT_SCHEMA } from "../src/card-get-output.ts";

// These are real file-loaded extensions and the SDK's exported codemode factory, not tool imitations.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(root, "index.ts");
const compatibility = process.argv.includes("--safety-rails");
const redactorPath = compatibility ? resolve(root, "../pi-safety-rails/extensions/tool-output-redactor.ts") : undefined;
if (compatibility) {
  try { await access(redactorPath); }
  catch { throw Error("Opt-in Safety Rails compatibility test requires its sibling checkout; default Codecks host test does not."); }
}
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const piAiUrl = (() => { try { return import.meta.resolve("@earendil-works/pi-ai"); } catch { return new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", sdkUrl).href; } })();
const piAi = await import(piAiUrl);
const fixture = await mkdtemp(join(tmpdir(), "pi-card-get-output-"));
const agentDir = join(fixture, "agent");
const modifierPath = join(fixture, "modifier.ts");
const fixturePath = join(fixture, "synthetic-secret.json");
const auditPath = join(fixture, "runtime-audit.json");
const secret = ["gh", "p"].join("") + "_" + randomBytes(20).toString("hex");
const shortSecret = ["gh", "p"].join("") + "_" + randomBytes(1).toString("hex").slice(0, 1);
await writeFile(fixturePath, JSON.stringify({ secret, shortSecret }));
const onDiskFixture = JSON.parse(await readFile(fixturePath, "utf8"));
const onDiskSecret = onDiskFixture.secret;
assert.match(onDiskFixture.shortSecret, /^ghp_[a-f0-9]$/);
assert.match(onDiskSecret, /^ghp_[a-f0-9]{40}$/); assert.equal(onDiskSecret.includes("[REDACTED]"), false);
const state = { scenario: "", secret: onDiskSecret, shortSecret: onDiskFixture.shortSecret };
(globalThis as any).__piCardGetOutputTest = state;
await writeFile(modifierPath, `export default function(pi) {
  pi.on("tool_call", event => {
    const s = globalThis.__piCardGetOutputTest;
    if (event.toolName === "codecks_card_get" && s.scenario === "blocked") return { block: true, reason: "synthetic policy block" };
  });
  pi.on("tool_result", event => {
    if (event.toolName !== "codecks_card_get") return;
    const s = globalThis.__piCardGetOutputTest;
    if (s.scenario === "content-only") return { content: [{ type: "text", text: "hook intentionally replaced content" }] };
    if (s.scenario === "expansion-secret") {
      const structuredContent = { ...event.structuredContent, card: { ...event.structuredContent.card, title: (s.shortSecret + " ").repeat(250) } };
      s.beforeRedaction = structuredContent; return { structuredContent };
    }
    if (s.scenario === "identifier-secret") return { structuredContent: { ...event.structuredContent, card: { ...event.structuredContent.card, cardId: s.secret } } };
    if (s.scenario === "literal-secret") return { structuredContent: { ...event.structuredContent, card: { ...event.structuredContent.card, contentTrust: s.secret } } };
    if (s.scenario === "enum-secret") return { structuredContent: { ...event.structuredContent, error: { ...event.structuredContent.error, code: s.secret } } };
    if (s.scenario === "error-text-secret") return { content: [{ type: "text", text: s.secret }], structuredContent: event.structuredContent };
    if (s.scenario === "structured-secret") return { structuredContent: { ...event.structuredContent, card: { ...event.structuredContent.card, content: s.secret } } };
    if (s.scenario === "text-secret") return { content: [{ type: "text", text: s.secret }], structuredContent: event.structuredContent };
    if (s.scenario === "details-secret") return { details: { note: s.secret, count: 0 } };
  });
}`);
const keys = new Set([...Object.keys(process.env).filter(key => /^(?:CODECKS_|PI_CODECKS_)/.test(key)), "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_PROFILE", "CODECKS_ACCOUNT", "CODECKS_PROFILE_ORG_TOKEN", "PI_CODECKS_TOOL_LOADING_MODE"]);
const previous = Object.fromEntries([...keys].map(key => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
process.env.CODECKS_CREDENTIAL_PROVIDER = "environment"; process.env.CODECKS_PROFILE = "ORG";
process.env.CODECKS_ACCOUNT = "synthetic-card-get-host"; process.env.CODECKS_PROFILE_ORG_TOKEN = "cdxat_synthetic_inert";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";
const originalFetch = globalThis.fetch;
let fakeFetches = 0, realTransport = 0, modelCalls = 0, turns = 0;
const requests: unknown[] = [];
globalThis.fetch = (async (_input, init) => {
  fakeFetches++;
  const body = JSON.parse(String(init?.body)); assert.ok(body.query, "only a fake Codecks query is permitted"); requests.push(body.query);
  const rootQuery = body.query._root?.[0]?.account;
  const relation = rootQuery?.flatMap((entry: object) => Object.keys(entry)).find((key: string) => key.startsWith("cards("));
  const direct = Object.keys(body.query).find(key => key.startsWith("card("));
  if (state.scenario === "fetch-throws") throw Error("synthetic fetch failure");
  if (state.scenario === "api-error") return new Response(JSON.stringify({ errors: [{ message: "synthetic API failure" }] }));
  const searching = relation && !relation.includes("accountSeq");
  if (state.scenario === "partial-failure" && searching && !relation.includes('"$offset":0')) return new Response(JSON.stringify({ errors: [{ message: "synthetic later-page failure" }] }));
  const partial = state.scenario.startsWith("partial-");
  let cards = [{ cardId: "fixture-main", accountSeq: 0, title: "Fixture title", content: "Fixture body", isDoc: false, effort: 0, dueDate: null }];
  if (searching && partial) {
    // A full 500-row page repeated to the unchanged 3000-row scan bound: no retry/fallback.
    cards = Array.from({ length: 500 }, (_, i) => ({ cardId: `fixture-${i}`, accountSeq: i, title: ["partial-one", "partial-failure"].includes(state.scenario) && i === 0 ? "Possible match" : "Unrelated", content: "", isDoc: false, effort: 0, dueDate: null }));
  }
  if (state.scenario === "producer-bytes") cards[0].content = "😀".repeat(20000);
  if (state.scenario === "producer-clipping") { cards[0].title = "x".repeat(2049); cards[0].content = "x".repeat(32769); }
  const data: any = { card: Object.fromEntries(cards.map(card => [card.cardId, card])) };
  if (relation) { data._root = { account: "fixture" }; data.account = { fixture: { [relation]: cards.map(card => card.cardId) } }; }
  else if (direct) data[direct] = "fixture-main";
  else { realTransport++; throw Error("Unexpected transport shape; no real fetch is ever invoked"); }
  return new Response(JSON.stringify({ data }));
}) as typeof fetch;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let action: { name: string; arguments: Record<string, unknown> } | undefined;
const extensionErrors: any[] = [];
const records: any[] = [];
const sessions: any[] = [];
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("card-get-local", {
    api: "card-get-scripted", baseUrl: "http://127.0.0.1:9/never-connect", apiKey: "synthetic-model-inert",
    models: [{ id: "fixture", name: "Local scripted fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 256 }],
    streamSimple: (model, context) => {
      modelCalls++;
      const stream = piAi.createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (context.messages.at(-1)?.role !== "toolResult") {
          assert.ok(action, "scripted action must exist");
          const call = { type: "toolCall", id: `pilot-${++turns}`, ...action }; message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message }); stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message });
        } else {
          message.content.push({ type: "text", text: "Local fixture complete" }); message.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message });
        }
      });
      return stream;
    },
  });
  const model = modelRuntime.getModel("card-get-local", "fixture"); assert.ok(model);
  const makeSession = async (order: "alone" | "before" | "after" = "alone") => {
    const services = await createAgentSessionServices({ cwd: fixture, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { additionalExtensionPaths: order === "alone" ? [modifierPath, extensionPath] : order === "before" ? [modifierPath, redactorPath, extensionPath] : [extensionPath, modifierPath, redactorPath],
        extensionFactories: [createCodemodeExtension({ mode: "on", models: false }), pi => {
          pi.registerTool({ name: "pilot_throw", label: "Fixture throw", description: "Synthetic thrown failure", parameters: Type.Object({}), async execute() { throw Error("synthetic thrown execution"); } });
          pi.registerTool({ name: "pilot_abort", label: "Fixture abort", description: "Pre-aborted child call", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, ctx) {
            const controller = new AbortController(); controller.abort();
            const outcome = await ctx.executeTool("codecks_card_get", { cardId: "seq:0" }, { signal: controller.signal });
            records.push({ abortedOutcome: outcome });
            return { content: [{ type: "text", text: JSON.stringify({ childIsError: outcome.isError, value: outcome.result.structuredContent }) }], details: { childIsError: outcome.isError } };
          } });
        }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Run only the supplied local scripted action." },
    });
    assert.deepEqual(services.diagnostics.filter(d => d.type === "error"), []); assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const loaded = services.resourceLoader.getExtensions().extensions.map(e => resolve(e.path));
    assert.ok(loaded.includes(extensionPath));
    if (order === "alone") assert.equal(loaded.includes(redactorPath), false, "default proof has no Safety Rails dependency");
    else {
      assert.ok(loaded.includes(redactorPath));
      assert.equal(loaded.indexOf(redactorPath) < loaded.indexOf(extensionPath), order === "before");
      assert.ok(loaded.indexOf(modifierPath) < loaded.indexOf(redactorPath));
    }
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(fixture), model, thinkingLevel: "off", tools: ["codecks_card_get", "codecks_card_search", "codemode", "pilot_throw", "pilot_abort"] });
    sessions.push(session); await session.bindExtensions({});
    session.extensionRunner.onError(error => extensionErrors.push(error));
    assert.equal(session.sessionFile, undefined);
    assert.deepEqual(new Set(session.getActiveToolNames()), new Set(["codecks_card_get", "codecks_card_search", "codemode", "pilot_throw", "pilot_abort"]));
    assert.deepEqual(new Set(session.getCallableToolNames()), new Set(["codecks_card_get", "codecks_card_search", "pilot_throw", "pilot_abort"]));
    const registry = session.getAllTools();
    assert.deepEqual(new Set(registry.map(t => t.name)), new Set(["codecks_card_get", "codecks_card_search", "codemode", "pilot_throw", "pilot_abort"]), "explicit SDK registry allowlist excludes unrelated Codecks tools and built-ins");
    assert.equal(resolve(registry.find(t => t.name === "codecks_card_get")!.sourceInfo.path), extensionPath);
    assert.deepEqual(session.getToolDefinition("codecks_card_get")!.outputSchema, CARD_GET_OUTPUT_SCHEMA);
    assert.deepEqual(session.getToolDefinition("codecks_card_search")!.outputSchema, CARD_SEARCH_OUTPUT_SCHEMA);
    assert.ok(session.getToolDefinition("codemode")!.prepareLoadout, "actual codemode definition must be registered");
    session.subscribe(event => { if (event.type === "tool_execution_end") records.push({ scenario: state.scenario, ...event }); });
    return session;
  };
  let session = await makeSession();
  const run = async (scenario: string, name: string, args: Record<string, unknown>) => {
    state.scenario = scenario; action = { name, arguments: args };
    const before = fakeFetches;
    const startRecord = records.length;
    let timer: ReturnType<typeof setTimeout>;
    try { await Promise.race([session.prompt(`pilot:${scenario}`), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`Timeout: ${scenario}`)), 20000); })]); }
    finally { clearTimeout(timer!); }
    const parent: any = session.messages.filter(m => m.role === "toolResult").at(-1); assert.ok(parent);
    return { parent, children: records.slice(startRecord).filter(r => r.scenario === scenario && ["codecks_card_get", "codecks_card_search"].includes(r.toolName)), fetches: fakeFetches - before };
  };
  const text = (result: any) => result.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  const script = (args: Record<string, unknown>) => ({ code: `const value = await tools.codecks_card_get(${JSON.stringify(args)}); if (typeof value !== "object" || value === null) throw Error("unexpected text fallback"); text(value);` });
  if (!compatibility) {
  const searchScript = (args: Record<string, unknown>) => ({ code: `const value = await tools.codecks_card_search(${JSON.stringify(args)}); if (typeof value !== "object" || value === null) throw Error("unexpected search text fallback"); text(value);` });
  const searchDirect = await run("search-direct", "codecks_card_search", { outputMode: "detailed" });
  assert.equal(searchDirect.parent.isError, false); assert.ok(isCardSearchOutput(searchDirect.children[0].result.structuredContent));
  assert.equal(searchDirect.children[0].result.structuredContent.data.cards[0].effort, 0);
  for (const [scenario, args, expectedOk, expectedRead] of [
    ["search-counts", { outputMode: "counts", format: "text" }, true, "complete"],
    ["search-validation", { location: "deck" }, false, "unknown"],
    ["api-error", {}, false, "incomplete"],
    ["partial-empty", { title: "No match", scanLimit: 500 }, true, "incomplete"],
    ["partial-failure", { scanLimit: 1000 }, false, "incomplete"],
  ] as const) {
    const result = await run(scenario, "codemode", searchScript(args));
    const child = result.children[0]; const value = child.result.structuredContent;
    assert.ok(isCardSearchOutput(value)); assert.equal(value.ok, expectedOk); assert.equal(value.completeness.read, expectedRead);
    assert.equal(child.isError, !expectedOk); assert.equal(result.parent.isError, false);
    assert.equal(result.parent.details.calls[0].status, expectedOk ? "ok" : "error");
    assert.equal(result.parent.nestedCalls.calls[0].status, expectedOk ? "ok" : "error");
    if (scenario === "partial-empty") { assert.equal(value.data.matches, 0); assert.equal(value.data.rowsExhaustive, false); }
    if (scenario === "search-counts") { assert.equal(value.data.returnedCards, 0); assert.equal(value.data.emittedRows, 1); assert.equal(value.data.rowsExhaustive, false); }
  }
  const direct = await run("direct", "codecks_card_get", { cardId: "seq:0" });
  const directValue = direct.children[0].result.structuredContent;
  assert.equal(direct.parent.isError, false); assert.ok(isCardGetOutput(directValue)); assert.equal(directValue.ok, true);
  assert.equal(directValue.card.accountSeq, 0); assert.equal(directValue.card.effort, 0); assert.equal(directValue.card.isDoc, false);
  assert.equal(directValue.card.dueDate, null); assert.equal(Object.hasOwn(directValue.card, "priority"), false);
  assert.equal(direct.fetches, 1); assert.match(text(direct.parent), /```json/);
  const nested = await run("nested-text", "codemode", script({ cardId: "seq:0", format: "text" }));
  assert.equal(nested.parent.isError, false); assert.equal(nested.children.length, 1); assert.equal(nested.parent.details.calls[0].status, "ok");
  assert.ok(isCardGetOutput(nested.children[0].result.structuredContent)); assert.doesNotMatch(text(nested.children[0].result), /```json/); assert.match(text(nested.parent), /"schemaVersion":1/);
  const directFailure = await run("direct-error", "codecks_card_get", {});
  assert.equal(directFailure.parent.isError, true); assert.equal(directFailure.children[0].result.structuredContent.ok, false); assert.equal(directFailure.children[0].result.structuredContent.error.code, "validation_error"); assert.equal(directFailure.fetches, 0);
  for (const scenario of ["domain-error", "api-error", "fetch-throws"]) {
    const args = scenario === "domain-error" ? {} : { cardId: "seq:0" };
    const result = await run(scenario, "codemode", script(args));
    assert.equal(result.parent.isError, false, `${scenario}: parent handles the child's data failure`);
    assert.equal(result.children.length, 1); const child = result.children[0];
    assert.equal(child.isError, true, scenario); assert.ok(isCardGetOutput(child.result.structuredContent)); assert.equal(child.result.structuredContent.ok, false);
    assert.equal(result.parent.details.calls[0].status, "error"); assert.equal(result.parent.nestedCalls.calls[0].status, "error");
    assert.match(text(result.parent), /"ok":false/); assert.doesNotMatch(text(result.parent), /misleading success text|unexpected text fallback/);
  }
  const oversized = await run("producer-bytes", "codemode", script({ cardId: "seq:0" }));
  assert.equal(oversized.parent.isError, false); assert.equal(oversized.children[0].isError, true);
  assert.ok(isCardGetOutput(oversized.children[0].result.structuredContent));
  assert.equal(oversized.children[0].result.structuredContent.ok, false);
  assert.equal(oversized.children[0].result.structuredContent.error.code, "output_too_large");
  assert.equal(oversized.parent.details.calls[0].status, "error"); assert.equal(oversized.parent.nestedCalls.calls[0].status, "error");
  assert.doesNotMatch(JSON.stringify(oversized.children[0].result), /😀/);
  const blocked = await run("blocked", "codemode", { code: `try { await tools.codecks_card_get({cardId:"seq:0"}); throw Error("must reject"); } catch (error) { text(String(error)); }` });
  assert.equal(blocked.parent.isError, false); assert.equal(blocked.parent.details.calls[0].status, "error"); assert.equal(blocked.fetches, 0);
  assert.equal(blocked.children[0].isError, true); assert.equal(blocked.children[0].result.structuredContent, undefined); assert.match(text(blocked.parent), /synthetic policy block/);
  const clipped = await run("producer-clipping", "codemode", script({ cardId: "seq:0" }));
  assert.equal(clipped.children[0].isError, false); assert.equal(clipped.children[0].result.structuredContent.completeness.projection, false);
  assert.equal(clipped.children[0].result.structuredContent.card.title.length, 2048); assert.equal(clipped.children[0].result.structuredContent.card.content.length, 32768);
  for (const scenario of ["partial-zero", "partial-one", "partial-failure"]) {
    const result = await run(scenario, "codemode", script({ title: "Possible match" }));
    assert.equal(result.parent.isError, false); assert.equal(result.children[0].isError, true);
    const value = result.children[0].result.structuredContent; assert.ok(isCardGetOutput(value)); assert.equal(value.error.code, "incomplete_read"); assert.equal(value.completeness.read, "incomplete");
    assert.equal(value.evidence?.candidates?.length ?? 0, scenario === "partial-zero" ? 0 : 1);
    assert.equal(result.fetches, scenario === "partial-failure" ? 2 : 6, "unchanged 3000-row bounded scan; no detail read, broaden, or fallback");
  }
  const thrown = await run("thrown", "codemode", { code: `try { await tools.pilot_throw({}); throw Error("must reject"); } catch (error) { text(String(error)); }` });
  assert.equal(thrown.parent.isError, false); assert.equal(thrown.parent.details.calls[0].status, "error"); assert.match(text(thrown.parent), /synthetic thrown execution/);
  const aborted = await run("aborted", "pilot_abort", {});
  assert.equal(aborted.parent.isError, false); assert.equal(aborted.parent.details.childIsError, true); assert.equal(aborted.fetches, 0);
  const abortedOutcome = records.find(r => r.abortedOutcome)?.abortedOutcome;
  assert.ok(abortedOutcome); assert.equal(abortedOutcome.isError, true);
  // Pre-aborted nested calls may short-circuit before finalization; they remain native failures, never success text.
  if (abortedOutcome.result.structuredContent !== undefined) { assert.ok(isCardGetOutput(abortedOutcome.result.structuredContent)); assert.equal(abortedOutcome.result.structuredContent.ok, false); }
  const replaced = await run("content-only", "codemode", { code: `const value = await tools.codecks_card_get({cardId:"seq:0"}); text({type:typeof value,value});` });
  assert.equal(replaced.parent.isError, false); assert.match(text(replaced.parent), /"type":"string"/);
  assert.match(text(replaced.parent), /hook intentionally replaced content/);
  assert.equal(replaced.children[0].result.structuredContent, undefined);
  assert.equal(replaced.parent.details.calls[0].status, "ok", "Pi content-only replacement drops DTO; Codecks does not repair other extensions");
  } else {
    for (const order of ["before", "after"] as const) {
      session = await makeSession(order);
      for (const scenario of ["structured-secret", "text-secret", "details-secret", "identifier-secret", "literal-secret", "enum-secret", "error-text-secret", "expansion-secret"]) {
        const domainError = ["enum-secret", "error-text-secret"].includes(scenario);
        const result = await run(scenario, "codemode", script(domainError ? {} : { cardId: "seq:0" }));
        const child = result.children[0]; assert.equal(child.isError, domainError); assert.equal(result.parent.isError, false);
        const value = child.result.structuredContent;
        // A schema-unaware redactor cannot guarantee literals/enumerations survive arbitrary modifications.
        assert.equal(isCardGetOutput(value), !["literal-secret", "enum-secret", "expansion-secret"].includes(scenario));
        assert.equal(result.parent.details.calls[0].status, domainError ? "error" : "ok");
        assert.equal(result.parent.nestedCalls.calls[0].status, domainError ? "error" : "ok");
        await writeFile(auditPath, JSON.stringify({ child, parent: result.parent }));
        const audit = await readFile(auditPath, "utf8"); assert.equal(audit.includes(onDiskSecret), false); assert.ok(audit.includes("[REDACTED]"));
        if (!domainError) {
          assert.equal(value.card.isDoc, false); assert.equal(value.card.effort, 0); assert.equal(value.card.accountSeq, 0); assert.equal(value.card.dueDate, null);
          if (scenario === "structured-secret") assert.equal(value.card.content, "[REDACTED]");
          else assert.equal(value.card.content, "Fixture body");
          if (scenario === "expansion-secret") {
            assert.ok(isCardGetOutput((state as any).beforeRedaction), "pre-redaction fixture respects producer schema and bounds");
            assert.equal((state as any).beforeRedaction.card.title.length, 1500);
            assert.equal(value.card.title.length, 2750, "schema-unaware redaction can expand a previously bounded string");
            assert.equal(audit.includes(state.shortSecret), false, "generated short GitHub fixture secret is absent on disk after redaction");
          }
          if (scenario === "identifier-secret") assert.equal(value.card.cardId, "[REDACTED]");
          if (scenario === "literal-secret") assert.equal(value.card.contentTrust, "[REDACTED]", "invalid literal is not repaired or resurrected");
        } else if (scenario === "enum-secret") assert.equal(value.error.code, "[REDACTED]", "invalid enumeration is not repaired");
      }
    }
  }
  assert.deepEqual(extensionErrors, []); assert.equal(realTransport, 0); assert.equal(modelCalls, turns * 2);
  assert.ok(requests.length > 0); assert.ok(fakeFetches > 0);
  console.log(`Real Pi card_get/search host passed: ${turns} local scripted turns, ${modelCalls} provider calls, ${fakeFetches} fake Codecks fetches, zero real transports; ${compatibility ? "optional Safety Rails compatibility in both load orders" : "Codecks alone producer contract and isolated Pi hook behavior"} verified.`);
} finally {
  for (const session of sessions) await session.dispose();
  globalThis.fetch = originalFetch; delete (globalThis as any).__piCardGetOutputTest;
  for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(fixture, { recursive: true, force: true });
}
