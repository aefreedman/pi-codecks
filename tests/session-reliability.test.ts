import assert from "node:assert/strict";
import { loadRegisteredTools } from "./pi-tool-harness.ts";
import * as core from "../src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "test-account";
process.env.CODECKS_TOKEN = "test-token";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";

const ACCOUNT_ID = "account-test";
const CARD_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
type Json = Record<string, any>;

const response = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
  status,
  statusText: status === 503 ? "Unavailable" : "OK",
  headers: { "content-type": "application/json" },
});
const parseResult = (value: unknown): Json => {
  const match = String(value).match(/```json\s*([\s\S]*?)\s*```/i);
  assert.ok(match, `expected structured result: ${String(value)}`);
  return JSON.parse(match[1]);
};
const relationKey = (query: Json, relation: string): string | undefined => {
  const root = query._root?.[0];
  const entries = root?.account ?? [];
  return entries.flatMap((entry: Json) => Object.keys(entry)).find((key: string) => key === relation || key.startsWith(`${relation}(`));
};
const loggedInPayload = () => ({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Sam", fullName: "Sam Example" } } } });
const emptyCardScanPayload = (key: string) => ({ data: { _root: { account: ACCOUNT_ID }, account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [key]: [] } }, card: {} } });
const cardPayload = () => ({ data: { card: { [CARD_ID]: { cardId: CARD_ID, accountSeq: 2481, title: "Batch target", content: "Batch target\n\nBody", status: "not_started", isDoc: false } } } });
const runPayload = (key: string) => ({ data: { _root: { account: ACCOUNT_ID }, account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [key]: [RUN_ID] } }, sprint: { [RUN_ID]: { id: RUN_ID, accountSeq: 116, name: "Run 116", startDate: "2026-07-20", endDate: "2026-08-02" } } } });

const invoke = async (tool: any, args: Json, signal?: AbortSignal) => core.runWithAbortSignal(signal, () => tool.execute(args), process.cwd());

assert.equal(core.__test.classifyApiErrorCategory("caller_aborted"), "caller_aborted");
assert.equal(core.__test.classifyApiErrorCategory("rate_limit_queue_aborted"), "rate_limit_queue_aborted");
assert.equal(core.__test.classifyApiErrorCategory("request_timeout"), "request_timeout");
assert.equal(core.__test.classifyApiErrorCategory("Codecks API error 429"), "rate_limited");
assert.equal(core.__test.classifyApiErrorCategory("scan_queue_full"), "scan_queue_full");

const registered = await loadRegisteredTools();
const createSchema = (registered.get("codecks_card_bulk_create")!.parameters as Json).properties.cards.items;
const updateSchema = (registered.get("codecks_card_bulk_update")!.parameters as Json).properties.updates.items;
assert.equal(createSchema.additionalProperties, false);
assert.equal(updateSchema.additionalProperties, false);
assert.ok(createSchema.properties.assigneeId);
assert.equal(createSchema.properties.assignee, undefined);
for (const field of ["effort", "priority", "tags", "runId", "clearRun", "parentCardId", "clearParent"]) assert.ok(updateSchema.properties[field], `missing bulk update schema field ${field}`);

