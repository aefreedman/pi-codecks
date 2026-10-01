import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { ENTITY_TOOL_DEFINITIONS } from "../src/tools/entities/definitions.ts";
import { registerCodecksTool } from "../src/pi/register-tools.ts";
import { resetRateGate } from "../src/runtime/pacing.ts";
import { getOperationContext, runWithAbortSignal } from "../src/runtime/operation-context.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
import { entityReadSuccess, entityReadError, projectEntityReadOutput, ENTITY_READ_SCHEMAS } from "../src/tools/entities/entities-read-output.ts";
import { entityWriteSuccess, entityWriteError, entityEffect, projectEntityWriteOutput, ENTITY_WRITE_SCHEMAS } from "../src/tools/entities/entities-write-output.ts";
import { observeEntity, ENTITY_OUTPUT_LIMITS, hasEntityByteBudget } from "../src/tools/entities/entities-output-helpers.ts";
useInertEnvironmentCredentialProvider();
const ids = { decks: "55555555-5555-4555-8555-555555555555", milestones: "44444444-4444-4444-8444-444444444444", sprints: "22222222-2222-4222-8222-222222222222" };
const models: Record<string, string> = { decks: "deck", milestones: "milestone", sprints: "sprint" };
const seqs = { decks: 12, milestones: 84, sprints: 91 };
const source: Record<string, any> = {
  decks: { id: ids.decks, accountSeq: 12, title: "Development", description: "Deck body", isDeleted: false },
  milestones: { id: ids.milestones, accountSeq: 84, name: "Alpha", description: "Milestone body", startDate: null, color: "green", isGlobal: true, handSyncEnabled: false, isDeleted: false },
  sprints: { id: ids.sprints, accountSeq: 91, name: "Current Run", description: "Run body", startDate: "2026-05-11", endDate: "2026-05-24", isDeleted: false, completedAt: null, lockedAt: null },
};
const targets: Record<string, any> = {
  deck_get: { deckId: 12 }, deck_update: { deckId: 12, description: "Changed" },
  milestone_list: { search: "alpha" }, milestone_get: { milestoneId: 84 }, milestone_update: { milestoneId: 84, description: "Changed" },
  run_list: {}, run_get: { runId: 91 }, run_update: { runId: 91, customLabel: "Changed" }, user_lookup: { name: "example" },
};
const definition = (name: string) => ENTITY_TOOL_DEFINITIONS.find(d => d.exportName === name)!;
function register(d: any) { let result: any; registerCodecksTool({ registerTool(t: any) { result = t; } } as any, d, "Fixture", false, () => "PERSONAL"); return result; }
const normalize = (v: any) => JSON.parse(JSON.stringify(v, (k, x) => k === "sessionId" ? "<session>" : x));
type Mode = "normal" | "missing" | "ambiguous" | "forbidden" | "rejected" | "uncertain";
async function fixture<T>(fn: () => Promise<T>, mode: Mode = "normal", overrides: Record<string, unknown> = {}, population = 1) {
  const original = globalThis.fetch; const requests: any[] = []; resetRateGate();
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)); const path = String(url).match(/\/dispatch\/(.+)$/)?.[1] ?? "query";
    requests.push(normalize({ path, body }));
    if (path !== "query" && mode === "uncertain") throw Error("synthetic disconnected after send");
    const status = mode === "forbidden" ? 403 : path !== "query" && mode === "rejected" ? 400 : 200;
    if (status !== 200) return new Response(JSON.stringify({ error: "synthetic rejection" }), { status });
    if (path !== "query") return new Response(JSON.stringify({ payload: {} }));
    const relation = body.query._root[0].account.flatMap((e: any) => typeof e === "object" ? Object.keys(e) : []).find((k: string) => /^(decks|milestones|sprints|cards)(\(|$)/.test(k));
    assert.ok(relation); const family = relation.split("(")[0];
    if (family === "cards") return new Response(JSON.stringify({ data: { user: mode === "missing" ? {} : { u1: { id: "user-1", name: "example", fullName: null, ...overrides }, u2: { id: "user-1", name: "example" } } } }));
    const records = mode === "missing" ? [] : Array.from({ length: mode === "ambiguous" ? 2 : population }, (_, i) => ({ ...source[family], ...(i ? { id: `entity-${i}`, accountSeq: seqs[family as keyof typeof seqs] + i } : {}), ...overrides }));
    return new Response(JSON.stringify({ data: { _root: { account: "fixture" }, account: { fixture: { id: "fixture", sprintsEnabled: true, [relation]: records.map(r => r.id) } }, [models[family]]: Object.fromEntries(records.map(r => [r.id, r])) } }));
  };
  try { const result = await fn(); return { result, requests }; } finally { globalThis.fetch = original; }
}
const native = (name: string, args: any, signal?: AbortSignal) => register(definition(name)).execute("fixture", args, signal, undefined, { cwd: process.cwd() });
const parseLegacy = (s: string) => JSON.parse(s.match(/```json\s*([\s\S]*?)```/)![1]);

