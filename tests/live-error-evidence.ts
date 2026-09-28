type ErrorEvidence = Record<string, unknown>;

/** Allow-list for locally authorized live scripts; never forward raw API responses or diagnostics. */
export function formatLiveErrorEvidence(value: unknown): string {
  const error: ErrorEvidence = value && typeof value === "object" && !Array.isArray(value) ? value as ErrorEvidence : {};
  const code = (candidate: unknown): string | undefined => typeof candidate === "string" && /^[a-z_]{1,80}$/i.test(candidate)
    && !/^cdx(?:at|ut)_/i.test(candidate) ? candidate : undefined;
  const safePath = typeof error.apiPath === "string" && /^[a-z_][a-z0-9_.\[\]-]{0,159}$/i.test(error.apiPath)
    && !/cdx(?:at|ut)_/i.test(error.apiPath) ? error.apiPath : undefined;
  const safeText = (candidate: unknown): candidate is string => typeof candidate === "string" && candidate.length <= 240
    && /^[\p{L}\p{N} _'".,:;()\[\]$!?/+-]+$/u.test(candidate)
    && !/(?:authorization|cookie|x-auth-token|x-api-key|credential|password|secret|token)\s*[:=]|cdx(?:at|ut)_|op:\/\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(candidate);
  const message = safeText(error.validationMessage) ? error.validationMessage : undefined;
  const details = Array.isArray(error.validationDetails) ? error.validationDetails.slice(0, 3).filter(safeText) : [];
  const shape = Array.isArray(error.errorShape) ? error.errorShape.slice(0, 20).flatMap((entry: unknown) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || !/^\$(?:\.[a-z_$][a-z0-9_$-]{0,39}|\[\]){0,4}$/i.test(item.path)
      || !["string", "number", "boolean", "object", "array", "null", "undefined"].includes(String(item.type))) return [];
    return [{ path: item.path, type: item.type, ...(typeof item.count === "number" && Number.isInteger(item.count) && item.count >= 0 && item.count <= 100 ? { count: item.count } : {}) }];
  }) : [];
  return JSON.stringify({
    category: code(error.category) ?? "unknown",
    ...(code(error.apiCode) ? { apiCode: code(error.apiCode) } : {}),
    ...(typeof error.httpStatus === "number" && Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}),
    ...(safePath ? { apiPath: safePath } : {}),
    ...(typeof error.requiredScope === "string" && /^[a-z0-9:_-]{1,100}$/i.test(error.requiredScope) && !/cdx(?:at|ut)_/i.test(error.requiredScope) ? { requiredScope: error.requiredScope } : {}),
    ...(message ? { validationMessage: message } : {}),
    ...(details.length ? { validationDetails: details } : {}),
    ...(shape.length ? { errorShape: shape } : {}),
    ...(error.dispatchAttempt === "http_response" || error.dispatchAttempt === "outcome_unknown" ? { dispatchAttempt: error.dispatchAttempt } : {}),
    ...(error.mutationCertainty === "definitely_rejected" || error.mutationCertainty === "indeterminate" ? { mutationCertainty: error.mutationCertainty } : {}),
    ...(typeof error.requestsAttempted === "number" && Number.isInteger(error.requestsAttempted) && error.requestsAttempted >= 0 && error.requestsAttempted <= 100 ? { requestsAttempted: error.requestsAttempted } : {}),
  });
}
