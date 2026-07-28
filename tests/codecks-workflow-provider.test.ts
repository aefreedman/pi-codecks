import assert from "node:assert/strict";
import { createWorkflowProviderRegistryV1, resolveWorkflowProvidersV1 } from "@aefree/pi-workflow/contracts/v1";
import { assertWorkflowProviderConformanceV1 } from "@aefree/pi-workflow/contracts/v1/conformance";
import {
  CODECKS_WORKFLOW_PROVIDER_ID_V1,
  createCodecksWorkflowProviderV1,
  parseCodecksWorkflowTargetV1,
} from "../src/codecks-workflow-provider.ts";
import { PiToolHarness } from "./pi-tool-harness.ts";

const ENVIRONMENT_KEYS = [
  "CODECKS_ACCOUNT", "CODECKS_SUBDOMAIN", "CODECKS_TOKEN", "CODECKS_API_TOKEN", "CODECKS_PROFILE",
] as const;
const savedEnvironment = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function resetCredentials(): void {
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
}

try {
  let fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls += 1; throw new Error("workflow provider must not call Codecks"); }) as typeof fetch;

  assert.equal(parseCodecksWorkflowTargetV1("codecks:acme"), "acme");
  assert.equal(parseCodecksWorkflowTargetV1("codecks:acme-team"), "acme-team");
  for (const target of ["tracker:acme", "codecks:Acme", "codecks:acme/card/12", "codecks:", "codecks:acme_team"]) {
    assert.equal(parseCodecksWorkflowTargetV1(target), undefined, `must not claim unrelated or noncanonical target '${target}'`);
  }

  resetCredentials();
  const provider = createCodecksWorkflowProviderV1();
  const signal = new AbortController().signal;
  const context = { cwd: process.cwd(), signal };
  const detectedWithoutCredentials = await provider.detect(context, { targetPath: "codecks:acme", operation: "mutate", signal });
  assert.equal(detectedWithoutCredentials.outcome, "match", "missing credentials are readiness, not provider existence");
  assert.deepEqual(await provider.preflight!(context, { targetPath: "codecks:acme", workspaceRoot: "codecks:acme", operation: "mutate", signal }), {
    outcome: "blocked", code: "codecks_credentials_missing", retryable: false,
  });

  process.env.CODECKS_ACCOUNT = "other-account";
  process.env.CODECKS_TOKEN = "test-token";
  assert.deepEqual(await provider.detect(context, { targetPath: "codecks:acme", operation: "mutate", signal }), { outcome: "no_match" }, "a configured account must not claim another Codecks account");

  process.env.CODECKS_ACCOUNT = "acme";
  const detected = await provider.detect(context, { targetPath: "codecks:acme", operation: "mutate", signal });
  assert.equal(detected.outcome, "match");
  assert.deepEqual(await provider.preflight!(context, { targetPath: "codecks:acme", workspaceRoot: "codecks:acme", operation: "mutate", signal }), { outcome: "ready" });
  const guidance = await provider.loadGuidance!(context, { resourceId: "guidance/codecks/work", purpose: "work", maxChars: 48, signal });
  assert.equal(guidance.outcome, "available");
  if (guidance.outcome === "available") {
    assert.equal(guidance.content.length, 48);
    assert.equal(guidance.truncated, true);
    assert.match(guidance.content, /Codecks tracker work/);
  }
  assert.equal(fetchCalls, 0, "detection, readiness, and guidance must not contact Codecks");

  const conformance = await assertWorkflowProviderConformanceV1({
    createProvider: createCodecksWorkflowProviderV1,
    matchingTarget: "codecks:acme",
    nonMatchingTarget: "tracker:acme",
    guidanceResourceId: "guidance/codecks/work",
  });
  assert.equal(conformance.passed, true);

  const registry = createWorkflowProviderRegistryV1();
  const first = new PiToolHarness({ activeTools: ["foreign_tool"] });
  await first.load();
  assert.equal(resolveWorkflowProvidersV1(first.sessionManager, registry).outcome, "missing", "registration must wait for session_start");
  await first.startSession([], "startup");
  const firstProviders = registry.snapshotCompatible(first.sessionManager);
  assert.deepEqual(firstProviders.map((entry) => entry.id), [CODECKS_WORKFLOW_PROVIDER_ID_V1], "session_start registers the Codecks provider without any Codecks tool activation");
  assert.equal(fetchCalls, 0);

  const reloaded = new PiToolHarness({ activeTools: ["foreign_tool"] });
  await reloaded.load();
  await reloaded.startSession([], "reload");
  assert.deepEqual(registry.snapshotCompatible(reloaded.sessionManager).map((entry) => entry.id), [CODECKS_WORKFLOW_PROVIDER_ID_V1], "a fresh session manager after reload receives a fresh provider registration");

  await first.shutdownSession();
  assert.equal(registry.snapshotCompatible(first.sessionManager).length, 0, "matching shutdown unregisters the first session provider");
  assert.deepEqual(registry.snapshotCompatible(reloaded.sessionManager).map((entry) => entry.id), [CODECKS_WORKFLOW_PROVIDER_ID_V1], "one session shutdown must not remove the reloaded session provider");
  await reloaded.shutdownSession();
  assert.equal(registry.snapshotCompatible(reloaded.sessionManager).length, 0, "matching shutdown unregisters the reloaded session provider");
  assert.equal(fetchCalls, 0);

  console.log("Codecks workflow provider lifecycle and readiness tests passed");
} finally {
  globalThis.fetch = originalFetch;
  for (const key of ENVIRONMENT_KEYS) {
    const value = savedEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