for (const d of ENTITY_TOOL_DEFINITIONS) {
  const name = d.exportName;
  test(`${name}: direct seam, legacy text/json and registered adapter execute once with exact requests`, async () => {
    const args = { ...targets[name], format: "json" };
    const direct = await fixture(() => d.executePayload!(args));
    const legacy = await fixture(() => d.tool.execute(args));
    const registered = await fixture(() => native(name, args));
    assert.equal(direct.result.text, legacy.result);
    assert.deepEqual(direct.requests, legacy.requests); assert.deepEqual(direct.requests, registered.requests);
    assert.equal(direct.requests.length, name.endsWith("update") ? 2 : 1);
    const projected: any = d.projectOutput!(direct.result.payload);
    assert.equal(projected.ok, true); assert.equal(Value.Check(d.outputSchema!, projected), true);
    assert.equal(registered.result.isError, false); assert.deepEqual(registered.result.structuredContent, projected);
    assert.ok(registered.result.content[0].text.length > 0);
    if (name !== "user_lookup") {
      const plain = await fixture(() => d.executePayload!({ ...targets[name], format: "text" }));
      assert.deepEqual(plain.result.payload, direct.result.payload); assert.deepEqual(plain.requests, direct.requests);
      const golden: any = parseLegacy(direct.result.text); assert.equal(golden.action, name.replaceAll("_", "-")); assert.equal(golden.toolVersion, "v2.0.0");
      assert.equal(golden.ok, true);
      if (name === "deck_get") assert.deepEqual(golden.data, { deckId: ids.decks, accountSeq: 12, title: "Development", description: "Deck body", isDeleted: false, status: null });
      if (name === "milestone_list") assert.equal(golden.data.total, 1);
      if (name === "run_list") assert.deepEqual({ matches: golden.data.matches, returned: golden.data.returned, truncated: golden.data.truncated }, { matches: 1, returned: 1, truncated: false });
      if (name.endsWith("update")) {
        const dispatch = direct.requests[1];
        assert.deepEqual(dispatch, name === "run_update" ? { path: "sprints/updateSprint", body: { sessionId: "<session>", id: ids.sprints, name: "Changed" } } : { path: `${name === "deck_update" ? "decks" : "milestones"}/update`, body: { id: name === "deck_update" ? ids.decks : ids.milestones, description: "Changed" } });
        assert.equal(projected.effect.certainty, "dispatch_returned"); assert.equal(projected.effect.readback, false); assert.equal(projected.effect.replaySafe, false);
      }
    } else {
      assert.match(direct.result.text, /Scanned Cards: 200/); assert.match(direct.result.text, /example \(id: user-1\)/);
      assert.equal(projected.data.requestedScanLimit, 200); assert.equal(projected.data.matchedCount, 1); assert.equal(projected.provenance.exhaustive, false);
      assert.equal(Object.hasOwn(projected.data, "scannedCards"), false);
    }
  });
  test(`${name}: missing and permission failure preserve native semantics without new requests`, async () => {
    const absent = await fixture(() => native(name, targets[name]), "missing");
    const emptySuccess = name.endsWith("list") || name === "user_lookup";
    assert.equal(absent.result.structuredContent.ok, emptySuccess); assert.equal(absent.result.isError, !emptySuccess);
    assert.equal(absent.requests.length, 1);
    if (!emptySuccess) assert.equal(absent.result.structuredContent.error.code, "not_found");
    if (name === "user_lookup") {
      await assert.rejects(fixture(() => d.executePayload!(targets[name]), "forbidden"));
    } else {
      const forbidden = await fixture(() => native(name, targets[name]), "forbidden"); assert.equal(forbidden.result.isError, true); assert.equal(forbidden.result.structuredContent.ok, false);
    }
  });
}

