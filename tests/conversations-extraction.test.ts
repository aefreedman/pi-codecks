import assert from "node:assert/strict";
import { assertContractIdentity } from "./structured-contract-inventory.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as original from "../src/codecks-core.ts";
import * as reads from "../src/tools/conversations/reads.ts";
import * as writes from "../src/tools/conversations/writes.ts";
import * as diagnostics from "../src/tools/conversations/diagnostics.ts";
import * as helpers from "../src/tools/conversations/helpers.ts";
import { CONVERSATION_TOOL_DEFINITIONS } from "../src/tools/conversations/definitions.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
// Metadata now lives in domain definitions; exercise the actual integrated catalog.
const TOOL_CONFIG = Object.fromEntries(CONVERSATION_TOOL_DEFINITIONS.map(({ exportName }) => [exportName, getCodecksToolDefinition(exportName).config]));
import { composeCodecksToolCatalog } from "../src/pi/tool-definition.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
const moved = { ...reads, ...writes, ...diagnostics };
const cardId = "11111111-1111-4111-8111-111111111111";
const fixedNow = Date.parse("2026-10-01T00:00:00Z");
const SavedDate = Date;
const savedFetch = globalThis.fetch;
globalThis.Date = class extends SavedDate {
  constructor(value?: any) { super(value === undefined ? fixedNow : value); }
  static now() { return fixedNow; }
} as DateConstructor;
type Mode = "normal" | "missing" | "closed" | "block" | "review" | "other-author" | "stale-version" | "org" | "org-verified" | "forbidden" | "stale";
let mode: Mode = "normal";
let requests: any[] = [];
const clean = (value: any): any => Array.isArray(value) ? value.map(clean) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "sessionId" ? "<session>" : clean(item)])) : value;
const responseData = (query: any) => {
  const data: any = { _root: { loggedInUser: "user-1", account: "account-1" }, user: { "user-1": { id: "user-1", name: "Self", kind: mode === "org-verified" ? "api_token" : "human", isIntegration: mode === "org-verified" }, "user-2": { id: "user-2", name: "Other" } }, account: { "account-1": { id: "account-1" } }, card: {}, resolvable: {}, resolvableEntry: {} };
  const entry: any = { entryId: "entry-1", content: "Original", version: mode === "stale-version" ? 3 : 2, author: mode === "other-author" ? "user-2" : "user-1", createdAt: mode === "stale" ? "2026-09-01T00:00:00Z" : "2026-09-30T23:00:00Z" };
  const thread: any = { id: "res-1", card: cardId, context: mode === "block" ? "block" : "review", isClosed: ["closed", "org", "org-verified"].includes(mode), entries: ["entry-1"], createdAt: entry.createdAt };
  const card: any = { cardId, accountSeq: 1, title: "Synthetic", content: "Synthetic", status: "started", derivedStatus: null, isDoc: false, assignee: "user-1", resolvables: ["res-1"] };
  if (mode !== "missing") { data.card[cardId] = card; data.resolvable["res-1"] = thread; data.resolvableEntry["entry-1"] = { ...entry, resolvable: "res-1" }; }
  // Populate only relations actually requested, retaining native false/null/zero fields.
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, fields] of Object.entries(node)) {
      if (/^card\(/.test(key)) data[key] = mode === "missing" ? null : cardId;
      if (/^resolvable\(/.test(key)) data[key] = mode === "missing" ? null : "res-1";
      if (/^resolvableEntry\(/.test(key)) data[key] = mode === "missing" ? null : "entry-1";
      if (/^cards(?:\(|$)/.test(key)) data.account["account-1"][key] = mode === "missing" ? [] : [cardId];
      if (/^resolvables(?:\(|$)/.test(key)) card[key] = mode === "missing" ? [] : ["res-1"];
      if (/^entries(?:\(|$)/.test(key)) thread[key] = ["entry-1"];
      if (/^participations(?:\(|$)/.test(key)) data.user["user-1"][key] = [];
      if (/^participants(?:\(|$)/.test(key)) thread[key] = [];
      visit(fields);
    }
  };
  visit(query);
  return data;
};
globalThis.fetch = (async (_url, init) => {
  resetRateGate();
  const body = JSON.parse(String(init?.body ?? "{}"));
  requests.push(clean(body));
  if (mode === "forbidden") return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  return new Response(JSON.stringify({ data: body.query ? responseData(body.query) : {} }), { status: 200 });
}) as typeof fetch;
const invoke = async (tool: any, args: any) => {
  resetRateGate(); requests = [];
  try { return { result: clean(await tool.execute(args)), requests: [...requests] }; }
  catch (error) { return { error: String(error), requests: [...requests] }; }
};
try {
  const catalog = composeCodecksToolCatalog(CONVERSATION_TOOL_DEFINITIONS);
  assert.equal(catalog.size, 13);
  for (const definition of CONVERSATION_TOOL_DEFINITIONS) {
    const name = definition.exportName;
    assert.equal(definition.tool, moved[name]);
    assert.deepEqual(definition.config.parameters, TOOL_CONFIG[name].parameters, `${name} schema`);
    assert.deepEqual(definition.config.promptGuidelines, TOOL_CONFIG[name].promptGuidelines);
    assert.equal(definition.config.promptSnippet, TOOL_CONFIG[name].promptSnippet);
    for (const input of [{ card: "$1", text: "hello", outputFormat: "json", threadId: "res-1", commentId: "entry-1" }, { cardId, content: "hello", format: "text" }, {}]) {
      assert.deepEqual(definition.config.prepareArguments?.(input), TOOL_CONFIG[name].prepareArguments?.(input), `${name} aliases`);
    }
    await assertContractIdentity(definition);
    let registered: any;
    registerCodecksTool({ registerTool: (tool: any) => { registered = tool; } } as any, definition, definition.tool.description!, true, () => "PERSONAL");
    assert.equal(registered.name, `codecks_${name}`);
    assert.deepEqual(registered.parameters, TOOL_CONFIG[name].parameters);
    const args = { cardId, resolvableId: "res-1", entryId: "entry-1", content: "Changed", expectedVersion: 2, scanLimit: 1, detailLimit: 1, limit: 1, probeResolvableRelations: ["participants"], probeUserRelations: ["participations"], probeResolvableFields: [], probeUserFields: [] };
    for (const scenario of ["normal", "missing", "closed", "block", "other-author", "stale-version", "forbidden", "stale", "org", "org-verified"] as Mode[]) {
      mode = scenario;
      process.env.CODECKS_PROFILE = scenario.startsWith("org") ? "ORG" : "PERSONAL";
      process.env.CODECKS_PROFILE_ORG_TOKEN = "cdxat_synthetic-test-token";
      for (const format of ["text", "json"]) {
        const baseline = await invoke(original[name], { ...args, format });
        const extracted = await invoke(moved[name], { ...args, format });
        assert.deepEqual(extracted, baseline, `${name}/${scenario}/${format}: exact text/native error/request correspondence`);
        if (name === "card_add_comment" && scenario === "normal") {
          assert.equal(extracted.requests.length, 3, "comment: card read, actor read, exactly one dispatch");
          assert.equal(extracted.requests[2].context, "comment");
        }
        if (scenario === "org") assert(extracted.requests.every(request => request.query), `${name}: unverified ORG actor never dispatches`);
        if ((name === "card_add_review" && scenario === "block") || (name === "card_add_block" && scenario === "normal") || (name === "card_edit_resolvable_entry" && ["other-author", "stale-version"].includes(scenario))) {
          assert(extracted.requests.every(request => request.query), `${name}/${scenario}: must not dispatch`);
        }
      }
    }
    mode = "missing";
    process.env.CODECKS_PROFILE = "PERSONAL";
    resetRateGate();
    const adapted = await registered.execute("direct-lane", { ...args, format: "json" }, undefined, undefined, { cwd: process.cwd() });
    assert(adapted.content.length > 0, `${name}: canonical adapter produces a result`);
    let baselineAdapter: any;
    registerCodecksTool({ registerTool: (tool: any) => { baselineAdapter = tool; } } as any,
      { exportName: name, tool: original[name], config: TOOL_CONFIG[name] }, definition.tool.description!, true, () => "PERSONAL");
    resetRateGate();
    const baselineAdapted = await baselineAdapter.execute("baseline", { ...args, format: "json" }, undefined, undefined, { cwd: process.cwd() });
    assert.deepEqual(adapted.content, baselineAdapted.content, `${name}: legacy text/json matches canonical adaptation`);
    assert.deepEqual(adapted.details, baselineAdapted.details, `${name}: legacy renderer details retained`);
    if (definition.outputSchema) {
      assert.equal(adapted.structuredContent.ok, false);
      assert.equal(adapted.isError, true);
    } else assert.deepEqual(adapted, baselineAdapted);
  }
  assert.equal(helpers.computeResolvableBubbleHeuristic({ bucket: "new_activity", context: "review" }), "unread");
  assert.equal(helpers.computeResolvableBubbleHeuristic({ bucket: "resurfaced", context: "review" }), "stale_review");
  assert.equal(helpers.computeResolvableBubbleHeuristic({ bucket: "resurfaced", context: "comment" }), "read");
  assert.equal(helpers.looksLikeContentEditIntent("append a code block"), true);
  assert.equal(helpers.looksLikeContentEditIntent("hello"), false);
  assert.equal(helpers.resolvableDebugRelations.participants.order, "-firstJoinedAt");
  assert.equal(helpers.resolvableDebugRelations.entries.order, "-createdAt");
  assert.equal(helpers.userDebugRelations.participations.order, "-firstJoinedAt");
  // Every moved declaration's complete body must match the retained source, allowing only export modifiers.
  const declarations = (source: string) => {
    source = source.replace(/\r\n/g, "\n");
    const starts = [...source.matchAll(/^(?:export )?(?:const|type|interface|function|class) (\w+)/gm)];
    return new Map(starts.map((match, i) => [match[1], source.slice(match.index, starts[i + 1]?.index ?? source.length).trim().replace(/^export /, "")]));
  };
  // Complete frozen foundation bodies (aa510b6), independent of the transitional facade.
  const baselineHashes: Record<string, string> = {
    "debug_logged_in_user_resolvable_participation": "57523dc350be5df5998be40dba8f405c526f99ca02c9332772506a424accdfe0",
    "debug_logged_in_user_resolvables": "8eaaca73eab2504c3e62cfb534c68a2bb6c096fc9be22ac56b2edd18badf9129",
    "resolveResolvableTarget": "f159fd516256913b8f76a6b8f474e8cb4dac36f2d42458764186af821d94b710",
    "ResolvableActionBucket": "5effe27492a411c11462c5a72d78c707f00ac4c5e50e198b438e636bccb3ad45",
    "ResolvableBubbleHeuristic": "84c224f1f62f5b753dbf3b81451ef8d7843f2c1c96fc76c31adb1e46eae8e702",
    "computeResolvableBubbleHeuristic": "ccc2b098a8e2491d7fc9a22e9ee71d8c6bb26bd42cb5c9cc90b6c9d5ad52e613",
    "looksLikeContentEditIntent": "d90652b64876c968b4bc51b60a55c55db24f0e6b5d08727695c4b92006a33931",
    "addBlockerResolvable": "8ed44c824332ff3830e30bbcd649f7567cb099710c47fd260912ce922cae3f80",
    "resolvableDebugRelations": "d9bc01a0da6af72255c6bc7f7ae3d6ed728b6860704a6dda09f5c71c7c009117",
    "userDebugRelations": "9928b5fc41999d2b9dea7ad235338a131665ad51fe5d29c7dce0b8e9b1a384fd",
    "card_list_resolvables": "9c0331449dc0eb0afb348c80629788c8db8243237b54d23c4daa8593327a16ff",
    "list_open_resolvable_cards": "a42c617acc4054ba87be1a20534e88fa34cfc2074a8cd52bc06c01e5f68ebfef",
    "list_logged_in_user_actionable_resolvables": "d5f02f13a42ae7058f9c73d15f78bf820bfd94403981f76464b918e4376be2bc",
    "card_add_comment": "a5fba8684618f08cc7c974ca556e03a1deaa0ffa7d3caf201f1e0cbad06a06a0",
    "card_add_review": "16cedd9879e0a5751a0d26fbd0c116f150bbfbaf37ad9079438edaabcd44dfe4",
    "card_add_blocker": "8651b1a6940b1a5ecc148917bcf510b7bb4ca92bfdceb8cf0c4a0989cb3b2536",
    "card_add_block": "77ea739cce34c9a4ed1dba7eacecd7f04cf9ed20fd1bf5d6d3a573f0edf23254",
    "card_reply_resolvable": "f2608c8faf0bc8790d6507fd7643eb15cddae70e3930a983488360bccaae929e",
    "card_edit_resolvable_entry": "edf6cf43833b4b71af1a09bc7e4f3546b00dbb30d1ff3da32f785af123462e4b",
    "card_close_resolvable": "e1405c029ecfb49db40700cfe546c10a3ea91ef655ae05b1c162d55f3c4066f4",
    "card_reopen_resolvable": "33a653ade0024c0a88a45998bbf090ad5733df36896b7f5e2c36fb02645929b1"
};
  let compared = 0;
  for (const file of ["reads", "writes", "diagnostics", "helpers"]) {
    const source = readFileSync(new URL(`../src/tools/conversations/${file}.ts`, import.meta.url), "utf8");
    assert(!source.includes('from "../../codecks-core') && !source.includes('from "../../tools/'), "no facade or other domain imports");
    for (const [name, body] of declarations(source)) {
      if (!["debug_logged_in_user_resolvable_participation", "debug_logged_in_user_resolvables", "resolveResolvableTarget", "ResolvableActionBucket", "ResolvableBubbleHeuristic", "computeResolvableBubbleHeuristic", "looksLikeContentEditIntent", "resolvableDebugRelations", "userDebugRelations"].includes(name)) continue;
      assert.equal(createHash("sha256").update(body).digest("hex"), baselineHashes[name], `${name}: unchanged complete frozen source body`); compared++;
    }
  }
  assert.equal(compared, 9);
  // Migrated operation bodies intentionally changed: their frozen-base request/text
  // comparisons (418 combinations) live in conversations-structured-output.test.ts.
  console.log("conversations extraction: 13 direct tools, 260 differential scenarios, metadata/aliases/adapter and 9 unchanged source declarations passed");
} finally {
  globalThis.fetch = savedFetch;
  globalThis.Date = SavedDate;
  resetRateGate();
}
