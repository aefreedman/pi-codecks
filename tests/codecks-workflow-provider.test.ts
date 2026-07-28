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

  const resourceTargets = [
    ["deck", "123e4567-e89b-12d3-a456-426614174000"],
    ["card", "123e4567-e89b-12d3-a456-426614174001"],
    ["milestone", "123e4567-e89b-12d3-a456-426614174002"],
    ["run", "123e4567-e89b-12d3-a456-426614174003"],
  ] as const;
  for (const [kind, id] of resourceTargets) {
    assert.deepEqual(parseCodecksWorkflowTargetV1(`codecks:${kind}:${id}`), { kind, id });
  }
  for (const target of [
    "tracker:card:123e4567-e89b-12d3-a456-426614174000",
    "github:issue:123e4567-e89b-12d3-a456-426614174000",
    "codecks:acme",
    "codecks:card:not-a-uuid",
    "codecks:issue:123e4567-e89b-12d3-a456-426614174000",
    "codecks:card:123E4567-E89B-12D3-A456-426614174000",
    "codecks:card:123e4567-e89b-12d3-a456-426614174000:extra",
    "codecks:card:123e4567-e89b-12d3-a456-426614174000/child",
  ]) {
    assert.equal(parseCodecksWorkflowTargetV1(target), undefined, `must not claim unrelated or invalid target '${target}'`);
  }

  resetCredentials();
  const provider = createCodecksWorkflowProviderV1();
  const signal = new AbortController().signal;
  const context = { cwd: process.cwd(), signal };
  const invalidTarget = "github:issue:123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(await provider.detect(context, { targetPath: invalidTarget, operation: "mutate", signal }), { outcome: "no_match" });
  assert.deepEqual(await provider.preflight!(context, { targetPath: invalidTarget, workspaceRoot: invalidTarget, operation: "mutate", signal }), {
    outcome: "blocked", code: "codecks_target_invalid", retryable: false,
  });
  for (const [kind, id] of resourceTargets) {
    const targetPath = `codecks:${kind}:${id}`;
    const detectedWithoutCredentials = await provider.detect(context, { targetPath, operation: "mutate", signal });
    assert.equal(detectedWithoutCredentials.outcome, "match", "missing credentials are readiness, not provider applicability");
    assert.deepEqual(await provider.preflight!(context, { targetPath, workspaceRoot: targetPath, operation: "mutate", signal }), {
      outcome: "blocked", code: "codecks_credentials_missing", retryable: false,
    });
  }

  process.env.CODECKS_ACCOUNT = "other-account";
  process.env.CODECKS_TOKEN = "test-token";
  for (const [kind, id] of resourceTargets) {
    const targetPath = `codecks:${kind}:${id}`;
    assert.equal((await provider.detect(context, { targetPath, operation: "mutate", signal })).outcome, "match", "configured account must not affect resource ownership");
    assert.deepEqual(await provider.preflight!(context, { targetPath, workspaceRoot: targetPath, operation: "mutate", signal }), { outcome: "ready" }, "configured account only establishes credential readiness");
  }
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
    matchingTarget: "codecks:card:123e4567-e89b-12d3-a456-426614174000",
    nonMatchingTarget: "tracker:card:123e4567-e89b-12d3-a456-426614174000",
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
