#!/usr/bin/env node
import https from "node:https";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// This child implements the package-owned 1Password consumer protocol. Its
// command-line form has no operational arguments, URL, method, account-host,
// or credential-name selection surface.
export const CODECKS_READONLY_AUTH_TOKEN_ENV = "PI_CODECKS_READONLY_AUTH_TOKEN";
export const CODECKS_READONLY_AUTH_ACCOUNT_ENV = "PI_CODECKS_READONLY_AUTH_ACCOUNT";
export const CODECKS_READONLY_AUTH_URL = "https://api.codecks.io/";
export const CODECKS_READONLY_AUTH_MAX_RESPONSE_BYTES = 8 * 1024;
export const CODECKS_READONLY_AUTH_EXIT = Object.freeze({
  authenticated: 0,
  authenticationRejected: 10,
  malformedResponse: 11,
  responseTooLarge: 12,
  invalidConfiguration: 13,
  unavailable: 14,
});
export const CODECKS_READONLY_AUTH_QUERY = Object.freeze({
  _root: [{ loggedInUser: ["id", "name", "fullName"] }],
});

/**
 * Executes the fixed official identity request. `transport` is injectable only
 * for deterministic package tests; the command-line entry point always passes
 * node:https and has no caller-provided transport or request fields.
 */
export async function runCodecksReadonlyAuthClient({
  environment = process.env,
  transport = https,
} = {}) {
  const account = String(environment[CODECKS_READONLY_AUTH_ACCOUNT_ENV] ?? "").trim();
  const token = environment[CODECKS_READONLY_AUTH_TOKEN_ENV];
  if (!isValidAccount(account) || !token?.trim()) return CODECKS_READONLY_AUTH_EXIT.invalidConfiguration;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve(exitCode);
    };

    let request;
    try {
      request = transport.request(CODECKS_READONLY_AUTH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Account": account,
          "X-Auth-Token": token,
        },
      }, (response) => {
        if (response.statusCode === 401 || response.statusCode === 403) {
          safelyResume(response);
          finish(CODECKS_READONLY_AUTH_EXIT.authenticationRejected);
          return;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          safelyResume(response);
          finish(CODECKS_READONLY_AUTH_EXIT.unavailable);
          return;
        }

        let bytes = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
          bytes += buffer.length;
          if (bytes > CODECKS_READONLY_AUTH_MAX_RESPONSE_BYTES) {
            try { request.destroy(); } catch { /* request is already closed */ }
            finish(CODECKS_READONLY_AUTH_EXIT.responseTooLarge);
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", () => finish(CODECKS_READONLY_AUTH_EXIT.unavailable));
        response.once("end", () => {
          if (settled) return;
          try {
            const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            finish(hasLoggedInUserIdentity(payload)
              ? CODECKS_READONLY_AUTH_EXIT.authenticated
              : CODECKS_READONLY_AUTH_EXIT.malformedResponse);
          } catch {
            finish(CODECKS_READONLY_AUTH_EXIT.malformedResponse);
          }
        });
      });
      request.once("error", () => finish(CODECKS_READONLY_AUTH_EXIT.unavailable));
      request.end(JSON.stringify({ query: CODECKS_READONLY_AUTH_QUERY }));
    } catch {
      finish(CODECKS_READONLY_AUTH_EXIT.unavailable);
    }
  });
}

function isValidAccount(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value);
}

function hasLoggedInUserIdentity(payload) {
  if (!isRecord(payload) || hasNonemptyRootErrors(payload)) return false;
  const data = isRecord(payload.data) ? payload.data : payload;
  const root = isRecord(data._root) ? data._root : undefined;
  return isValidIdentity(root?.loggedInUser);
}

function hasNonemptyRootErrors(payload) {
  return Array.isArray(payload.errors) && payload.errors.length > 0;
}

function isValidIdentity(identity) {
  if (typeof identity === "string") return identity.trim().length > 0;
  if (typeof identity === "number") return Number.isSafeInteger(identity) && identity > 0;
  if (!isRecord(identity)) return false;
  return isValidIdentity(identity.id);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safelyResume(response) {
  try { response.resume(); } catch { /* already closed or test double */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void runCodecksReadonlyAuthClient().then((exitCode) => { process.exitCode = exitCode; });
}
