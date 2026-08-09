import { fileURLToPath } from "node:url";

export const CODECKS_READONLY_AUTH_TOKEN_ENV = "PI_CODECKS_READONLY_AUTH_TOKEN";
export const CODECKS_READONLY_AUTH_ACCOUNT_ENV = "PI_CODECKS_READONLY_AUTH_ACCOUNT";
export const CODECKS_READONLY_AUTH_URL = "https://api.codecks.io/";
export const CODECKS_READONLY_AUTH_MAX_RESPONSE_BYTES = 8 * 1024;

/** Resolves the package-owned no-argument child beside this contract module. */
export function resolveCodecksReadonlyAuthClientExecutable(): string {
  return fileURLToPath(new URL("./integrations/codecks-readonly-auth-client.mjs", import.meta.url));
}

/**
 * This is the same minimal identity query used by fetchLoggedInUser() in the
 * main Codecks core. It deliberately has no caller-supplied fields or path.
 */
export const CODECKS_READONLY_AUTH_QUERY = Object.freeze({
  _root: [{ loggedInUser: ["id", "name", "fullName"] }],
});

export const CODECKS_READONLY_AUTH_EXIT = Object.freeze({
  authenticated: 0,
  authenticationRejected: 10,
  malformedResponse: 11,
  responseTooLarge: 12,
  invalidConfiguration: 13,
  unavailable: 14,
});

export type CodecksReadonlyAuthCategory =
  | "authenticated"
  | "authentication-rejected"
  | "malformed-response"
  | "response-too-large"
  | "invalid-configuration"
  | "unavailable";

export type CodecksReadonlyAuthResult = Readonly<{
  operation: "codecks-readonly-auth";
  category: CodecksReadonlyAuthCategory;
  exitCode: number;
}>;

export type CodecksReadonlyAuthTransportResponse = Readonly<{
  status: number;
  text(): Promise<string>;
}>;

export type CodecksReadonlyAuthTransport = (
  url: string,
  init: Readonly<{ method: "POST"; headers: Readonly<Record<string, string>>; body: string }>,
) => Promise<CodecksReadonlyAuthTransportResponse>;

/** Validates the Codecks account subdomain without treating it as a URL. */
export function validateCodecksAccountSlug(value: string): string {
  const account = value.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(account)) {
    throw new Error("Invalid Codecks account slug.");
  }
  return account;
}

/**
 * Executes exactly one official Codecks POST / identity query. The token only
 * reaches the fixed X-Auth-Token header; this result never includes it, the
 * account, URL, headers, or response body.
 */
export async function runCodecksReadonlyAuthCheck(
  input: Readonly<{ account: string; token: string | undefined }>,
  transport: CodecksReadonlyAuthTransport,
): Promise<CodecksReadonlyAuthResult> {
  let account: string;
  if (!input.token?.trim()) return result("invalid-configuration");
  try {
    account = validateCodecksAccountSlug(input.account);
  } catch {
    return result("invalid-configuration");
  }

  let response: CodecksReadonlyAuthTransportResponse;
  try {
    response = await transport(CODECKS_READONLY_AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Account": account,
        "X-Auth-Token": input.token,
      },
      body: JSON.stringify({ query: CODECKS_READONLY_AUTH_QUERY }),
    });
  } catch {
    return result("unavailable");
  }

  if (response.status === 401 || response.status === 403) return result("authentication-rejected");
  if (response.status < 200 || response.status >= 300) return result("unavailable");

  let body: string;
  try {
    body = await response.text();
  } catch {
    return result("unavailable");
  }
  if (Buffer.byteLength(body) > CODECKS_READONLY_AUTH_MAX_RESPONSE_BYTES) return result("response-too-large");

  try {
    return hasLoggedInUserIdentity(JSON.parse(body) as unknown)
      ? result("authenticated")
      : result("malformed-response");
  } catch {
    return result("malformed-response");
  }
}

function hasLoggedInUserIdentity(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const data = isRecord(payload.data) ? payload.data : payload;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) return false;
  const root = isRecord(data._root) ? data._root : undefined;
  return hasValidIdentity(root?.loggedInUser);
}

function hasValidIdentity(identity: unknown): boolean {
  if (typeof identity === "string") return identity.trim().length > 0;
  if (typeof identity === "number") return Number.isSafeInteger(identity) && identity > 0;
  return isRecord(identity) && hasValidIdentity(identity.id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function result(category: CodecksReadonlyAuthCategory): CodecksReadonlyAuthResult {
  const exitCode = category === "authenticated" ? CODECKS_READONLY_AUTH_EXIT.authenticated
    : category === "authentication-rejected" ? CODECKS_READONLY_AUTH_EXIT.authenticationRejected
    : category === "malformed-response" ? CODECKS_READONLY_AUTH_EXIT.malformedResponse
    : category === "response-too-large" ? CODECKS_READONLY_AUTH_EXIT.responseTooLarge
    : category === "invalid-configuration" ? CODECKS_READONLY_AUTH_EXIT.invalidConfiguration
    : CODECKS_READONLY_AUTH_EXIT.unavailable;
  return { operation: "codecks-readonly-auth", category, exitCode };
}