test("canonical scope preserved and credential memoization across resolution/dispatch", async () => {
  const result = await fixture(() => runWithAbortSignal(undefined, async () => {
    const context = getOperationContext()!; const result = await definition("deck_update").executePayload!(targets.deck_update);
    assert.equal(getOperationContext(), context); assert.equal(context.requestsAttempted, 2); assert.equal(context.requestsDispatched, 2); assert.ok(context.credentialConfigPromise); return result;
  }, process.cwd(), undefined, "PERSONAL")); assert.equal(result.requests.length, 2);
});

test("native observations precede legacy fallbacks: missing/null/false/zero and valid-only references", async () => {
  const d = definition("deck_get");
  const missing = await fixture(() => d.executePayload!(targets.deck_get), "normal", { description: undefined, isDeleted: undefined, title: undefined, accountSeq: 0 });
  const dto: any = d.projectOutput!(missing.result.payload); assert.equal(dto.ok, true); assert.deepEqual(dto.data.deck, { id: ids.decks, accountSeq: 0 });
  assert.equal(parseLegacy(missing.result.text).data.description, ""); assert.equal(parseLegacy(missing.result.text).data.isDeleted, false); assert.equal(parseLegacy(missing.result.text).data.title, "Deck 0");
  const explicit = await fixture(() => d.executePayload!(targets.deck_get), "normal", { description: null, isDeleted: false, title: "", status: null });
  const observed: any = d.projectOutput!(explicit.result.payload); assert.equal(observed.data.deck.description, null); assert.equal(observed.data.deck.isDeleted, false); assert.equal(observed.data.deck.title, ""); assert.equal(observed.data.deck.status, null);
  const facts = observeEntity({ accountSeq: 0, name: null, handSyncEnabled: false }, "milestone"); assert.equal(Object.hasOwn(facts, "reference"), false); assert.equal(facts.handSyncEnabled, false); assert.equal(facts.name, null);
});

test("ambiguity/deleted handling, source/filtered/sliced/projected counts and sampled empty lookup", async () => {
  for (const name of ["deck_get", "milestone_get"]) {
    const args = name === "deck_get" ? { title: "Development" } : { title: "Alpha" };
    const response = await fixture(() => native(name, args), "ambiguous"); assert.equal(response.result.isError, true); assert.equal(response.result.structuredContent.error.code, "ambiguous_match");
  }
  const deleted = await fixture(() => native("milestone_get", targets.milestone_get), "normal", { isDeleted: true }); assert.equal(deleted.result.structuredContent.error.code, "not_found");
  const allowed = await fixture(() => native("milestone_get", { ...targets.milestone_get, includeDeleted: true }), "normal", { isDeleted: true }); assert.equal(allowed.result.structuredContent.data.milestone.isDeleted, true);
  for (const name of ["milestone_list", "run_list"]) {
    const response = await fixture(() => native(name, { limit: 1 }), "normal", {}, 3); const data = response.result.structuredContent.data;
    assert.equal(data.sourceCount, 3); assert.equal(data.filteredCount, 3); assert.equal(data.emittedCount, 1); assert.equal(data.truncated, true); assert.equal(response.result.structuredContent.provenance.sourceCompleteness, "unverified");
  }
  const response = await fixture(() => native("user_lookup", { name: "nobody" })); assert.equal(response.result.structuredContent.ok, true); assert.equal(response.result.structuredContent.data.matchedCount, 0); assert.match(response.result.content[0].text, /No users matched/);
});

