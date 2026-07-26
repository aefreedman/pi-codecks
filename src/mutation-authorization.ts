import { createHash } from "node:crypto";
import {
  consumeWorkflowAuthorizationTokenV1,
  issueWorkflowAuthorizationTokenV1,
  type WorkflowAuthorizationTokenDecisionV1,
} from "@aefree/pi-workflow/authorization/v1";

export type CodecksMutationAuthorizationContext = {
  readonly sessionManager: object;
  readonly mode: "tui" | "rpc" | "json" | "print" | string;
  readonly hasUI: boolean;
  readonly authorizationToken?: string;
  readonly confirm?: (title: string, message: string) => Promise<boolean>;
  readonly workspaceRoot?: string;
  authorizationProvenance?: Array<Readonly<{
    authoritySource: "authorization_token_consumed" | "direct_user_confirmation";
    action: "tracker_mutation";
    canonicalTargets: readonly string[];
    consumed: true;
  }>>;
};

export type CodecksMutationTarget = Readonly<{
  action: "tracker_mutation";
  target: string;
  classified: boolean;
  confirmationDetails?: readonly string[];
}>;

export const CODECKS_MUTATION_DISPATCH_PATHS_V1 = Object.freeze([
  "cards/create",
  "cards/update",
  "cards/addFile",
  "decks/update",
  "milestones/update",
  "sprints/updateSprint",
  "resolvables/create",
  "resolvables/comment",
  "resolvables/updateComment",
  "resolvables/close",
  "resolvables/reopen",
] as const);
const KNOWN_DISPATCH_PATHS = new Set<string>(CODECKS_MUTATION_DISPATCH_PATHS_V1);

const encodeTargetSegment = (value: unknown): string => encodeURIComponent(String(value ?? "").trim())
  .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const payloadFingerprint = (payload: Record<string, unknown>): string => createHash("sha256")
  .update(JSON.stringify(sortJson(payload)))
  .digest("hex")
  .slice(0, 24);

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "sessionId")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, sortJson(nested)]));
}

function dispatchEntityId(path: string, payload: Record<string, unknown>): string {
  const candidates = path === "cards/addFile"
    ? [payload.cardId, (payload.fileData as Record<string, unknown> | undefined)?.fileName]
    : path === "resolvables/create"
      ? [payload.cardId]
      : [payload.id, payload.cardId, payload.resolvableId, payload.entryId];
  const selected = candidates.filter((value) => value !== undefined && value !== null && String(value).trim() !== "");
  return selected.length > 0 ? selected.map(encodeTargetSegment).join("+") : `payload-${payloadFingerprint(payload)}`;
}

export function classifyCodecksDispatchMutationV1(
  account: string,
  dispatchPath: string,
  payload: Record<string, unknown>,
): CodecksMutationTarget {
  const normalizedPath = dispatchPath.trim().replace(/^\/+|\/+$/g, "");
  const operation = normalizedPath.replaceAll("/", ".");
  return Object.freeze({
    action: "tracker_mutation" as const,
    target: `codecks:${encodeTargetSegment(account)}:${operation}:${dispatchEntityId(normalizedPath, payload)}`,
    classified: KNOWN_DISPATCH_PATHS.has(normalizedPath),
  });
}

export function codecksAttachmentMutationTargetV1(
  account: string,
  cardId: unknown,
  source: Readonly<{ canonicalPath: string; size: number; sha256: string }>,
): CodecksMutationTarget {
  // Fold the physical source identity and content digest into an opaque binding so
  // tokens distinguish same-named files without exposing the content SHA-256.
  const sourceBinding = createHash("sha256")
    .update(source.canonicalPath)
    .update("\0")
    .update(String(source.size))
    .update("\0")
    .update(source.sha256)
    .digest("base64url");
  return Object.freeze({
    action: "tracker_mutation" as const,
    target: `codecks:${encodeTargetSegment(account)}:cards.addFile:${encodeTargetSegment(cardId)}+source-${sourceBinding}`,
    classified: true,
    confirmationDetails: Object.freeze([
      `Canonical source: ${source.canonicalPath}`,
      `Source size: ${source.size} bytes`,
    ]),
  });
}

export class CodecksMutationAuthorizationError extends Error {
  readonly code: string;
  readonly action = "tracker_mutation" as const;
  readonly target: string;

  constructor(code: string, target: string) {
    super(`Codecks mutation blocked (${code}) for exact target '${target}'.`);
    this.name = "CodecksMutationAuthorizationError";
    this.code = code;
    this.target = target;
  }
}

/** Called only after the sink has finalized its account, operation, and stable entity target. */
export async function authorizeCodecksMutationSinkV1(
  context: CodecksMutationAuthorizationContext | undefined,
  mutation: CodecksMutationTarget,
): Promise<void> {
  if (context === undefined || context.sessionManager === null || typeof context.sessionManager !== "object") {
    throw new CodecksMutationAuthorizationError("authorization_context_required", mutation.target);
  }

  if (context.authorizationToken !== undefined) {
    if (!mutation.classified) throw new CodecksMutationAuthorizationError("mutation_method_unclassified_confirmation_required", mutation.target);
    const decision = consumeWorkflowAuthorizationTokenV1(
      context.sessionManager,
      context.authorizationToken,
      mutation.action,
      [mutation.target],
    );
    if (decision.outcome !== "accepted") throw decisionError(decision, mutation.target);
    (context.authorizationProvenance ??= []).push(Object.freeze({
      authoritySource: "authorization_token_consumed" as const,
      action: mutation.action,
      canonicalTargets: Object.freeze([mutation.target]),
      consumed: true as const,
    }));
    return;
  }

  const interactive = context.hasUI && (context.mode === "tui" || context.mode === "rpc") && typeof context.confirm === "function";
  if (!interactive) throw new CodecksMutationAuthorizationError("authorization_token_required", mutation.target);
  const confirmed = await context.confirm!(
    "Authorize Codecks tracker mutation?",
    [
      `Action: ${mutation.action}`,
      `Exact target: ${mutation.target}`,
      ...(mutation.confirmationDetails ?? []),
      "",
      "This confirmation authorizes one remote mutation attempt only.",
    ].join("\n"),
  );
  if (!confirmed) throw new CodecksMutationAuthorizationError("authorization_user_denied", mutation.target);
  const issued = issueWorkflowAuthorizationTokenV1(context.sessionManager, mutation.action, [mutation.target]);
  const consumed = consumeWorkflowAuthorizationTokenV1(context.sessionManager, issued.authorizationToken, mutation.action, [mutation.target]);
  if (consumed.outcome !== "accepted") throw decisionError(consumed, mutation.target);
  (context.authorizationProvenance ??= []).push(Object.freeze({
    authoritySource: "direct_user_confirmation" as const,
    action: mutation.action,
    canonicalTargets: Object.freeze([mutation.target]),
    consumed: true as const,
  }));
}

function decisionError(decision: Extract<WorkflowAuthorizationTokenDecisionV1, { outcome: "blocked" }>, target: string): CodecksMutationAuthorizationError {
  return new CodecksMutationAuthorizationError(decision.code, target);
}
