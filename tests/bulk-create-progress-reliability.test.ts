import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as core from "../src/codecks-core.ts";
import { loadRegisteredTools } from "./pi-tool-harness.ts";

process.env.CODECKS_ACCOUNT = "test-account";
process.env.CODECKS_TOKEN = "test-token";

type Json = Record<string, any>;
const USER = "33333333-3333-4333-8333-333333333333";
const CARD = "11111111-1111-4111-8111-111111111111";
const response = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const login = () => ({ data: { _root: { loggedInUser: USER }, user: { [USER]: { id: USER, name: "Sam" } } } });
const parse = (value: unknown): Json => {
  const match = String(value).match(/```json\s*([\s\S]*?)\s*```/i);
  assert.ok(match, "expected structured result");
  return JSON.parse(match[1]);
};
const invoke = (args: Json, signal?: AbortSignal) => core.runWithAbortSignal(signal, () => core.card_bulk_create.execute(args), process.cwd());

const originalFetch = globalThis.fetch;
try {
  // An abort while resolving the first record is an operation failure, not a
  // record-validation failure, and later records must not be normalized.
  const cancellation = new AbortController();
  let normalizationCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    normalizationCalls += 1;
    cancellation.abort();
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;
  const cancelled = parse(await invoke({ cards: [{ title: "First", deck: "Known" }, { title: "Never normalize", deck: "Known" }], format: "json" }, cancellation.signal));
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.category, "caller_aborted");
  assert.equal(cancelled.error.invalidRecordCount, undefined);
  assert.equal(normalizationCalls, 1);

  // Duplicate discovery uses the same cancellation path and does not widen or
  // turn its operational error into incomplete/validation evidence.
  const discoveryCancellation = new AbortController();
  let discoveryCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    if (JSON.stringify(query).includes("loggedInUser")) return response(login());
    discoveryCalls += 1;
    discoveryCancellation.abort();
    throw new DOMException("aborted", "AbortError");
  }) as typeof fetch;
  const discoveryCancelled = parse(await invoke({ cards: [{ title: "Cancel duplicate discovery" }], format: "json" }, discoveryCancellation.signal));
  assert.equal(discoveryCancelled.ok, false);
  assert.equal(discoveryCancelled.error.category, "caller_aborted");
  assert.equal(discoveryCalls, 1);

  // A stopped apply must reclassify every later record as definitely unsent,
  // even if duplicate discovery had originally labelled it differently.
  const stoppedVariant = async (duplicateScanLimit: number, expectedInitialStatus: string) => {
    let creates = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/dispatch/cards/create")) {
        creates += 1;
        return creates === 1
          ? response({ payload: { id: CARD, accountSeq: 81 } })
          : response({ message: "slow down" }, 429, { "Retry-After": "0" });
      }
      const query = JSON.parse(String(init?.body)).query as Json;
      if (JSON.stringify(query).includes("loggedInUser")) return response(login());
      const relation = Object.keys(query._root?.[0]?.account?.[0] ?? {})[0];
      const duplicateId = "22222222-2222-4222-8222-222222222222";
      return response({
        data: {
          _root: { account: "account" },
          account: { account: { id: "account", [relation]: [duplicateId] } },
          card: { [duplicateId]: { cardId: duplicateId, accountSeq: 22, title: "Same title", status: "not_started", isDoc: false } },
        },
      });
    }) as typeof fetch;
    const result = parse(await invoke({
      cards: [{ title: "Same title" }, { title: "Same title" }, { title: "Same title" }],
      dryRun: false,
      duplicatePolicy: "best_effort",
      duplicateScanLimit,
      outputMode: "detailed",
      format: "json",
    }));
    assert.equal(creates, 2);
    assert.equal(result.data.results[2].status, "definitely_unsent");
    assert.equal(result.data.results[2].preDispatchStatus, expectedInitialStatus);
    assert.equal(result.data.results[2].dispatchAttemptState, "not_attempted");
    assert.ok(result.data.results[2].duplicateCandidates.length > 0, "duplicate evidence must survive reconciliation");
    assert.match(result.data.results[2].reconciliation.reason, /retain and reconcile.*duplicate evidence/i);
  };
  await stoppedVariant(3000, "duplicate_candidate");
  await stoppedVariant(1, "scan_incomplete");

  // A 429 stops sequential apply, preserves the earlier create, and marks only
  // untouched records as definitely unsent. Retry-After also gates a later
  // request from this extension process and remains abortable.
  let creates = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) {
      creates += 1;
      if (creates === 1) return response({ payload: { id: CARD, accountSeq: 81 } });
      return response({ message: "slow down" }, 429, { "Retry-After": "1" });
    }
    const query = JSON.parse(String(init?.body)).query as Json;
    assert.match(JSON.stringify(query), /loggedInUser/);
    return response(login());
  }) as typeof fetch;
  const limited = parse(await invoke({ cards: [{ title: "Created" }, { title: "Limited" }, { title: "Unsent" }], dryRun: false, duplicatePolicy: "skip", format: "json" }));
  assert.equal(limited.ok, true);
  assert.equal(creates, 2);
  assert.equal(limited.data.created, 1);
  assert.equal(limited.data.failed, 1);
  assert.equal(limited.data.definitelyUnsent, 1);
  assert.equal(limited.data.results[0].status, "created");
  assert.equal(limited.data.results[1].error.category, "rate_limited");
  assert.match(limited.data.results[1].reconciliation.reason, /must not be replayed/i);
  assert.equal(limited.data.results[2].status, "definitely_unsent");
  assert.match(limited.data.results[2].reconciliation.reason, /No dispatch attempt/i);

  const queuedAbort = new AbortController();
  queuedAbort.abort();
  globalThis.fetch = (async () => { throw new Error("cooldown should prevent fetch"); }) as typeof fetch;
  const cooldownAbort = parse(await invoke({ cards: [{ title: "Blocked by cooldown" }], duplicatePolicy: "skip", format: "json" }, queuedAbort.signal));
  assert.equal(cooldownAbort.ok, false);
  assert.equal(cooldownAbort.error.category, "rate_limit_queue_aborted");

  // Progress is scoped to the registered call and uses a stable, bounded shape;
  // renderCall makes the bulk safety choices visible before execution.
  const tools = await loadRegisteredTools();
  const bulkCreate = tools.get("codecks_card_bulk_create")!;
  const fakeTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const call = bulkCreate.renderCall!({ cards: [{ title: "One" }, { title: "Two" }], dryRun: false, duplicatePolicy: "skip", verification: "identity" }, fakeTheme, {});
  assert.match(call.render(120).join("\n"), /apply.*2 cards.*duplicates: skip.*verify: identity/i);

  // Wait out the deliberately server-directed one-second cooldown before the
  // progress invocation; this keeps the test deterministic without test-only hooks.
  await new Promise((resolve) => setTimeout(resolve, 1050));
  const updates: Json[] = [];
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query as Json;
    assert.match(JSON.stringify(query), /loggedInUser/);
    return response(login());
  }) as typeof fetch;
  const final = await bulkCreate.execute("progress", { cards: [{ title: "Progress" }], duplicatePolicy: "skip", format: "json" }, undefined, (update: Json) => updates.push(update), { cwd: process.cwd() });
  assert.ok(updates.length >= 4);
  const progress = updates.map((update) => update.details.progress).filter(Boolean);
  assert.ok(progress.some((entry: Json) => entry.stage === "normalizing"));
  assert.equal(progress.at(-1).stage, "completed");
  for (const entry of progress) {
    for (const key of ["elapsedMs", "recordsProcessed", "requestsAttempted", "queueWaitMs", "created", "failed", "definitelyUnsent"]) assert.equal(typeof entry[key], "number", `missing numeric ${key}`);
  }
  assert.equal(updates.at(-1).details.transient, true);
  assert.match(final.content[0].text, /card-bulk-create/);

  // Headers from a delayed-body 429 must publish the shared cooldown before
  // body consumption, so a concurrent request cannot dispatch early. The
  // waiting operation's progress reports the actual shared-gate wait.
  let releaseDelayedBody!: () => void;
  let headerReturned!: () => void;
  const headerReturnedPromise = new Promise<void>((resolve) => { headerReturned = resolve; });
  let loginFetches = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/cards/create")) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseDelayedBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ message: "slow down" })));
            controller.close();
          };
        },
      });
      headerReturned();
      return new Response(body, { status: 429, headers: { "Retry-After": "1", "content-type": "application/json" } });
    }
    const query = JSON.parse(String(init?.body)).query as Json;
    assert.match(JSON.stringify(query), /loggedInUser/);
    loginFetches += 1;
    return response(login());
  }) as typeof fetch;
  const delayedFirst = invoke({ cards: [{ title: "Delayed 429" }], dryRun: false, duplicatePolicy: "skip", format: "json" });
  await headerReturnedPromise;
  // Allow the first request continuation to observe headers and begin reading.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const concurrentProgress: Json[] = [];
  const delayedSecond = core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: [{ title: "Queued after headers" }], duplicatePolicy: "skip", format: "json" }), process.cwd(), (progress) => concurrentProgress.push(progress));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(loginFetches, 1, "concurrent request dispatched before the delayed 429 body was consumed");
  releaseDelayedBody();
  const delayedFirstResult = parse(await delayedFirst);
  assert.equal(delayedFirstResult.data.failed, 1);
  const delayedSecondResult = parse(await delayedSecond);
  assert.equal(delayedSecondResult.ok, true);
  assert.ok(Math.max(...concurrentProgress.map((entry) => entry.queueWaitMs)) >= 850, "Retry-After wait was not attributed to bulk progress queueWaitMs");

  // /s3/sign is a direct Codecks response path too: its 429 must gate a later
  // Codecks request even though attachment signing does not use requestJson.
  const attachmentDir = await mkdtemp(join(process.cwd(), ".pi-codecks-signing-"));
  const attachmentPath = join(attachmentDir, "note.txt");
  await writeFile(attachmentPath, "attachment");
  try {
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /\/s3\/sign/);
      return response({ message: "slow down" }, 429, { "Retry-After": "1" });
    }) as typeof fetch;
    await assert.rejects(
      () => core.runWithAbortSignal(undefined, () => core.card_add_attachment.execute({ cardId: CARD, filePath: attachmentPath, format: "json" }), process.cwd()),
      /upload signing failed 429/i,
    );
    const signingCooldownAbort = new AbortController();
    signingCooldownAbort.abort();
    globalThis.fetch = (async () => { throw new Error("signing cooldown should prevent fetch"); }) as typeof fetch;
    const signingGated = parse(await invoke({ cards: [{ title: "Blocked by signing cooldown" }], duplicatePolicy: "skip", format: "json" }, signingCooldownAbort.signal));
    assert.equal(signingGated.error.category, "rate_limit_queue_aborted");
  } finally {
    await rm(attachmentDir, { recursive: true, force: true });
  }

  console.log("bulk create progress and reliability tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