for (const name of ["deck_update", "milestone_update", "run_update"]) {
  test(`${name}: clear/no-fields/rejected/indeterminate/pre-abort and post-send contract failure`, async () => {
    const d = definition(name); const args = { ...targets[name] }; delete args.description; delete args.customLabel;
    const validation = await fixture(() => native(name, args)); assert.equal(validation.requests.length, 0); assert.equal(validation.result.structuredContent.error.code, "validation_error"); assert.equal(validation.result.structuredContent.effect.certainty, "not_dispatched");
    const clear = await fixture(() => native(name, { ...args, ...(name === "run_update" ? { clearCustomLabel: true } : { clearDescription: true }) }));
    assert.equal(clear.requests[1].body[name === "run_update" ? "name" : "description"], name === "run_update" ? null : ""); assert.equal(clear.result.structuredContent.data[name === "run_update" ? "customLabelCleared" : "descriptionCleared"], true);
    for (const mode of ["rejected", "uncertain"] as const) {
      const result = await fixture(() => native(name, targets[name]), mode); assert.equal(result.requests.length, 2); assert.equal(result.result.isError, true); assert.equal(result.result.structuredContent.effect.certainty, mode === "rejected" ? "definitely_rejected" : "indeterminate"); assert.equal(result.result.structuredContent.effect.replaySafe, false);
    }
    const signal = AbortSignal.abort(); const aborted = await fixture(() => native(name, targets[name], signal)); assert.equal(aborted.requests.length, 0); assert.equal(aborted.result.isError, true);
    const malformed = await fixture(() => native(name, { ...targets[name], description: "😀".repeat(17000) }));
    assert.equal(malformed.requests.length, 2); assert.equal(malformed.result.structuredContent.error.code, "output_too_large"); assert.equal(malformed.result.structuredContent.effect.certainty, "dispatch_returned");
    if (name !== "run_update") {
      const invalid = await fixture(() => native(name, { ...targets[name], description: 99 })); assert.equal(invalid.requests.length, 0); assert.equal(invalid.result.structuredContent.effect.certainty, "not_dispatched");
    } else {
      const invalid = await fixture(() => native(name, { ...targets[name], description: 99 })); assert.equal(invalid.requests.length, 2); assert.equal(invalid.result.structuredContent.error.code, "output_contract_error"); assert.equal(invalid.result.structuredContent.effect.certainty, "dispatch_returned");
    }
  });
}

test("registered aliases preserve canonical requests and clear semantics", async () => {
  const cases = [ ["deck_get", { deck_id: 12, output_format: "json" }], ["deck_update", { deck_id: 12, clear_description: true }], ["milestone_get", { milestone_id: 84, include_deleted: true }], ["milestone_update", { milestone_id: 84, clear_description: true }], ["run_get", { run_id: 91 }], ["run_update", { run_id: 91, custom_label: "Alias" }], ["run_list", { include_deleted: true, include_completed: true, output_format: "json" }], ["milestone_list", { include_deleted: true }] ] as const;
  for (const [name, args] of cases) { const tool = register(definition(name)); const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args; const result = await fixture(() => tool.execute("fixture", prepared, undefined, undefined, { cwd: process.cwd() })); assert.equal(result.result.structuredContent.ok, true, name); }
});

