import type { CodecksOperationPayload } from "../../pi/tool-definition";
import { getOperationContext } from "../../runtime/operation-context";
import { CodecksOperationError } from "../../runtime/operation-error";
import { runDispatch } from "../../runtime/transport";
import { toStructuredResult, toStructuredErrorResult, sanitizeValue } from "../../shared/results";
import type { CodecksEntity } from "../../shared/types";

export interface ConversationArguments {
  cardId?: string | number; resolvableId?: string | number; entryId?: string | number;
  context?: "comment" | "review" | "block" | "blocker"; content?: string;
  expectedVersion?: number; contexts?: string[]; includeClosed?: boolean; limit?: number;
  scanLimit?: number; staleAfterHours?: number; format?: "text" | "json";
}
export const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const pick = (value: unknown, fields: string[]): Record<string, unknown> => {
  const source = record(value); const output: Record<string, unknown> = {};
  for (const field of fields) if (source && source[field] !== undefined) output[field] = source[field];
  return output;
};
/** Allowlisted pre-presentation observations: no absent/null/falsy defaulting. */
export const observeCard = (value: unknown) => pick(value, ["cardId", "accountSeq", "title", "status", "derivedStatus"]);
export const observeThread = (value: unknown) => pick(value, ["id", "context", "createdAt", "isClosed", "closedAt"]);
export const observeActor = (value: unknown): unknown => value === null ? null : record(value) ? pick(value, ["id", "name", "fullName"]) : value === undefined ? undefined : { id: value };
export const observeEntry = (value: unknown, users: Record<string, CodecksEntity> = {}) => {
  const entry = pick(value, ["entryId", "content", "version", "createdAt", "lastChangedAt"]);
  const source = record(value);
  if (source && source.author !== undefined) entry.author = observeActor(typeof source.author === "string" ? users[source.author] ?? source.author : source.author);
  return entry;
};
export function relationReferenceCount(entity: unknown, relation: string): number | undefined {
  const source = record(entity);
  const key = source && Object.keys(source).find(key => key === relation || key.startsWith(`${relation}(`));
  return key && Array.isArray(source[key]) ? (source[key] as unknown[]).length : undefined;
}
/** Relation resolution can be incomplete even when an HTTP request returned. */
export function relationEvidence(entity: unknown, relation: string, map: Record<string, CodecksEntity>): boolean {
  const source = record(entity);
  if (!source) return false;
  const key = Object.keys(source).find(key => key === relation || key.startsWith(`${relation}(`));
  if (!key || !Array.isArray(source[key])) return false;
  return (source[key] as unknown[]).every(value => !!record(value) || (typeof value === "string" || typeof value === "number") && !!map[String(value)]);
}

export function createConversationReadResult(action: string) {
  const facts: Record<string, unknown> = {};
  let read: "complete" | "incomplete" | "unknown" = "unknown";
  const success: typeofReadSuccess = (...args) => ({ text: toStructuredResult(...args), payload: { schemaVersion: 1, action, ok: true, facts, read } });
  const failure: typeofReadFailure = (...args) => ({ text: toStructuredErrorResult(...args), payload: { schemaVersion: 1, action, ok: false, error: { code: args[2], message: sanitizeValue(args[3]) }, facts, read } });
  return { facts, success, failure, setRead(value: typeof read) { read = value; } };
}
type typeofReadSuccess = (...args: Parameters<typeof toStructuredResult>) => CodecksOperationPayload;
type typeofReadFailure = (...args: Parameters<typeof toStructuredErrorResult>) => CodecksOperationPayload;
export type ConversationEffect = "not_dispatched" | "definitely_rejected" | "dispatch_returned" | "indeterminate";

/** Observes the canonical dispatch, without adding transport, retry, scope or readback. */
export function createConversationWriteResult(action: string) {
  const facts: Record<string, unknown> = {};
  let effect: ConversationEffect = "not_dispatched";
  const envelope = () => ({ schemaVersion: 1, action, facts, effect, replayPermitted: false });
  const success: typeofReadSuccess = (...args) => ({ text: toStructuredResult(...args), payload: { ...envelope(), ok: true } });
  const failure: typeofReadFailure = (...args) => ({ text: toStructuredErrorResult(...args), payload: { ...envelope(), ok: false, error: { code: args[2], message: sanitizeValue(args[3]) } } });
  const dispatch: typeof runDispatch = async (path, body, actor, handTarget) => {
    // These are native request facts, not acknowledgment/readback claims.
    for (const key of ["cardId", "resolvableId", "entryId"]) if (body[key] !== undefined) facts[key] = body[key];
    if (body.id !== undefined) facts.resolvableId = body.id;
    if (body.context !== undefined) facts.context = body.context;
    const actorId = body.userId ?? body.authorId ?? body.closedBy ?? actor;
    if (actorId !== undefined) facts.actorId = actorId;
    const dispatchedBefore = getOperationContext()?.requestsDispatched;
    try {
      const result = await runDispatch(path, body, actor, handTarget);
      effect = "dispatch_returned";
      return result;
    } catch (error) {
      const dispatchedAfter = getOperationContext()?.requestsDispatched;
      const certainty = error instanceof CodecksOperationError ? error.details.mutationCertainty : undefined;
      effect = certainty === "definitely_rejected" ? "definitely_rejected" : certainty === "indeterminate" ? "indeterminate" : dispatchedBefore !== undefined && dispatchedAfter === dispatchedBefore ? "not_dispatched" : "indeterminate";
      throw error;
    }
  };
  return { facts, success, failure, dispatch };
}
