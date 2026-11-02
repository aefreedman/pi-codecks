import assert from "node:assert/strict";
import { executeCardUpdateEffort } from "../src/tools/cards/writes.ts";
import { getCodecksToolDefinition } from "../src/pi/tool-catalog.ts";
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
useInertEnvironmentCredentialProvider();
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (async () => { requests++; throw Error("Invalid effort must not query or dispatch"); }) as typeof fetch;
try {
  const prepare = getCodecksToolDefinition("card_update_effort").config.prepareArguments!;
  for (const effort of ["true", "false", "", "   ", "\t\n", "not-a-number", "NaN", "Infinity", "1x"]) {
    assert.throws(() => prepare({ cardId: "synthetic", effort }), /Effort must be a finite number/);
  }
  for (const effort of [0, 1, "0", "1", " 2.5 ", "-1", "1e2"]) {
    assert.equal(prepare({ cardId: "synthetic", effort }).effort, effort, "preparation preserves legitimate numbers for host validation");
  }
  for (const effort of [undefined, null, "not-a-number", "1", NaN, Infinity, -Infinity, {}, true]) {
    const result = await executeCardUpdateEffort({ cardId: "synthetic", effort });
    assert.equal(result.payload.ok, false);
    assert.equal((result.payload.error as any).category, "validation_error");
    assert.equal((result.payload.effects as any).certainty, "definitely_unsent");
  }
  assert.equal(requests, 0);
  console.log("Effort native semantic guard: nine invalid values, zero queries/dispatches");
} finally { globalThis.fetch = originalFetch; }
