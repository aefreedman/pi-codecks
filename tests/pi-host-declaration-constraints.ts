import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

// Real file-loaded Codecks + Pi's QuickJS describeTool, never a renderer imitation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const declaredPi = JSON.parse(await readFile(join(root, "package.json"), "utf8")).devDependencies;
const sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
assert.ok(sdkUrl.startsWith(new URL("../node_modules/", import.meta.url).href), "use the package-local SDK, not a global installation");
const piVersion = JSON.parse(await readFile(new URL("../package.json", sdkUrl), "utf8")).version;
assert.equal(piVersion, declaredPi["@earendil-works/pi-coding-agent"], "validate the exact manifest-selected installed runtime");
const piAiUrl = (() => { try { return import.meta.resolve("@earendil-works/pi-ai"); } catch { return new URL("../node_modules/@earendil-works/pi-ai/dist/index.js", sdkUrl).href; } })();
const piAi = await import(piAiUrl);
const fixture = await mkdtemp(join(tmpdir(), "pi-codecks-declarations-"));
const extensionPath = join(root, "index.ts");
const names = ["codecks_card_search", "codecks_card_get_batch", "codecks_card_bulk_create", "codecks_milestone_list"];
const keys = new Set([...Object.keys(process.env).filter(key => /^(?:CODECKS_|PI_CODECKS_)/.test(key)), "CODECKS_CREDENTIAL_PROVIDER", "PI_CODECKS_TOOL_LOADING_MODE"]);
const previous = Object.fromEntries([...keys].map(key => [key, process.env[key]]));
for (const key of keys) delete process.env[key];
process.env.CODECKS_CREDENTIAL_PROVIDER = "environment";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";
const originalFetch = globalThis.fetch;
let fetches = 0, modelCalls = 0;
globalThis.fetch = (async () => { fetches++; throw Error("Declaration coverage must never use transport"); }) as typeof fetch;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let session: any;
const errors: unknown[] = [], executions: string[] = [];

