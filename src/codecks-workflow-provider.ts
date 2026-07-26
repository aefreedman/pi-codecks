import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCapabilityRegistry, type RegistrationToken, type RegistryRecord } from "@aefree/pi-capability-registry";
import {
  createWorkflowProviderRegistryV1,
  type DetectionRequestV1,
  type DetectionResultV1,
  type ProviderGuidanceRequestV1,
  type ProviderGuidanceResultV1,
  type ProviderPreflightRequestV1,
  type ProviderPreflightResultV1,
  type WorkflowExecutionContextV1,
  type WorkflowOwnerV1,
  type WorkflowProviderV1,
} from "@aefree/pi-workflow/contracts/v1";

export const CODECKS_WORKFLOW_PROVIDER_ID_V1 = "tracker.codecks" as const;
export const CODECKS_WORKFLOW_GUIDANCE_RESOURCE_ID_V1 = "tracker/codecks-workflow" as const;
export const CODECKS_LEGACY_REFERENCE_PATH_V1 = "references/cg-changelog/codecks-workflow.md" as const;
export const CODECKS_LEGACY_REFERENCE_RESOURCE_ID_V1 = "tracker/codecks-changelog" as const;
export const LEGACY_REFERENCE_SERVICE_REGISTRY_KEY_V1 = "@aefree/pi-game-dev/legacy-reference-services/v1" as const;

const MAX_GUIDANCE_CHARS = 12_000;
const MAX_REFERENCE_BYTES = 50 * 1024;
const MAX_REFERENCE_LINES = 2_000;
const WORKFLOW_SAFETY_GUIDANCE = "Codecks tracker guidance is advisory and preserves the package's specialized tools: never create, update, comment on, review, close, reopen, or otherwise mutate tracker state without explicit user authorization for that operation. Planning, changelog collection, and local implementation completion do not authorize tracker writes. workflow_execute only inspects a matching token; pass it unchanged to the actual Codecks mutation tool, whose final dispatch sink consumes it once. Without a token, only direct TUI/RPC confirmation for the exact stable entity/operation target may authorize dispatch. Prefer the existing structured Codecks tools and their dry-run/preview flows.\n\n";

export interface CodecksWorkflowDependenciesV1 {
  readonly isConfigured: (context: WorkflowExecutionContextV1, request: DetectionRequestV1) => boolean;
  readonly hasCredentials: () => boolean;
  readonly readGuidance: (owner: WorkflowOwnerV1, signal: AbortSignal) => Promise<string>;
}

const defaultDependencies: CodecksWorkflowDependenciesV1 = {
  isConfigured: () => hasAccountConfiguration(),
  hasCredentials: () => hasCredentialConfiguration(),
  readGuidance: async (owner, signal) => readBoundedText(path.join(owner.packageRoot, CODECKS_LEGACY_REFERENCE_PATH_V1), signal, MAX_GUIDANCE_CHARS),
};

/** Read the package copy that actually registered the provider; never hard-code install metadata. */
export async function loadCodecksWorkflowOwnerV1(moduleUrl: string = import.meta.url): Promise<WorkflowOwnerV1> {
  const registeredBy = fileURLToPath(moduleUrl);
  const packageRoot = await realpath(fileURLToPath(new URL("../", moduleUrl)));
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  if (manifest.name !== "@aefree/pi-codecks" || typeof manifest.version !== "string" || manifest.version.trim() === "") {
    throw new Error(`Invalid @aefree/pi-codecks package identity at ${packageRoot}.`);
  }
  return Object.freeze({ packageName: manifest.name, packageVersion: manifest.version, packageRoot, registeredBy });
}

