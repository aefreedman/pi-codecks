import assert from "node:assert/strict";
import * as core from "../src/codecks-core.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
const user = "33333333-3333-4333-8333-333333333333";
const parse = (value: unknown) => JSON.parse(String(value).match(/```json\s*([\s\S]*?)\s*```/)![1]);
const previewFingerprint = async (cards: unknown[]) => parse(await core.card_bulk_create.execute({ cards, dryRun: true, format: "json" })).data.previewFingerprint as string;
const response = (payload: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
const loggedIn = () => response({ data: { _root: { loggedInUser: user }, user: { [user]: { id: user, name: "Sam" } } } });
const created = (sequence: number) => response({ payload: { id: `11111111-1111-4111-8111-${String(sequence).padStart(12, "0")}`, accountSeq: sequence } });
const originalFetch = globalThis.fetch;

try {
  const now = Date.now();
  assert.equal(core.__test.parseRetryAfterMs("5000").value, 5000);
  assert.equal(core.__test.parseRetryAfterMs("5000").format, "codecks_milliseconds");
  assert.equal(core.__test.parseRetryAfterMs("0.0001").value, 1);
  assert.equal(core.__test.parseRetryAfterMs("14999.1").value, 15000);
  const decimalOverBudget = core.__test.parseRetryAfterMs("15000.1");
  assert.equal(decimalOverBudget.status, "over_budget"); assert.equal(decimalOverBudget.requestedMs, 15001);
  const numericOverflow = core.__test.parseRetryAfterMs("9".repeat(400));
  assert.equal(numericOverflow.status, "non_finite");
  assert.ok((core.__test.parseRetryAfterMs(new Date(now + 2000).toUTCString()).value ?? 9999) <= 2000);
  const dateOverBudget = core.__test.parseRetryAfterMs(new Date(now + 60_000).toUTCString());
  assert.equal(dateOverBudget.status, "over_budget"); assert.ok((dateOverBudget.requestedMs ?? 0) > 15000);
  assert.equal(core.__test.parseRetryAfterMs(null).status, "missing");
  assert.equal(core.__test.parseRetryAfterMs("-1").status, "negative");
  const malformed = core.__test.parseRetryAfterMs("secret-header-value-do-not-leak");
  assert.equal(malformed.status, "malformed"); assert.doesNotMatch(JSON.stringify(malformed), /secret-header-value/i);
  core.__test.resetRateGate();
  core.__test.observeServerCooldown(response({}, 200, { "Retry-After": "1" }));
  assert.equal(core.__test.getRateGateState().cooldownUntil, 0);
  core.__test.observeServerCooldown(response({}, 429, { "Retry-After": "1" }));
  assert.ok(core.__test.getRateGateState().cooldownUntil > Date.now());
  core.__test.resetRateGate();

  let directDispatches = 0;
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); directDispatches += 1; return created(1); }) as typeof fetch;
  const directCards = [{ title: "direct" }];
  const directFingerprint = await previewFingerprint(directCards);
  core.__test.seedRateGate(Array.from({ length: 40 }, () => Date.now() - 4900));
  const direct = parse(await core.card_bulk_create.execute({ cards: directCards, dryRun: false, expectedPreviewFingerprint: directFingerprint, format: "json" }));
  assert.equal(directDispatches, 1); assert.equal(direct.data.metrics.physicalRequests, 2); assert.equal(direct.data.metrics.dispatchRequests, 1);
  assert.ok(direct.data.metrics.localGateWaitMs > 0); assert.equal(direct.data.metrics.serverCooldownWaitMs, 0);

  core.__test.resetRateGate(); const pacingUpdates: any[] = [];
  globalThis.fetch = (async (input) => {
    if (!String(input).includes("/dispatch/")) { core.__test.seedRateGate(Array.from({ length: 40 }, () => Date.now() - 3900)); return loggedIn(); }
    return created(2);
  }) as typeof fetch;
  const pacedCards = [{ title: "paced" }];
  const pacedFingerprint = await previewFingerprint(pacedCards);
  const paced = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: pacedCards, dryRun: false, expectedPreviewFingerprint: pacedFingerprint, format: "json" }), process.cwd(), update => pacingUpdates.push(update)));
  assert.equal(paced.data.created, 1);
  const gateUpdates = pacingUpdates.filter((update: any) => update.pacingReason);
  assert.ok(gateUpdates.length >= 2); assert.ok(gateUpdates.some((update: any) => update.recordIndex === 1 && update.recordCount === 1));

  let dispatches = 0; const updates: any[] = [];
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; return dispatches <= 2 ? response({}, 429, { "Retry-After": "0" }) : created(dispatches); }) as typeof fetch;
  const retriedCards = [{ title: "retry" }, { title: "after-reset" }];
  const retriedFingerprint = await previewFingerprint(retriedCards);
  const retried = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: retriedCards, dryRun: false, expectedPreviewFingerprint: retriedFingerprint, format: "json" }), process.cwd(), update => updates.push(update)));
  assert.equal(dispatches, 4); assert.equal(retried.data.created, 2); assert.equal(retried.data.metrics.retryEvents.length, 2);
  assert.equal(retried.data.metrics.consecutive429, 0); assert.equal(retried.data.metrics.uniqueRecordsAttempted, 2);
  assert.ok(updates.some((x: any) => x.stage === "rate_limited_retrying" && x.recordIndex === 1 && x.retryAttempt === 1));

  core.__test.resetRateGate(); dispatches = 0;
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; return dispatches === 1 ? response({}, 429, { "Retry-After": "5000" }) : created(dispatches); }) as typeof fetch;
  const millisecondsCards = [{ title: "five-second-retry" }, { title: "continued" }];
  const millisecondsFingerprint = await previewFingerprint(millisecondsCards);
  const millisecondsRetry = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: millisecondsCards, dryRun: false, expectedPreviewFingerprint: millisecondsFingerprint, format: "json" }), process.cwd()));
  assert.equal(dispatches, 3); assert.equal(millisecondsRetry.data.created, 2);
  assert.equal(millisecondsRetry.data.metrics.retryEvents[0].retryAfterMs, 5000);
  assert.equal(millisecondsRetry.data.metrics.retryEvents[0].retryAfterFormat, "codecks_milliseconds");
  assert.ok(millisecondsRetry.data.metrics.serverCooldownWaitMs >= 4500);

  core.__test.resetRateGate(); dispatches = 0;
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; return response({}, 429, { "Retry-After": "0" }); }) as typeof fetch;
  const stoppedCards = [{ title: "stop" }, { title: "untouched" }];
  const stoppedFingerprint = await previewFingerprint(stoppedCards);
  const stopped = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: stoppedCards, dryRun: false, expectedPreviewFingerprint: stoppedFingerprint, format: "json" }), process.cwd()));
  assert.equal(dispatches, 3); assert.equal(stopped.data.results[0].status, "failed"); assert.equal(stopped.data.results[1].status, "definitely_unsent");
  assert.equal(stopped.data.metrics.consecutive429, 3); assert.deepEqual(stopped.data.metrics.safeContinuationRange, { startIndex: 1, endIndex: 1 });

  for (const [retryAfter, expectedStatus] of [["secret-header-value-do-not-leak", "malformed"], ["15000.1", "over_budget"], [new Date(Date.now() + 60_000).toUTCString(), "over_budget"]] as const) {
    core.__test.resetRateGate(); dispatches = 0;
    globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; return response({}, 429, { "Retry-After": retryAfter }); }) as typeof fetch;
    const invalidCards = [{ title: "bad-header" }];
    const invalidFingerprint = await previewFingerprint(invalidCards);
    const invalid = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: invalidCards, dryRun: false, expectedPreviewFingerprint: invalidFingerprint, format: "json" }), process.cwd()));
    assert.equal(dispatches, 1); assert.equal(invalid.data.failed, 1); assert.equal(invalid.data.metrics.retryEvents.length, 0);
    assert.equal(invalid.data.results[0].error.retryAfterParseStatus, expectedStatus);
    assert.equal(invalid.data.metrics.rateLimitEvents[0].retryAfterParseStatus, expectedStatus);
    assert.doesNotMatch(JSON.stringify(invalid), /secret-header-value/i);
  }

  core.__test.resetRateGate(); const sensitiveUpdates: any[] = []; dispatches = 0;
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; return response({ token: "secret-429-body", unknown: { authorization: "do-not-leak" } }, 429, { "Retry-After": "0" }); }) as typeof fetch;
  const sensitiveCards = [{ title: "last" }];
  const sensitiveFingerprint = await previewFingerprint(sensitiveCards);
  const sensitive = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: sensitiveCards, dryRun: false, expectedPreviewFingerprint: sensitiveFingerprint, format: "json" }), process.cwd(), update => sensitiveUpdates.push(update)));
  const sensitiveSerialized = JSON.stringify({ result: sensitive, updates: sensitiveUpdates });
  assert.equal(dispatches, 3); assert.equal(sensitive.data.metrics.safeContinuationRange, null); assert.equal(sensitive.data.results[0].error.message, "Codecks rejected the request with HTTP 429.");
  assert.doesNotMatch(sensitiveSerialized, /secret-429-body|do-not-leak|authorization/i);

  core.__test.resetRateGate(); dispatches = 0;
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; throw new Error("network timeout"); }) as typeof fetch;
  const ambiguousCards = [{ title: "ambiguous" }, { title: "untouched" }];
  const ambiguousFingerprint = await previewFingerprint(ambiguousCards);
  const ambiguous = parse(await core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute({ cards: ambiguousCards, dryRun: false, expectedPreviewFingerprint: ambiguousFingerprint, format: "json" }), process.cwd()));
  assert.equal(dispatches, 1); assert.equal(ambiguous.data.results[0].status, "indeterminate"); assert.equal(ambiguous.data.results[1].status, "definitely_unsent");

  core.__test.resetRateGate(); dispatches = 0; const aborter = new AbortController();
  globalThis.fetch = (async (input) => { if (!String(input).includes("/dispatch/")) return loggedIn(); dispatches += 1; return response({}, 429, { "Retry-After": "5000" }); }) as typeof fetch;
  const cancelledCards = [{ title: "cancel" }, { title: "untouched" }];
  const cancelledFingerprint = await previewFingerprint(cancelledCards);
  const cancelled = core.runWithAbortSignal(aborter.signal, () => core.card_bulk_create.execute({ cards: cancelledCards, dryRun: false, expectedPreviewFingerprint: cancelledFingerprint, format: "json" }), process.cwd());
  await new Promise(resolve => setTimeout(resolve, 25)); aborter.abort();
  const cancelledData = parse(await cancelled); assert.equal(dispatches, 1); assert.equal(cancelledData.data.results[0].status, "definitely_unsent"); assert.equal(cancelledData.data.results[1].status, "definitely_unsent");
} finally { core.__test.resetRateGate(); globalThis.fetch = originalFetch; }
console.log("bulk create progress and reliability tests passed");
