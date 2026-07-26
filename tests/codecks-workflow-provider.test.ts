import assert from "node:assert/strict";
import test from "node:test";
import { createCapabilityRegistry } from "@aefree/pi-capability-registry";
import {
  createWorkflowProviderRegistryV1,
  resolveWorkflowProvidersV1,
} from "@aefree/pi-workflow/contracts/v1";
import { assertWorkflowProviderConformanceV1 } from "@aefree/pi-workflow/contracts/v1/conformance";
import registerCodecks from "../index";
import {
  CODECKS_LEGACY_REFERENCE_PATH_V1,
  CODECKS_WORKFLOW_GUIDANCE_RESOURCE_ID_V1,
  LEGACY_REFERENCE_SERVICE_REGISTRY_KEY_V1,
  createCodecksWorkflowProviderV1,
  loadCodecksWorkflowOwnerV1,
} from "../src/codecks-workflow-provider";

const WORKFLOW_PROVIDER_REGISTRY_KEY = "@aefree/pi-workflow/providers/v1";

function resetRegistries(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(WORKFLOW_PROVIDER_REGISTRY_KEY)];
  delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for(LEGACY_REFERENCE_SERVICE_REGISTRY_KEY_V1)];
}
function legacyRegistry() {
  return createCapabilityRegistry<any>({
    registryKey: LEGACY_REFERENCE_SERVICE_REGISTRY_KEY_V1,
    contractVersion: 1,
    compatibleVersions: [1],
    validate(value: unknown) { if (value === null || typeof value !== "object") throw new TypeError("invalid legacy fixture service"); },
  });
}
function scope() { return { getBranch: () => [] as unknown[] }; }
function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, context: any) => Promise<void> | void>>();
  const tools: any[] = [];
  return {
    handlers,
    tools,
    on(name: string, handler: (event: unknown, context: any) => Promise<void> | void) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: any) { tools.push(tool); },
    getAllTools() { return tools; },
    getActiveTools() { return []; },
    setActiveTools() {},
  };
}
async function emit(pi: ReturnType<typeof fakePi>, name: string, sessionManager: object) {
  for (const handler of pi.handlers.get(name) ?? []) await handler({ reason: name }, { sessionManager });
}

test("Codecks tracker provider distinguishes configuration applicability from credential readiness and has bounded safety guidance", async () => {
  const owner = await loadCodecksWorkflowOwnerV1();
  const provider = createCodecksWorkflowProviderV1(owner, {
    isConfigured: (_context, request) => request.targetPath.startsWith("/fixture/codecks"),
    hasCredentials: () => true,
    readGuidance: async () => "legacy changelog guidance",
  });
  const report = await assertWorkflowProviderConformanceV1({
    createProvider: () => provider,
    matchingTarget: "/fixture/codecks/card",
    nonMatchingTarget: "/fixture/other/card",
    guidanceResourceId: CODECKS_WORKFLOW_GUIDANCE_RESOURCE_ID_V1,
  });
  assert.equal(report.passed, true);
  const guidance = await provider.loadGuidance!({ cwd: "/fixture", signal: new AbortController().signal }, {
    resourceId: CODECKS_WORKFLOW_GUIDANCE_RESOURCE_ID_V1,
    purpose: "changelog",
    maxChars: 500,
    signal: new AbortController().signal,
  });
  assert.equal(guidance.outcome, "available");
  if (guidance.outcome === "available") assert.match(guidance.content, /explicit user intent/i);

  const unready = createCodecksWorkflowProviderV1(owner, { isConfigured: () => true, hasCredentials: () => false });
  const readiness = await unready.preflight!({ cwd: "/fixture", signal: new AbortController().signal }, {
    targetPath: "/fixture/codecks/card", workspaceRoot: "/fixture/codecks/card", operation: "read", signal: new AbortController().signal,
  });
  assert.deepEqual(readiness, { outcome: "unavailable", code: "codecks_credentials_missing", retryable: false });
});

test("Codecks registration supports consumer-first resolution, incompatible catalogs, exact legacy provenance, and stale-safe two-scope cleanup", async () => {
  resetRegistries();
  try {
    const first = scope();
    assert.equal(resolveWorkflowProvidersV1(first).outcome, "missing", "consumer-before-provider is missing");
    createCapabilityRegistry<any>({ registryKey: WORKFLOW_PROVIDER_REGISTRY_KEY, contractVersion: 2 }).register(first, {
      contractVersion: 2,
      id: "tracker.future",
      kind: "tracker",
      owner: { packageName: "@fixture/future", packageVersion: "2.0.0", packageRoot: "/private", registeredBy: "fixture" },
    });
    assert.equal(resolveWorkflowProvidersV1(first).outcome, "incompatible", "future-only provider catalog is incompatible");

    const pi = fakePi();
    registerCodecks(pi as any);
    await emit(pi, "session_start", first);
    assert.deepEqual(createWorkflowProviderRegistryV1().snapshotCompatible(first).map((provider) => provider.id), ["tracker.codecks"]);
    const legacy = legacyRegistry().snapshotCompatible(first);
    assert.equal(legacy.length, 1);
    assert.deepEqual(legacy[0].legacyPaths, [CODECKS_LEGACY_REFERENCE_PATH_V1]);
    const signal = new AbortController().signal;
    const result = await legacy[0].read({ cwd: process.cwd(), signal }, { legacyPath: CODECKS_LEGACY_REFERENCE_PATH_V1, offset: 1, limit: 2, signal });
    assert.equal(result.provenance.packageName, "@aefree/pi-codecks");
    assert.equal(result.provenance.resourceId, "tracker/codecks-changelog");
    assert.equal(JSON.stringify(result).includes(legacy[0].owner.packageRoot), false, "reference provenance must not disclose package installation paths");
    await assert.rejects(legacy[0].read({ cwd: process.cwd(), signal }, { legacyPath: "references/cg-changelog/not-owned.md", signal }), /legacy_resource_unmapped/);

    const second = scope();
    await emit(pi, "session_start", second);
    assert.equal(createWorkflowProviderRegistryV1().snapshotCompatible(first).length, 0, "replacement start clears the previous scope");
    assert.equal(createWorkflowProviderRegistryV1().snapshotCompatible(second).length, 1);
    await emit(pi, "session_shutdown", first);
    assert.equal(createWorkflowProviderRegistryV1().snapshotCompatible(second).length, 1, "delayed old-session shutdown preserves replacement scope");
    await emit(pi, "session_shutdown", second);
    assert.equal(createWorkflowProviderRegistryV1().snapshotCompatible(second).length, 0);
    assert.equal(legacyRegistry().snapshotCompatible(second).length, 0);
  } finally {
    resetRegistries();
  }
});

console.log("Codecks workflow provider conformance, reverse-load, legacy-reference, and stale-cleanup tests passed");