/** Configuration establishes tracker applicability; credential readiness is intentionally a separate preflight. */
export function createCodecksWorkflowProviderV1(
  owner: WorkflowOwnerV1,
  overrides: Partial<CodecksWorkflowDependenciesV1> = {},
): WorkflowProviderV1 {
  const dependencies = { ...defaultDependencies, ...overrides };
  return Object.freeze({
    contractVersion: 1,
    id: CODECKS_WORKFLOW_PROVIDER_ID_V1,
    kind: "tracker",
    owner,
    resources: Object.freeze([Object.freeze({
      packageName: owner.packageName,
      packageVersion: owner.packageVersion,
      resourceId: CODECKS_WORKFLOW_GUIDANCE_RESOURCE_ID_V1,
    })]),
    async detect(context: WorkflowExecutionContextV1, request: DetectionRequestV1): Promise<DetectionResultV1> {
      throwIfAborted(context.signal);
      return dependencies.isConfigured(context, request)
        ? { outcome: "match", workspaceRoot: request.targetPath, evidence: [{ kind: "project_config" }] }
        : { outcome: "no_match" };
    },
    async preflight(context: WorkflowExecutionContextV1, _request: ProviderPreflightRequestV1): Promise<ProviderPreflightResultV1> {
      throwIfAborted(context.signal);
      return dependencies.hasCredentials()
        ? { outcome: "ready" }
        : { outcome: "unavailable", code: "codecks_credentials_missing", retryable: false };
    },
    async loadGuidance(context: WorkflowExecutionContextV1, request: ProviderGuidanceRequestV1): Promise<ProviderGuidanceResultV1> {
      throwIfAborted(context.signal);
      if (request.resourceId !== CODECKS_WORKFLOW_GUIDANCE_RESOURCE_ID_V1) {
        return { outcome: "missing", code: "guidance_not_found", retryable: false };
      }
      try {
        const reference = await dependencies.readGuidance(owner, request.signal);
        throwIfAborted(context.signal);
        const full = `${WORKFLOW_SAFETY_GUIDANCE}${reference}`;
        const maximum = Math.max(1, Math.min(Math.trunc(request.maxChars), MAX_GUIDANCE_CHARS));
        return {
          outcome: "available",
          ref: { packageName: owner.packageName, packageVersion: owner.packageVersion, resourceId: request.resourceId },
          content: full.slice(0, maximum),
          truncated: full.length > maximum,
        };
      } catch (error) {
        if (isAbort(error)) throw error;
        return { outcome: "unavailable", code: "codecks_guidance_unavailable", retryable: true };
      }
    },
  });
}

interface LegacyReferenceServiceV1 extends RegistryRecord {
  readonly contractVersion: 1;
  readonly kind: "legacy-reference-service";
  readonly owner: WorkflowOwnerV1;
  readonly legacyPaths: readonly string[];
  read(
    context: { readonly cwd: string; readonly signal: AbortSignal },
    request: { readonly legacyPath: string; readonly offset?: number; readonly limit?: number; readonly signal: AbortSignal },
  ): Promise<Readonly<Record<string, unknown>>>;
}

/** Register only the single compatibility-map row owned by pi-codecks; this has no install or migration path. */
export function registerCodecksLegacyReferencesV1(
  scope: object,
  owner: WorkflowOwnerV1,
): Readonly<{ token: RegistrationToken; unregister(): boolean }> {
  const registry = createCapabilityRegistry<LegacyReferenceServiceV1>({
    registryKey: LEGACY_REFERENCE_SERVICE_REGISTRY_KEY_V1,
    contractVersion: 1,
    compatibleVersions: [1],
    validate: assertLegacyReferenceServiceV1,
  });
  const service: LegacyReferenceServiceV1 = Object.freeze({
    contractVersion: 1,
    id: "legacy-reference.aefree-pi-codecks",
    kind: "legacy-reference-service",
    owner,
    legacyPaths: Object.freeze([CODECKS_LEGACY_REFERENCE_PATH_V1]),
    async read(_context, request) {
      throwIfAborted(request.signal);
      if (request.legacyPath !== CODECKS_LEGACY_REFERENCE_PATH_V1) throw new Error("legacy_resource_unmapped");
      const offset = request.offset ?? 1;
      const limit = request.limit ?? MAX_REFERENCE_LINES;
      if (!Number.isInteger(offset) || offset < 1 || offset > 100_000) throw new TypeError("offset must be an integer from 1 to 100000");
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REFERENCE_LINES) throw new TypeError(`limit must be an integer from 1 to ${MAX_REFERENCE_LINES}`);
      const candidate = path.resolve(owner.packageRoot, "compatibility", "legacy-reference-v1", CODECKS_LEGACY_REFERENCE_PATH_V1);
      const canonical = await realpath(candidate);
      if (!isWithin(owner.packageRoot, canonical)) throw new Error("legacy_resource_outside_package");
      const text = await readBoundedText(canonical, request.signal, MAX_REFERENCE_BYTES);
      const lines = text.split(/\r?\n/);
      const content = lines.slice(offset - 1, offset - 1 + limit).join("\n");
      return Object.freeze({
        content,
        legacyPath: CODECKS_LEGACY_REFERENCE_PATH_V1,
        resourceId: CODECKS_LEGACY_REFERENCE_RESOURCE_ID_V1,
        ...(request.offset === undefined ? {} : { offset: request.offset }),
        ...(request.limit === undefined ? {} : { limit: request.limit }),
        lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
        totalLines: lines.length,
        provenance: Object.freeze({
          packageName: owner.packageName,
          packageVersion: owner.packageVersion,
          resourceId: CODECKS_LEGACY_REFERENCE_RESOURCE_ID_V1,
          contractVersion: 1 as const,
        }),
      });
    },
  });
  const token = registry.register(scope, service);
  let active = true;
  return Object.freeze({
    token,
    unregister() {
      if (!active) return false;
      active = false;
      return registry.unregister(token);
    },
  });
}