test("closed/versioned schemas, malformed native data and registered projector errors for all nine", async () => {
  for (const d of ENTITY_TOOL_DEFINITIONS) {
    const walk = (schema: any) => { if (schema.type === "object") { assert.equal(schema.additionalProperties, false); Object.values(schema.properties).forEach(walk); } if (schema.items) walk(schema.items); if (schema.anyOf) schema.anyOf.forEach(walk); };
    walk(d.outputSchema); assert.ok(d.executePayload); assert.equal(d.read, undefined);
    for (const candidate of [undefined, {}, { version: 1, action: d.exportName.replaceAll("_", "-"), ok: true }, { version: 1, action: "wrong", ok: false, error: {} }]) {
      const output: any = d.projectOutput!(candidate); assert.equal(output.ok, false); assert.equal(output.error.code, "output_contract_error"); assert.equal(Value.Check(d.outputSchema!, output), true);
      const result = await register({ ...d, executePayload: async () => ({ text: "misleading", payload: candidate }) }).execute("fixture", {}, undefined, undefined, { cwd: process.cwd() }); assert.equal(result.isError, true); assert.doesNotMatch(result.content[0].text, /misleading/);
    }
    const real = await fixture(() => d.executePayload!(targets[d.exportName])); const dto: any = d.projectOutput!(real.result.payload);
    assert.equal(Value.Check(d.outputSchema!, { ...dto, private: true }), false); assert.equal(Value.Check(d.outputSchema!, { ...dto, version: 2 }), false);
  }
});

test("Unicode projection, arrays, invalid reusable identities and independent inclusive UTF-8 budget", () => {
  const project = (deck: any) => projectEntityReadOutput("deck-get", entityReadSuccess("deck-get", { deck })) as any;
  const clipped = project({ title: "😀".repeat(2049) }); assert.equal(clipped.ok, true); assert.equal(Array.from(clipped.data.deck.title).length, 2048); assert.equal(clipped.projection.complete, false);
  for (const id of ["x".repeat(129), false, {}, -1]) { assert.equal(project({ id }).error.code, "output_contract_error"); }
  assert.equal(project({ isDeleted: "false" }).error.code, "output_contract_error");
  const base = project({ description: "", title: "" }); const remaining = ENTITY_OUTPUT_LIMITS.bytes - Buffer.byteLength(JSON.stringify(base)); const description = "😀".repeat(Math.floor(remaining / 4)); const title = "x".repeat(remaining % 4);
  const edge = project({ description, title }); assert.equal(edge.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(edge)), 65536); assert.equal(hasEntityByteBudget(edge), true);
  const over = project({ description, title: title + "x" }); assert.equal(over.ok, false); assert.equal(over.error.code, "output_too_large");
  const users = Array.from({ length: 5001 }, (_, i) => ({ id: `u${i}` })); const list: any = projectEntityReadOutput("user-lookup", entityReadSuccess("user-lookup", { query: "x", requestedScanLimit: 5000, candidateCount: 5001, matchedCount: 5001, emittedCount: 5001, users }));
  assert.equal(list.projection.complete, false); // byte overflow can fail closed independently of field clipping
  if (list.ok) { assert.equal(list.data.users.length, 5000); assert.equal(list.data.emittedCount, 5000); assert.equal(list.data.matchedCount, 5001); }
  for (const action of Object.keys(ENTITY_READ_SCHEMAS) as Array<keyof typeof ENTITY_READ_SCHEMAS>) { const dto = projectEntityReadOutput(action, entityReadError(action, "caller_aborted", "abort")); assert.equal(dto.ok, false); assert.equal(Value.Check(ENTITY_READ_SCHEMAS[action], dto), true); }
  for (const action of Object.keys(ENTITY_WRITE_SCHEMAS) as Array<keyof typeof ENTITY_WRITE_SCHEMAS>) {
    const effect = entityEffect("dispatch_returned", "target"); const dto: any = projectEntityWriteOutput(action, entityWriteSuccess(action, { targetId: "target", requested: { description: 42 }, updatedFields: ["description"] }, effect)); assert.equal(dto.error.code, "output_contract_error"); assert.deepEqual(dto.effect, effect);
    const failed = projectEntityWriteOutput(action, entityWriteError(action, "caller_aborted", "abort", entityEffect("not_dispatched"))); assert.equal(Value.Check(ENTITY_WRITE_SCHEMAS[action], failed), true);
  }
});

