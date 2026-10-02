import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { CONVERSATION_TOOL_DEFINITIONS } from "../src/tools/conversations/definitions.ts";
import { CONVERSATION_READ_ACTIONS, CONVERSATION_READ_SCHEMAS, CONVERSATION_READ_LIMITS, projectConversationReadOutput, hasConversationReadByteBudget } from "../src/tools/conversations/conversations-read-output.ts";
import { CONVERSATION_WRITE_ACTIONS, CONVERSATION_WRITE_SCHEMAS, CONVERSATION_WRITE_LIMITS, projectConversationWriteOutput, hasConversationWriteByteBudget } from "../src/tools/conversations/conversations-write-output.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { runWithAbortSignal, getOperationContext } from "../src/runtime/operation-context.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();

// Execute actual frozen producers with the same canonical singleton infrastructure.
// The fixture is private/temporary, never an alternate production implementation.
const base = "764e46695b7e936616538350b414d4f40a00811e";
const fixtureRoot = mkdtempSync(join(tmpdir(), "codecks-conversations-baseline-"));
console.error("conversations fixture: setup begun");
writeFileSync(join(fixtureRoot, "package.json"), JSON.stringify({ type: "module" }));
const owner = resolve("src/tools/conversations");
for (const file of ["helpers", "reads", "writes"]) {
  const source = execFileSync("git", ["show", `${base}:src/tools/conversations/${file}.ts`], { encoding: "utf8" });
  const redirected = source.replace(/from "([^"]+)"/g, (_, specifier) => {
    const destination = specifier === "./helpers" ? join(fixtureRoot, "helpers.ts") : resolve(owner, specifier + ".ts");
    return `from "${pathToFileURL(destination).href}"`;
  });
  writeFileSync(join(fixtureRoot, file + ".ts"), redirected);
}
console.error("conversations fixture: importing frozen ESM modules");
const baseline = { ...await import(pathToFileURL(join(fixtureRoot, "reads.ts")).href), ...await import(pathToFileURL(join(fixtureRoot, "writes.ts")).href) };
console.error("conversations fixture: frozen imports settled");
const savedFetch = globalThis.fetch, SavedDate = Date;
const now = Date.parse("2026-10-01T00:00:00Z");
globalThis.Date = class extends SavedDate { constructor(value?: any) { super(value === undefined ? now : value); } static now() { return now; } } as DateConstructor;
const cardId = "11111111-1111-4111-8111-111111111111";
let mode = "normal", requests: any[] = [], variant: Record<string, unknown> = {};
const clean = (value: any): any => Array.isArray(value) ? value.map(clean) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "sessionId" ? "<session>" : clean(item)])) : value;
const queryData = (query: any) => {
  const data: any = { _root: { loggedInUser: "user-1", account: "account-1" }, user: { "user-1": { id: "user-1", name: "Self", kind: mode === "org-verified" ? "api_token" : "human", isIntegration: mode === "org-verified" }, "user-2": { id: "user-2", name: "Other" } }, account: { "account-1": { id: "account-1" } }, card: {}, resolvable: {}, resolvableEntry: {} };
  const entry: any = { entryId: "entry-1", content: mode === "no-op" ? "Changed" : "Original", version: mode === "stale-version" ? 3 : 2, author: mode === "other-author" || mode === "actionable" ? "user-2" : "user-1", createdAt: mode === "stale" ? "2026-09-01T00:00:00Z" : "2026-09-30T23:00:00Z", ...variant };
  const thread: any = { id: "res-1", card: cardId, context: mode === "block" ? "block" : "review", isClosed: ["closed", "org", "org-verified"].includes(mode), entries: ["entry-1"], createdAt: entry.createdAt };
  const card: any = { cardId, accountSeq: 0, title: "Synthetic", content: "Synthetic", status: "started", derivedStatus: null, isDoc: mode === "doc", assignee: "user-1", resolvables: ["res-1"] };
  if (mode !== "missing") { data.card[cardId] = card; data.resolvable["res-1"] = thread; data.resolvableEntry["entry-1"] = { ...entry, resolvable: "res-1" }; }
  const visit = (node: any) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, fields] of Object.entries(node)) {
      if (/^card\(/.test(key)) data[key] = mode === "missing" ? null : cardId;
      if (/^resolvable\(/.test(key)) data[key] = mode === "missing" ? null : "res-1";
      if (/^resolvableEntry\(/.test(key)) data[key] = mode === "missing" ? null : "entry-1";
      if (/^cards(?:\(|$)/.test(key)) data.account["account-1"][key] = mode === "missing" ? [] : [cardId];
      if (/^resolvables(?:\(|$)/.test(key)) card[key] = mode === "missing" ? [] : ["res-1"];
      if (/^entries(?:\(|$)/.test(key)) thread[key] = mode === "empty-entries" ? [] : ["entry-1"];
      visit(fields);
    }
  }; visit(query);
  if (mode === "partial-details" && Object.keys(query).some(key => /^resolvable\(/.test(key))) data.resolvable = {};
  if (mode === "unresolved") { card.resolvables.push("missing-reference"); }
  if (mode === "missing-fields") { delete card.title; delete card.status; delete entry.content; delete data.resolvableEntry["entry-1"]?.content; delete thread.isClosed; delete thread.closedAt; }
  if (mode === "grouped") {
    const second = { ...card, cardId: "card-2", accountSeq: 2, resolvables: ["res-2"] };
    data.card["card-2"] = second; data.resolvable["res-2"] = { ...thread, id: "res-2", card: "card-2" };
    for (const key of Object.keys(data.account["account-1"])) if (key === "cards" || key.startsWith("cards(")) data.account["account-1"][key].push("card-2");
    data.resolvableEntry["entry-1"].author = "user-2";
  }
  return data;
};
globalThis.fetch = (async (url, init) => {
  assert(new URL(String(url)).pathname === "/" || new URL(String(url)).pathname.startsWith("/dispatch/resolvables/"), "fake-only canonical request path");
  resetRateGate(); const body = JSON.parse(String(init?.body ?? "{}")); requests.push({ path: new URL(String(url)).pathname, body: clean(body) });
  if (mode === "forbidden" || mode === "dispatch-rejected" && !body.query) return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  if (mode === "uncertain" && !body.query) throw Error("synthetic disconnected response");
  return new Response(JSON.stringify({ data: body.query ? queryData(body.query) : {} }), { status: 200 });
}) as typeof fetch;
const args = { cardId, resolvableId: "res-1", entryId: "entry-1", content: "Changed", expectedVersion: 2, scanLimit: 1, limit: 1 };
const invoke = async (fn: () => any) => { resetRateGate(); requests = []; try { return { result: await fn(), requests: [...requests] }; } catch (error) { return { error: String(error), requests: [...requests] }; } };
const register = (definition: any, profile = "PERSONAL") => { let registered: any; registerCodecksTool({ registerTool(t: any) { registered = t; } } as any, definition, "Fixture", false, () => profile); return registered; };
const adapted = (definition: any, input: any, signal?: AbortSignal) => register(definition, process.env.CODECKS_PROFILE).execute("fixture", input, signal, undefined, { cwd: process.cwd() });
const migrated = CONVERSATION_TOOL_DEFINITIONS.filter(d => d.executePayload);
assert.equal(migrated.length, 11, "all assigned producer seams are present");
assert.deepEqual(migrated.map(d => d.exportName).sort(), [...CONVERSATION_READ_ACTIONS, ...CONVERSATION_WRITE_ACTIONS].sort());

// All eleven seams and all producer branches are compared to the frozen implementation,
// including exact text/JSON and every query/dispatch body/order/count.
for (const definition of migrated) test(`${definition.exportName}: direct and registered frozen behavior, safety and native status`, async () => {
  for (const scenario of ["normal", "missing", "closed", "block", "other-author", "stale-version", "no-op", "forbidden", "stale", "actionable", "org", "org-verified", "doc", "dispatch-rejected", "uncertain", "empty-entries", "partial-details", "missing-fields", "unresolved"]) {
    console.error(`conversations fixture: ${definition.exportName}/${scenario}`);
    mode = scenario; variant = {};
    process.env.CODECKS_PROFILE = scenario.startsWith("org") ? "ORG" : "PERSONAL";
    process.env.CODECKS_PROFILE_ORG_TOKEN = "cdxat_synthetic-test-token";
    for (const format of ["text", "json"] as const) {
      const input = { ...args, format };
      const expected = await invoke(() => baseline[definition.exportName].execute(input));
      const actual = await invoke(() => definition.executePayload!(input));
      assert.deepEqual(actual.requests, expected.requests, `${scenario}/${format}: canonical request correspondence`);
      if (expected.error) { assert.equal(scenario, "forbidden", `unexpected fixture/native throw: ${expected.error}`); assert.equal(actual.error, expected.error); continue; }
      assert.equal(actual.result.text, expected.result, `${scenario}/${format}: frozen legacy presentation`);
      const dto: any = definition.projectOutput!(actual.result.payload);
      assert(Value.Check(definition.outputSchema!, dto), `${scenario}: closed DTO`);
      assert.notEqual(dto.error?.code, "output_contract_error", `${definition.exportName}/${scenario}: expected native producer payload to conform`);
      const throughAdapter = await invoke(() => adapted(definition, input));
      assert.deepEqual(throughAdapter.requests, expected.requests);
      assert.deepEqual(throughAdapter.result.structuredContent, dto);
      assert.equal(throughAdapter.result.isError, !dto.ok);
      assert.equal(throughAdapter.result.content[0].text, expected.result);
      const legacy = await invoke(() => definition.tool.execute(input));
      assert.equal(legacy.result, expected.result); assert.deepEqual(legacy.requests, expected.requests);
      if (scenario === "uncertain" && actual.requests.some(r => !r.body.query)) { assert.equal(dto.effect, "indeterminate"); assert.equal(dto.ok, false); assert.equal(actual.requests.filter(r => !r.body.query).length, 1); assert.equal(dto.replayPermitted, false); }
      if (scenario === "dispatch-rejected" && actual.requests.some(r => !r.body.query)) assert.equal(dto.effect, "definitely_rejected");
      if (definition.exportName === "card_edit_resolvable_entry" && ["other-author", "stale-version"].includes(scenario)) { assert.equal(dto.ok, false); assert.equal(dto.effect, "not_dispatched"); assert.equal(dto.error.code, scenario === "other-author" ? "forbidden" : "conflict"); assert(actual.requests.every(r => r.body.query)); }
      if (scenario === "org" && !definition.exportName.startsWith("list_") && definition.exportName !== "card_list_resolvables") assert(actual.requests.every(r => r.body.query), "unverified actor never dispatches");
    }
  }
});

test("complete empty card list versus sampled not_found inbox/actionable, raw null/false/zero/missing and partial details", async () => {
  process.env.CODECKS_PROFILE = "PERSONAL";
  const list = migrated.find(d => d.exportName === "card_list_resolvables")!;
  mode = "normal"; variant = { content: null, version: 0 };
  let dto: any = list.projectOutput!((await list.executePayload!(args)).payload);
  assert.equal(dto.data.card.accountSeq, 0); assert.equal(dto.data.card.derivedStatus, null); assert.equal(dto.data.threads[0].isClosed, false); assert.equal(dto.data.threads[0].entries[0].content, null); assert.equal(dto.data.threads[0].entries[0].version, 0); assert(!Object.hasOwn(dto.data.threads[0], "closedAt"));
  mode = "missing-fields"; variant = {};
  dto = list.projectOutput!((await list.executePayload!(args)).payload);
  assert(!Object.hasOwn(dto.data.card, "title")); assert(!Object.hasOwn(dto.data.threads[0], "isClosed")); assert(!Object.hasOwn(dto.data.threads[0].entries[0], "content"));
  mode = "partial-details"; dto = list.projectOutput!((await list.executePayload!(args)).payload);
  assert.equal(dto.ok, true); assert.equal(dto.completeness.read, "incomplete"); assert.equal(dto.data.threads[0].detailObserved, false); assert(!Object.hasOwn(dto.data.threads[0], "sourceEntries"));
  mode = "normal"; dto = list.projectOutput!((await list.executePayload!({ ...args, contexts: ["comment"] })).payload); assert.equal(dto.ok, true); assert.equal(dto.data.emittedThreads, 0); assert.equal(dto.completeness.read, "complete");
  mode = "missing";
  for (const definition of migrated.filter(d => d.exportName.startsWith("list_"))) { dto = definition.projectOutput!((await definition.executePayload!(args)).payload); assert.equal(dto.ok, false); assert.equal(dto.error.code, "not_found"); assert.equal(dto.completeness.read, "incomplete"); assert.equal(dto.data.scannedCards, 0); }
});

test("aliases, blocker warning/action, actor and edit no-op/version evidence; exact once operation scope", async () => {
  process.env.CODECKS_PROFILE = "PERSONAL"; mode = "block"; variant = {};
  const alias = migrated.find(d => d.exportName === "card_add_block")!;
  const main = migrated.find(d => d.exportName === "card_add_blocker")!;
  assert.deepEqual(alias.config.prepareArguments!({ card: "$1", text: "Hi", outputFormat: "json" }), { card: "$1", text: "Hi", outputFormat: "json", cardId: "$1", content: "Hi" });
  mode = "missing"; // Alias errors retain their own action too.
  assert.equal((await alias.executePayload!(args)).payload.action, "card_add_block");
  mode = "normal";
  const edit = migrated.find(d => d.exportName === "card_edit_resolvable_entry")!;
  mode = "no-op";
  const dto: any = edit.projectOutput!((await edit.executePayload!(args)).payload);
  assert.equal(dto.data.contentDiffersBefore, false); assert.equal(dto.data.versionBefore, 2); assert.equal(dto.data.expectedVersion, 2); assert.equal(dto.effect, "not_dispatched"); assert.equal(dto.data.actorId, "user-1");
  let calls = 0;
  await adapted({ ...edit, executePayload: async (input: any) => { calls++; assert(getOperationContext()); return edit.executePayload!(input); }, tool: { ...edit.tool, execute() { throw Error("must not invoke legacy"); } } }, args);
  assert.equal(calls, 1);
  mode = "block";
  const reply = migrated.find(d => d.exportName === "card_reply_resolvable")!;
  const nativeReply = await reply.executePayload!({ cardId, context: "blocker", content: "Changed" });
  const replyDto: any = reply.projectOutput!(nativeReply.payload);
  assert.equal(replyDto.ok, true); assert.equal(replyDto.data.context, "block"); assert.equal(replyDto.data.resolvableId, "res-1");
  const list = migrated.find(d => d.exportName === "card_list_resolvables")!;
  const nativeList = await list.executePayload!({ cardId, contexts: ["blocker"] });
  assert.equal((list.projectOutput!(nativeList.payload) as any).data.threads[0].context, "block");
  // Empty contexts permit blocker creation without extra query/dispatch.
  mode = "missing";
  assert.equal(main.exportName, "card_add_blocker");
  mode = "normal"; variant = { version: false };
  const malformedAfterSend = await invoke(() => adapted(edit, args));
  assert.equal(malformedAfterSend.requests.filter(r => !r.body.query).length, 1);
  assert.equal(malformedAfterSend.result.isError, true);
  assert.equal(malformedAfterSend.result.structuredContent.error.code, "output_contract_error");
  assert.equal(malformedAfterSend.result.structuredContent.effect, "dispatch_returned");
  assert.equal(malformedAfterSend.result.structuredContent.data.entryId, "entry-1");
  assert.equal(malformedAfterSend.result.structuredContent.replayPermitted, false);
  variant = {};
});

test("grouped recent scan preserves source versus emitted counts and heuristic evidence; alias successful warning", async () => {
  process.env.CODECKS_PROFILE = "PERSONAL"; mode = "grouped"; variant = {};
  for (const name of ["list_open_resolvable_cards", "list_logged_in_user_actionable_resolvables"]) {
    const definition = migrated.find(d => d.exportName === name)!;
    const native = await definition.executePayload!({ ...args, scanLimit: 2 });
    const dto: any = definition.projectOutput!(native.payload);
    assert.equal(dto.ok, true); assert.equal(dto.data.scannedCards, 2); assert.equal(dto.data.scanLimitReached, true);
    assert.equal(dto.data.groups[0].sourceCards, 2); assert.equal(dto.data.groups[0].emittedCards, 1); assert.equal(dto.data.groups[0].cardIds.length, 1);
    assert.equal(dto.completeness.read, "incomplete");
    if (name === "list_open_resolvable_cards") { assert.equal(dto.data.matchedCards, 2); assert.equal(dto.data.emittedCards, 1); assert.equal(dto.data.cards.length, 1); }
    else { assert.equal(dto.provenance.heuristic, true); assert.equal(dto.data.actionableResolvableCount, 2); assert.equal(dto.data.items[0].bubbleHeuristic, "unread"); assert.equal(dto.data.items[0].bucket, "new_activity"); }
  }
  mode = "closed";
  const definition = migrated.find(d => d.exportName === "card_add_block")!;
  const result = await invoke(() => definition.executePayload!(args));
  const dto: any = definition.projectOutput!(result.result.payload);
  assert.equal(dto.ok, true); assert.equal(dto.action, "card_add_block"); assert.equal(dto.data.isAlias, true); assert.match(result.result.text, /deprecated/); assert.equal(result.requests.filter(r => !r.body.query).length, 1);
});

test("pre-abort is definitely unsent/native, semantic errors resolve DTO and malformed seam fails closed without replay", async () => {
  mode = "normal"; process.env.CODECKS_PROFILE = "PERSONAL";
  const definition = migrated.find(d => d.exportName === "card_add_comment")!;
  const controller = new AbortController(); controller.abort();
  const result = await invoke(() => adapted(definition, args, controller.signal));
  assert.equal(result.requests.length, 0); assert(result.error?.includes("cancel") || result.result?.isError);
  const failure: any = await adapted({ ...definition, executePayload: async () => ({ text: "native error", payload: { schemaVersion: 1, action: definition.exportName, ok: false, effect: "not_dispatched", replayPermitted: false, facts: {}, error: { code: "validation_error", message: "Synthetic" } } }) }, args);
  assert.equal(failure.isError, true); assert.equal(failure.structuredContent.ok, false);
  for (const payload of [undefined, {}, { schemaVersion: 1, action: definition.exportName, ok: true, effect: "dispatch_returned", replayPermitted: false, facts: { cardId: "x".repeat(129), actorId: "user-1" } }]) {
    const malformed = await adapted({ ...definition, executePayload: async () => ({ text: "misleading", payload }) }, args);
    assert.equal(malformed.isError, true); assert.equal(malformed.structuredContent.ok, false); assert.notEqual(malformed.structuredContent.effect, "not_dispatched"); assert.equal(malformed.structuredContent.replayPermitted, false); assert.doesNotMatch(malformed.content[0].text, /misleading/);
  }
});

const readNative = (facts: any) => ({ schemaVersion: 1, action: "card_list_resolvables", ok: true, read: "complete", facts: { card: { cardId }, sourceThreads: 1, matchedThreads: 1, emittedThreads: 1, limit: 1, includeClosed: false, threads: [{ id: "res-1", isClosed: false, detailObserved: true, sourceEntries: 1, observedEntries: 1, entries: [{ entryId: "entry-1", content: "", version: 0 }] }], ...facts } });
test("all read/write schemas closed and malformed scalars/discriminators/identities fail; bounds do not authorize writes", () => {
  for (const [action, schema] of Object.entries({ ...CONVERSATION_READ_SCHEMAS, ...CONVERSATION_WRITE_SCHEMAS })) {
    const dto: any = action in CONVERSATION_READ_SCHEMAS ? projectConversationReadOutput(action as any, undefined) : projectConversationWriteOutput(action as any, undefined);
    assert(Value.Check(schema, dto)); assert(!Value.Check(schema, { ...dto, rawTransport: {} }));
  }
  for (const native of [undefined, {}, { ...readNative({}), ok: "true" }, { ...readNative({}), action: "invented" }, readNative({ card: { cardId: "x".repeat(129) } }), readNative({ card: { title: false } }), readNative({ card: { accountSeq: -1 } })]) assert.equal(projectConversationReadOutput("card_list_resolvables", native).ok, false);
  const dto: any = projectConversationReadOutput("card_list_resolvables", readNative({ card: { title: "😀".repeat(2049) } })); assert.equal(dto.ok, true); assert.equal(Array.from(dto.data.card.title).length, 2048); assert.equal(dto.completeness.projection, false);
  const thread = readNative({}).facts.threads[0];
  const clipped: any = projectConversationReadOutput("card_list_resolvables", readNative({ threads: Array(501).fill({ ...thread, entries: Array(51).fill({ content: "" }) }) }));
  assert.equal(clipped.error?.code, "output_too_large");
  const projected: any = projectConversationReadOutput("card_list_resolvables", readNative({ threads: [{ ...thread, entries: Array(51).fill({ content: "" }) }] })); assert.equal(projected.data.threads[0].entries.length, 50); assert.equal(projected.completeness.projection, false);
  const write: any = projectConversationWriteOutput("card_edit_resolvable_entry", { schemaVersion: 1, action: "card_edit_resolvable_entry", ok: true, effect: "dispatch_returned", replayPermitted: false, facts: { entryId: "entry-1", versionBefore: false, actorId: "user-1" } });
  assert.equal(write.ok, false); assert.equal(write.effect, "dispatch_returned"); assert.equal(write.data.entryId, "entry-1"); assert.equal(write.data.actorId, "user-1"); assert(!Object.hasOwn(write.data, "versionBefore"));
});

test("exact compact UTF-8 byte ceiling and one byte over; code point clipping retains external content and post-send certainty", () => {
  const template: any = readNative({});
  let projected: any = projectConversationReadOutput("card_list_resolvables", template);
  const remaining = CONVERSATION_READ_LIMITS.bytes - Buffer.byteLength(JSON.stringify(projected));
  template.facts.threads[0].entries[0].content = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
  projected = projectConversationReadOutput("card_list_resolvables", template);
  assert.equal(projected.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(projected)), CONVERSATION_READ_LIMITS.bytes); assert(hasConversationReadByteBudget(projected));
  template.facts.threads[0].entries[0].content += "x";
  assert.equal((projectConversationReadOutput("card_list_resolvables", template) as any).error.code, "output_too_large");
  const budget = { content: "x".repeat(CONVERSATION_WRITE_LIMITS.bytes - 14) }; assert.equal(Buffer.byteLength(JSON.stringify(budget)), CONVERSATION_WRITE_LIMITS.bytes); assert(hasConversationWriteByteBudget(budget)); budget.content += "x"; assert(!hasConversationWriteByteBudget(budget));
  const nativeError: any = { schemaVersion: 1, action: "card_add_comment", ok: false, effect: "dispatch_returned", replayPermitted: false, facts: { cardId, actorId: "user-1", context: "\u{1F600}".repeat(2048) }, error: { code: "api_error", message: "" } };
  const initial: any = projectConversationWriteOutput("card_add_comment", nativeError);
  const available = CONVERSATION_WRITE_LIMITS.bytes - Buffer.byteLength(JSON.stringify(initial));
  nativeError.error.message = "\u{1F600}".repeat(Math.floor(available / 4)) + "x".repeat(available % 4);
  const exactWrite: any = projectConversationWriteOutput("card_add_comment", nativeError);
  assert.equal(exactWrite.error.code, "api_error"); assert.equal(Buffer.byteLength(JSON.stringify(exactWrite)), CONVERSATION_WRITE_LIMITS.bytes);
  nativeError.error.message += "x";
  const overflow: any = projectConversationWriteOutput("card_add_comment", nativeError);
  assert.equal(overflow.error.code, "output_too_large"); assert.equal(overflow.effect, "dispatch_returned"); assert.equal(overflow.data.cardId, cardId); assert.equal(overflow.replayPermitted, false); assert(hasConversationWriteByteBudget(overflow));
  const error: any = projectConversationWriteOutput("card_add_comment", { schemaVersion: 1, action: "card_add_comment", ok: false, effect: "indeterminate", replayPermitted: false, facts: { cardId, actorId: "user-1" }, error: { code: "api_error", message: "😀".repeat(2049) } });
  assert.equal(error.effect, "indeterminate"); assert.equal(error.projectionComplete, false); assert.equal(Array.from(error.error.message).length, 2048);
});

test.after(() => { globalThis.fetch = savedFetch; globalThis.Date = SavedDate; resetRateGate(); rmSync(fixtureRoot, { recursive: true, force: true }); });