export function registerCodecksWorkflowProviderV1(scope: object, owner: WorkflowOwnerV1): Readonly<{ token: RegistrationToken; unregister(): boolean }> {
  const registry = createWorkflowProviderRegistryV1();
  const token = registry.register(scope, createCodecksWorkflowProviderV1(owner));
  let active = true;
  return Object.freeze({
    token,
    unregister() {
      if (!active) return false;
      active = false;
      return registry.unregister(token);
    },
  });
}

function hasAccountConfiguration(): boolean {
  return ["CODECKS_ACCOUNT", "CODECKS_SUBDOMAIN", "CODECKS_API_BASE", "CODECKS_PROFILE"].some((key) => hasValue(process.env[key]));
}
function hasCredentialConfiguration(): boolean {
  if (hasValue(process.env.CODECKS_TOKEN) || hasValue(process.env.CODECKS_API_TOKEN)) return true;
  const profile = process.env.CODECKS_PROFILE?.trim();
  return profile !== undefined && profile !== "" && hasValue(process.env[`CODECKS_PROFILE_${profile.toUpperCase()}_TOKEN`]);
}
function hasValue(value: string | undefined): boolean { return value !== undefined && value.trim() !== ""; }
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
async function readBoundedText(filePath: string, signal: AbortSignal, maximum: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    throwIfAborted(signal);
    const buffer = Buffer.alloc(maximum + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximum) throw new Error("resource_too_large");
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (text.split(/\r?\n/).length > MAX_REFERENCE_LINES) throw new Error("resource_too_large");
    return text;
  } finally {
    await handle.close();
  }
}
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw abortError(); }
function isAbort(error: unknown): boolean { return error instanceof Error && error.name === "AbortError"; }
function abortError(): Error { const error = new Error("Operation cancelled."); error.name = "AbortError"; return error; }
function assertLegacyReferenceServiceV1(value: unknown): asserts value is LegacyReferenceServiceV1 {
  if (value === null || typeof value !== "object") throw new TypeError("legacy reference service must be an object");
  const service = value as Partial<LegacyReferenceServiceV1>;
  if (service.contractVersion !== 1 || service.kind !== "legacy-reference-service" || typeof service.id !== "string") throw new TypeError("invalid legacy reference identity");
  if (service.owner === undefined || typeof service.owner.packageName !== "string" || typeof service.owner.packageRoot !== "string" || typeof service.owner.packageVersion !== "string") throw new TypeError("invalid legacy reference owner");
  if (!Array.isArray(service.legacyPaths) || service.legacyPaths.length !== 1 || service.legacyPaths[0] !== CODECKS_LEGACY_REFERENCE_PATH_V1 || typeof service.read !== "function") throw new TypeError("invalid legacy reference surface");
}