test("frozen canonical read query bodies remain unchanged for all entity families", async () => {
  const deckFields = ["id", "accountSeq", "title", "description", "isDeleted"];
  const milestoneFields = ["id", "accountSeq", "name", "description", "date", "startDate", "color", "isGlobal", "handSyncEnabled", "isDeleted"];
  const runFields = ["id", "accountSeq", "name", "description", "index", "startDate", "endDate", "stats", "manualOrderLabels", "userCapacities", "handSyncEnabled", "createdAt", "isDeleted", "completedAt", "lockedAt", { sprintConfig: ["id", "name", "color"] }];
  for (const name of Object.keys(targets)) {
    const result = await fixture(() => definition(name).executePayload!(targets[name]));
    const accountEntries = result.requests[0].body.query._root[0].account;
    if (name.startsWith("deck_")) assert.deepEqual(accountEntries, [{ 'decks({"accountSeq":[12]})': deckFields }]);
    else if (name === "milestone_list") assert.deepEqual(accountEntries, [{ milestones: milestoneFields }]);
    else if (name.startsWith("milestone_")) assert.deepEqual(accountEntries, [{ 'milestones({"accountSeq":[84]})': milestoneFields }]);
    else if (name === "run_list") assert.deepEqual(accountEntries, ["sprintsEnabled", { sprints: runFields }]);
    else if (name.startsWith("run_")) assert.deepEqual(accountEntries, [{ 'sprints({"accountSeq":[91]})': [...runFields, { cards: ["cardId", "accountSeq", "title", "status", "derivedStatus", "isDoc", "sprintId"] }] }]);
    else assert.deepEqual(accountEntries, [{ 'cards({"$limit":200,"$order":"-lastUpdatedAt"})': [{ assignee: ["id", "name", "fullName"] }, { creator: ["id", "name", "fullName"] }] }]);
    assert.deepEqual(Object.keys(result.requests[0].body), ["query"]);
  }
});

test("Run nested observations and unavailable versus observed empty relations", async () => {
  const missing = await fixture(() => native("run_get", targets.run_get));
  assert.equal(missing.result.structuredContent.data.cardRelation, "unavailable"); assert.equal(Object.hasOwn(missing.result.structuredContent.data, "sourceCardCount"), false);
  const empty = await fixture(() => native("run_get", targets.run_get), "normal", { cards: [], name: null, sprintConfig: { color: null } });
  const dto = empty.result.structuredContent; assert.equal(dto.data.sourceCardCount, 0); assert.equal(dto.data.cardRelation, "observed"); assert.deepEqual(dto.data.run.sprintConfig, { color: null }); assert.equal(dto.data.run.name, null); assert.equal(Object.hasOwn(dto.data.run.sprintConfig, "id"), false);
  const cards = [{ cardId: "c0", accountSeq: 0, title: null, isDoc: false, status: "", sprintId: null }];
  const observed = await fixture(() => native("run_get", targets.run_get), "normal", { cards }); assert.deepEqual(observed.result.structuredContent.data.cards, cards);
});

test("projected arrays retain source counts and explicit incompleteness, references never clip", () => {
  const dto: any = projectEntityReadOutput("milestone-list", entityReadSuccess("milestone-list", { sourceCount: 501, filteredCount: 501, emittedCount: 501, truncated: false, milestones: Array.from({ length: 501 }, () => ({})) }));
  assert.equal(dto.ok, true); assert.equal(dto.data.sourceCount, 501); assert.equal(dto.data.filteredCount, 501); assert.equal(dto.data.emittedCount, 500); assert.equal(dto.data.truncated, false); assert.equal(dto.projection.complete, false);
  const invalid: any = projectEntityReadOutput("milestone-get", entityReadSuccess("milestone-get", { milestone: { reference: { accountSeq: 1, url: "https://fixture.codecks.io/milestones/2" } } })); assert.equal(invalid.error.code, "output_contract_error");
});

