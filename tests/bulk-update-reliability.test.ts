import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as core from "../src/codecks-core.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";

useInertEnvironmentCredentialProvider();
const CARD_ID = "11111111-1111-4111-8111-111111111111";
const parse = (value: unknown): any => JSON.parse(String(value).match(/```json\s*([\s\S]*?)\s*```/)![1]);
const response = (payload: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
const card = () => response({ data: { card: { [CARD_ID]: { cardId: CARD_ID, accountSeq: 31, title: "Existing", content: "Existing body", status: "not_started", isDoc: false } } } });
const invoke = (args: Record<string, unknown>, updates: any[] = []) => core.runWithAbortSignal(undefined, () => core.card_bulk_update.execute(args), process.cwd(), update => updates.push(update));
const originalFetch = globalThis.fetch;

try {
  let dispatches = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/dispatch/cards/update")) { dispatches += 1; return dispatches === 1 ? response({}, 429, { "Retry-After": "0" }) : response({ data: { accepted: true } }); }
    return card();
  }) as typeof fetch;
  const updates = [{ cardId: CARD_ID, title: "Preview-bound update", correlationKey: "row-1" }];
  const preview = parse(await invoke({ updates, dryRun: true, format: "json" }));
  assert.match(preview.data.previewFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(preview.data.results.length, 0, "successful preview stays compact");
  assert.match(preview.data.artifact.path, /pi-codecks-bulk-update/);
  assert.match(await readFile(preview.data.artifact.path, "utf8"), /Preview-bound update/);

  const mismatch = parse(await invoke({ updates: [{ ...updates[0], title: "Changed after preview" }], dryRun: false, expectedPreviewFingerprint: preview.data.previewFingerprint, format: "json" }));
  assert.equal(mismatch.ok, false); assert.equal(mismatch.error.dispatchRequests, 0); assert.equal(dispatches, 0);
  assert.doesNotMatch(JSON.stringify(mismatch), /Changed after preview/);

  const progress: any[] = [];
  const applied = parse(await invoke({ updates, dryRun: false, expectedPreviewFingerprint: preview.data.previewFingerprint, format: "json" }, progress));
  assert.equal(dispatches, 2, "only the explicit 429 is retried"); assert.equal(applied.data.updated, 1); assert.equal(applied.data.metrics.retryEvents.length, 1);
  assert.equal(applied.data.results.length, 0, "successful apply stays compact"); assert.ok(progress.some(update => update.stage === "rate_limited_retrying"));
  assert.ok(progress.some(update => update.updated === 1 && update.succeeded === 1), "progress reports update successes without create-specific accounting");
  const detail = await readFile(applied.data.artifact.path, "utf8"); assert.match(detail, /dispatchReturned/);

  core.__test.resetRateGate();
  dispatches = 0;
  globalThis.fetch = (async (input) => {
    if (String(input).includes("/dispatch/cards/update")) { dispatches += 1; return response({}, 429, { "Retry-After": "0" }); }
    return card();
  }) as typeof fetch;
  const exhaustedPreview = parse(await invoke({ updates, dryRun: true, format: "json" }));
  const exhausted = parse(await invoke({ updates, dryRun: false, expectedPreviewFingerprint: exhaustedPreview.data.previewFingerprint, format: "json" }));
  assert.equal(dispatches, 3, "three consecutive explicit 429 responses stop after two retries");
  assert.equal(exhausted.data.failed, 1);
  assert.equal(exhausted.data.metrics.retryEvents.length, 2);
  assert.equal(exhausted.data.metrics.consecutive429, 3);

  console.log("bulk update reliability tests passed");
} finally { core.__test.resetRateGate(); globalThis.fetch = originalFetch; }