const originalFetch = globalThis.fetch;
try {
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("network must not be reached"); }) as typeof fetch;
  const unknown = parseResult(await invoke(core.card_bulk_create, { cards: [{ title: "AUD-002", assignee: "Sam" }], format: "json" }));
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.category, "validation_error");
  assert.match(unknown.error.message, /cards\[0\]\.assignee.*assigneeId.*codecks_user_lookup/i);
  assert.equal(unknown.error.requestsAttempted, 0);
  assert.equal(fetchCalls, 0);

  for (const count of [1, 4, 23, 100]) {
    let scans = 0;
    globalThis.fetch = (async (_input, init) => {
      const query = JSON.parse(String(init?.body)).query as Json;
      if (JSON.stringify(query).includes("loggedInUser")) return response(loggedInPayload());
      const key = relationKey(query, "cards");
      assert.ok(key, `unexpected query: ${JSON.stringify(query)}`);
      scans += 1;
      return response(emptyCardScanPayload(key!));
    }) as typeof fetch;
    const cards = Array.from({ length: count }, (_, index) => ({ title: `Shared scan ${index}` }));
    const preview = parseResult(await invoke(core.card_bulk_create, { cards, dryRun: true, duplicateScanLimit: 500, format: "json" }));
    assert.equal(preview.ok, true);
    assert.equal(preview.data.count, count);
    assert.equal(preview.data.scan.complete, true);
    assert.equal(preview.data.scan.requestsAttempted, 1);
    assert.equal(scans, 1, `${count}-record preview must use one shared card scan`);
  }

  let appliedCreate: Json | undefined;
  let cardScans = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("/dispatch/cards/create")) {
      appliedCreate = body;
      return response({ data: { card: { cardId: CARD_ID, accountSeq: 2481 } } });
    }
    const query = body.query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(loggedInPayload());
    if (Object.keys(query).some((key) => key.startsWith("user("))) return response({ data: { user: { [USER_ID]: { id: USER_ID, name: "Sam", fullName: "Sam Example" } } } });
    const key = relationKey(query, "cards");
    assert.ok(key);
    cardScans += 1;
    return response(emptyCardScanPayload(key!));
  }) as typeof fetch;
  const createArgs = { cards: [{ title: "Parity", content: "Body", assigneeId: USER_ID, effort: 3, priority: "high", tags: ["alpha"], putOnHand: true }], format: "json" };
  const preview = parseResult(await invoke(core.card_bulk_create, { ...createArgs, dryRun: true }));
  const apply = parseResult(await invoke(core.card_bulk_create, { ...createArgs, dryRun: false }));
  assert.equal(preview.ok, true);
  assert.equal(apply.ok, true);
  assert.equal(preview.data.results[0].assignee.id, appliedCreate!.assigneeId);
  assert.equal(preview.data.results[0].effort, appliedCreate!.effort);
  assert.equal(preview.data.results[0].priority.code, appliedCreate!.priority);
  assert.equal(preview.data.results[0].content, appliedCreate!.content);
  assert.equal(preview.data.results[0].putOnHand, appliedCreate!.putOnHand);
  assert.equal(cardScans, 2, "preview and apply each perform one shared duplicate scan");

  let mutationAttempts = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("/dispatch/cards/update")) {
      mutationAttempts += 1;
      return mutationAttempts === 7 ? response("ambiguous failure", 503) : response({ data: {} });
    }
    const query = body.query as Json;
    const directCard = Object.keys(query).find((key) => key.startsWith("card("));
    if (directCard) return response(cardPayload());
    const key = relationKey(query, "sprints");
    assert.ok(key, `unexpected batch query: ${JSON.stringify(query)}`);
    return response(runPayload(key!));
  }) as typeof fetch;
  const runUpdates = Array.from({ length: 31 }, () => ({ cardId: CARD_ID, runId: 116, effort: 5, priority: "medium", tags: ["run-116"] }));
  const batch = parseResult(await invoke(core.card_bulk_update, { updates: runUpdates, dryRun: false, continueOnError: true, format: "json" }));
  assert.equal(batch.ok, true);
  assert.equal(batch.data.count, 31);
  assert.equal(batch.data.updated, 6);
  assert.equal(batch.data.failed, 0);
  assert.equal(batch.data.indeterminate, 1);
  assert.equal(batch.data.definitelyUnsent, 24);
  assert.equal(batch.data.ambiguousMutationsRetried, false);
  assert.equal(mutationAttempts, 7, "an ambiguous mutation stops later dispatches and is never retried");
  assert.equal(batch.data.results[6].status, "indeterminate");
  assert.equal(batch.data.results[6].reconciliation.retry, "do_not_retry");
  assert.equal(batch.data.results[7].status, "definitely_unsent");
  assert.equal(batch.data.results[0].proposed.run.accountSeq, 116);
  assert.equal(batch.data.results[0].target.cardRef.startsWith("$"), true);
  assert.equal(batch.data.results[0].target.accountSeqRef, "seq:2481");

  for (const parallelCount of [8, 10]) {
    let active = 0;
    let maxActive = 0;
    globalThis.fetch = (async (_input, init) => {
      const query = JSON.parse(String(init?.body)).query as Json;
      const key = relationKey(query, "cards");
      assert.ok(key);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return response(emptyCardScanPayload(key!));
    }) as typeof fetch;
    const searches = await Promise.all(Array.from({ length: parallelCount }, () => invoke(core.card_search, { title: "parallel", scanLimit: 5000, format: "json" })));
    assert.equal(searches.every((value) => parseResult(value).ok === true), true);
    assert.ok(maxActive <= 2, `${parallelCount} broad scans exceeded the concurrency limit: ${maxActive}`);
  }

  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    const key = relationKey(query, "cards");
    assert.ok(key);
    await held;
    return response(emptyCardScanPayload(key!));
  }) as typeof fetch;
  const first = invoke(core.card_search, { title: "held-1", scanLimit: 5000, format: "json" });
  const second = invoke(core.card_search, { title: "held-2", scanLimit: 5000, format: "json" });
  const controller = new AbortController();
  const queued = invoke(core.card_search, { title: "cancelled", scanLimit: 5000, format: "json" }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  const cancelled = parseResult(await queued);
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.category, "caller_aborted");
  assert.match(cancelled.error.recoveryHint, /sequential/i);
  release();
  await Promise.all([first, second]);

  console.log("session reliability tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