test("mutation UTF-8 boundary is inclusive and bounded error preserves acknowledgment", () => {
  for (const action of Object.keys(ENTITY_WRITE_SCHEMAS) as Array<keyof typeof ENTITY_WRITE_SCHEMAS>) {
    const effect = entityEffect("dispatch_returned", "target");
    const build = (description: string) => projectEntityWriteOutput(action, entityWriteSuccess(action, { targetId: "target", requested: { description }, updatedFields: ["description"], descriptionCleared: false }, effect)) as any;
    const base = build(""); const remaining = 65536 - Buffer.byteLength(JSON.stringify(base)); const content = "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4);
    const edge = build(content); assert.equal(edge.ok, true); assert.equal(Buffer.byteLength(JSON.stringify(edge)), 65536);
    const overflow = build(content + "x"); assert.equal(overflow.error.code, "output_too_large"); assert.deepEqual(overflow.effect, effect); assert.equal(Value.Check(ENTITY_WRITE_SCHEMAS[action], overflow), true);
  }
});

test("all nine pre-aborts preserve zero physical requests and declared native rejection behavior", async () => {
  for (const d of ENTITY_TOOL_DEFINITIONS) {
    if (d.exportName === "user_lookup") await assert.rejects(fixture(() => native(d.exportName, targets[d.exportName], AbortSignal.abort())), /cancel|abort/i);
    else {
      const result = await fixture(() => native(d.exportName, targets[d.exportName], AbortSignal.abort())); assert.equal(result.requests.length, 0); assert.equal(result.result.isError, true); assert.equal(result.result.structuredContent.ok, false);
    }
  }
});

test("read native statuses and mutation certainty branches survive schema projection", () => {
  const readActions = Object.keys(ENTITY_READ_SCHEMAS) as Array<keyof typeof ENTITY_READ_SCHEMAS>;
  for (const action of readActions) {
    for (const code of ["validation_error", "not_found", "ambiguous_match", "incomplete_read", "forbidden", "caller_aborted", "api_error", "output_contract_error", "output_too_large"]) {
      const result: any = projectEntityReadOutput(action, entityReadError(action, code, "synthetic")); assert.equal(result.error.code, code); assert.equal(Value.Check(ENTITY_READ_SCHEMAS[action], result), true);
    }
  }
  for (const action of Object.keys(ENTITY_WRITE_SCHEMAS) as Array<keyof typeof ENTITY_WRITE_SCHEMAS>) {
    for (const certainty of ["not_dispatched", "definitely_rejected", "dispatch_returned", "indeterminate"]) {
      const effect = entityEffect(certainty, "target"); const result: any = projectEntityWriteOutput(action, entityWriteError(action, "api_error", "synthetic", effect)); assert.deepEqual(result.effect, effect); assert.equal(Value.Check(ENTITY_WRITE_SCHEMAS[action], result), true);
    }
  }
});

test("blocked foreign execution rejects without DTO, no operation or replay", async () => {
  let calls = 0;
  const d = definition("deck_update");
  const tool = register({ ...d, executePayload: async () => { calls++; throw Error("Synthetic permission block"); } });
  await assert.rejects(() => tool.execute("fixture", {}, undefined, undefined, { cwd: process.cwd() }), /permission block/); assert.equal(calls, 1);
});

test("numeric-string observations and malformed native count relations are explicit", () => {
  const numeric: any = projectEntityReadOutput("deck-get", entityReadSuccess("deck-get", { deck: { id: 0, accountSeq: null } })); assert.equal(numeric.ok, true); assert.equal(numeric.data.deck.id, 0); assert.equal(numeric.data.deck.accountSeq, null);
  const facts = observeEntity({ id: "m0", accountSeq: "1", isDeleted: null }, "milestone");
  const dto: any = projectEntityReadOutput("milestone-get", entityReadSuccess("milestone-get", { milestone: facts })); assert.equal(dto.ok, true); assert.equal(dto.data.milestone.accountSeq, "1"); assert.equal(dto.data.milestone.reference.accountSeq, 1); assert.equal(dto.data.milestone.isDeleted, null);
  for (const overrides of [{ sourceCount: 0 }, { filteredCount: -1 }, { emittedCount: "bad" }, { emittedCount: 0 }, { truncated: true }]) {
    const result: any = projectEntityReadOutput("milestone-list", entityReadSuccess("milestone-list", { sourceCount: 1, filteredCount: 1, emittedCount: 1, truncated: false, milestones: [{}], ...overrides })); assert.equal(result.error.code, "output_contract_error");
  }
});
