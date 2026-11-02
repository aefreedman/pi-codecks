import assert from "node:assert/strict";
import { executeCardUpdateEffort } from "../src/tools/cards/writes.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async () => { requests++; throw Error("Invalid effort must not query or dispatch"); }) as typeof fetch;
try {
  for (const effort of [undefined, null, "not-a-number", "1", NaN, Infinity, -Infinity, {}, true]) {
    const result = await executeCardUpdateEffort({ cardId: "synthetic", effort });
    assert.equal(result.payload.ok, false);
    assert.equal((result.payload.error as any).category, "validation_error");
    assert.equal((result.payload.effects as any).certainty, "definitely_unsent");
  }
  assert.equal(requests, 0);
  console.log("Effort native semantic guard: nine invalid values, zero queries/dispatches");
} finally { globalThis.fetch = originalFetch; }