// Associate tags with their property, not arbitrary matching output-schema text.
function propertyTags(input: string, property: string): string {
  const lines = input.split("\n");
  const index = lines.findIndex(line => new RegExp(`^\\s*${property}\\??:`).test(line));
  assert.ok(index >= 0, `missing input property ${property}`);
  const comments: string[] = [];
  for (let i = index - 1; i >= 0 && /^\s*\/\//.test(lines[i]); i--) comments.unshift(lines[i]);
  return comments.join("\n");
}
function visit(schema: any, check: (node: any) => void) {
  if (!schema || typeof schema !== "object") return;
  check(schema);
  for (const value of Object.values(schema)) if (value && typeof value === "object") visit(value, check);
}
try {
  const modelRuntime = await ModelRuntime.create({ authPath: join(fixture, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider("declarations-local", {
    api: "declarations-scripted", baseUrl: "http://127.0.0.1:9/never-connect", apiKey: "synthetic-model-inert",
    models: [{ id: "fixture", name: "Local declarations fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 256 }],
    streamSimple: (model, context) => {
      modelCalls++;
      const stream = piAi.createAssistantMessageEventStream();
      const message: any = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "pending", timestamp: Date.now() };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        if (context.messages.at(-1)?.role !== "toolResult") {
          const call = { type: "toolCall", id: "declarations-1", name: "codemode", arguments: { code: `text(await Promise.all(${JSON.stringify(names)}.map(async name => { const declaration = await describeTool(name); if (typeof declaration !== 'string') throw Error('missing declaration: ' + name); return { name, declaration: declaration.slice(0, declaration.indexOf('): Promise<')) }; })));` } };
          message.content.push(call);
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = "toolUse"; stream.push({ type: "done", reason: "toolUse", message });
        } else {
          message.content.push({ type: "text", text: "Declarations complete" });
          message.stopReason = "stop"; stream.push({ type: "done", reason: "stop", message });
        }
      });
      return stream;
    },
  });
  const services = await createAgentSessionServices({ cwd: fixture, agentDir: join(fixture, "agent"), modelRuntime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: { additionalExtensionPaths: [extensionPath], extensionFactories: [createCodemodeExtension({ mode: "on", models: false })], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "Run only the local declaration fixture." },
  });
  assert.deepEqual(services.diagnostics.filter(d => d.type === "error"), []);
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const model = modelRuntime.getModel("declarations-local", "fixture"); assert.ok(model);
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(fixture), model, thinkingLevel: "off", tools: [...names, "codemode"] }));
  await session.bindExtensions({});
  session.extensionRunner.onError((error: unknown) => errors.push(error));
  session.subscribe((event: any) => { if (event.type === "tool_execution_start") executions.push(event.toolName); });
  for (const name of names) {
    assert.equal(resolve(session.getAllTools().find((tool: any) => tool.name === name).sourceInfo.path), extensionPath);
    // The registered Pi inputs, not older core schemas, are the declaration contract.
    visit(session.getToolDefinition(name).parameters, node => {
      assert.notEqual(node.type, "integer", `${name}: no integer input is declared`);
      assert.equal(Object.hasOwn(node, "pattern"), false, `${name}: no input pattern is declared`);
      assert.equal(Object.hasOwn(node, "default"), false, `${name}: no schema default is declared`);
    });
  }
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([session.prompt("Inspect the four representative declarations only."), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Declaration fixture timed out")), 20000); })]); }
  finally { clearTimeout(timer!); }
  const result = session.messages.filter((m: any) => m.role === "toolResult").at(-1);
  assert.ok(result); assert.equal(result.isError, false);
  const output = result.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
  const jsonStart = output.indexOf('[{"name":'); assert.ok(jsonStart >= 0, output);
  const declarations = JSON.parse(output.slice(jsonStart).trim()) as { name: string; declaration: string }[];
  assert.deepEqual(declarations.map(item => item.name), names);
  const inputs = new Map(declarations.map(({ name, declaration }) => {
    assert.equal(typeof declaration, "string");
    assert.ok(declaration.includes(`${name}(args:`), `describeTool must return the ${name} signature`);
    assert.match(declaration, /codemode tool declaration:/);
    const input = declaration.split(`${name}(args:`)[1].split("): Promise<")[0];
    assert.doesNotMatch(input, /@integer|@pattern|@default/, `${name}: do not invent absent input constraints/defaults`);
    return [name, input];
  }));
  const search = inputs.get("codecks_card_search")!;
  for (const [property, maximum] of [["limit", 3000], ["scanLimit", 10000], ["pageSize", 500]] as const) {
    const schema = session.getToolDefinition("codecks_card_search").parameters.properties[property];
    assert.equal(schema.type, "number"); assert.equal(schema.minimum, 1); assert.equal(schema.maximum, maximum);
    const tags = propertyTags(search, property);
    assert.match(tags, /@minimum 1\b/);
    assert.deepEqual([...tags.matchAll(/@maximum\s+(\S+)/g)].map(match => match[1]), [String(maximum)], `${property}: exact maximum annotation`);
    assert.match(search, new RegExp(`${property}\\?: number;`));
  }
  assert.match(propertyTags(inputs.get("codecks_card_get_batch")!, "cardIds"), /@minItems 1\b.*@maxItems 25\b/);
  assert.match(inputs.get("codecks_card_get_batch")!, /cardIds: Array<string \| number>;/);
  const bulk = inputs.get("codecks_card_bulk_create")!;
  assert.match(propertyTags(bulk, "cards"), /@minItems 1\b.*@maxItems 100\b/);
  assert.match(propertyTags(bulk, "correlationKey"), /@minLength 1\b.*@maxLength 200\b/);
  assert.match(bulk, /correlationKey\?: string;/);
  // milestone_list's old core .int() and prose "Defaults to 100" are NOT registered schema keywords.
  assert.match(propertyTags(inputs.get("codecks_milestone_list")!, "limit"), /@minimum 1\b.*@maximum 500\b/);
  assert.deepEqual(executions, ["codemode"], "describeTool must not execute Codecks reads or writes");
  assert.equal(fetches, 0); assert.equal(modelCalls, 2); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", pi: piVersion, declarations: names.length, scriptedTurns: 1, modelCalls, fetches, codecksExecutions: 0, inputConstraints: ["minimum/maximum", "minLength/maxLength", "minItems/maxItems"], absentRepresentativeInputKeywords: ["integer", "pattern", "default"] }));
} finally {
  await session?.dispose(); globalThis.fetch = originalFetch;
  for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(fixture, { recursive: true, force: true });
}
