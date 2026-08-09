import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  CODECKS_READONLY_AUTH_ACCOUNT_ENV,
  CODECKS_READONLY_AUTH_EXIT,
  CODECKS_READONLY_AUTH_QUERY,
  CODECKS_READONLY_AUTH_TOKEN_ENV,
  CODECKS_READONLY_AUTH_URL,
  resolveCodecksReadonlyAuthClientExecutable,
  runCodecksReadonlyAuthCheck,
  validateCodecksAccountSlug,
} from "../src/codecks-readonly-auth-contract.ts";
import {
  runCodecksReadonlyAuthClient,
} from "../src/integrations/codecks-readonly-auth-client.mjs";

const sentinel = "inert-codecks-token-sentinel";
const success = JSON.stringify({ data: { _root: { loggedInUser: "user-1" } } });

const result = await runCodecksReadonlyAuthCheck({ account: "example-team", token: sentinel }, async (url, init) => {
  assert.equal(url, "https://api.codecks.io/");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["X-Account"], "example-team");
  assert.equal(init.headers["X-Auth-Token"], sentinel);
  assert.deepEqual(JSON.parse(init.body), { query: CODECKS_READONLY_AUTH_QUERY });
  return { status: 200, text: async () => success };
});
assert.deepEqual(result, { operation: "codecks-readonly-auth", category: "authenticated", exitCode: 0 });
assert.equal(JSON.stringify(result).includes(sentinel), false, "public results must not disclose the token");

for (const [status, category, exitCode] of [
  [401, "authentication-rejected", 10],
  [403, "authentication-rejected", 10],
  [500, "unavailable", 14],
] as const) {
  const observed = await runCodecksReadonlyAuthCheck({ account: "example-team", token: sentinel }, async () => ({
    status,
    text: async () => "adversarial body containing inert-codecks-token-sentinel",
  }));
  assert.deepEqual(observed, { operation: "codecks-readonly-auth", category, exitCode });
}

for (const body of [
  "not-json",
  JSON.stringify({ data: { _root: {} } }),
  JSON.stringify({ data: { _root: { loggedInUser: "" } } }),
  JSON.stringify({ data: { _root: { loggedInUser: { id: "   " } } } }),
  JSON.stringify({ data: { _root: { loggedInUser: 0 } } }),
  JSON.stringify({ data: { _root: { loggedInUser: { id: 0 } } } }),
  JSON.stringify({ data: { _root: { loggedInUser: { id: -1 } } } }),
  JSON.stringify({ data: { _root: { loggedInUser: { id: 1.5 } } } }),
  JSON.stringify({ errors: [{ message: "partial failure" }], data: { _root: { loggedInUser: "user-1" } } }),
]) {
  const observed = await runCodecksReadonlyAuthCheck({ account: "example-team", token: sentinel }, async () => ({ status: 200, text: async () => body }));
  assert.equal(observed.category, "malformed-response");
  assert.equal(observed.exitCode, CODECKS_READONLY_AUTH_EXIT.malformedResponse);
}

for (const identity of ["user-1", { id: "user-1" }, 1, { id: 1 }]) {
  const observed = await runCodecksReadonlyAuthCheck({ account: "example-team", token: sentinel }, async () => ({
    status: 200,
    text: async () => JSON.stringify({ errors: [], data: { _root: { loggedInUser: identity } } }),
  }));
  assert.equal(observed.category, "authenticated");
}

const oversized = await runCodecksReadonlyAuthCheck({ account: "example-team", token: sentinel }, async () => ({
  status: 200,
  text: async () => "x".repeat(8 * 1024 + 1),
}));
assert.equal(oversized.category, "response-too-large");
assert.equal(oversized.exitCode, CODECKS_READONLY_AUTH_EXIT.responseTooLarge);

for (const account of ["https://elsewhere.invalid", "example/team", "", "-example", "example_"]) {
  const observed = await runCodecksReadonlyAuthCheck({ account, token: sentinel }, async () => {
    throw new Error("invalid account must not reach transport");
  });
  assert.equal(observed.category, "invalid-configuration");
  assert.equal(observed.exitCode, CODECKS_READONLY_AUTH_EXIT.invalidConfiguration);
}
assert.equal(validateCodecksAccountSlug("example-team"), "example-team");
assert.throws(() => validateCodecksAccountSlug("https://api.codecks.io"));
assert.equal(resolveCodecksReadonlyAuthClientExecutable().replaceAll("\\", "/").endsWith("src/integrations/codecks-readonly-auth-client.mjs"), true);

const unavailable = await runCodecksReadonlyAuthCheck({ account: "example-team", token: sentinel }, async () => {
  throw new Error(`network ${sentinel}`);
});
assert.deepEqual(unavailable, { operation: "codecks-readonly-auth", category: "unavailable", exitCode: 14 });
assert.equal(JSON.stringify(unavailable).includes(sentinel), false);

assert.equal(CODECKS_READONLY_AUTH_TOKEN_ENV, "PI_CODECKS_READONLY_AUTH_TOKEN");
assert.equal(CODECKS_READONLY_AUTH_ACCOUNT_ENV, "PI_CODECKS_READONLY_AUTH_ACCOUNT");
assert.equal(CODECKS_READONLY_AUTH_URL, "https://api.codecks.io/");

for (const testCase of [
  { body: success, expected: 0 },
  { body: JSON.stringify({ data: { _root: { loggedInUser: { id: 1 } } } }), expected: 0 },
  { body: JSON.stringify({ errors: [{ message: "partial failure" }], data: { _root: { loggedInUser: "user-1" } } }), expected: 11 },
  { body: JSON.stringify({ data: { _root: { loggedInUser: "" } } }), expected: 11 },
  { body: JSON.stringify({ data: { _root: { loggedInUser: 0 } } }), expected: 11 },
  { body: "not-json", expected: 11 },
  { body: "x".repeat(8 * 1024 + 1), expected: 12 },
] as const) {
  const fake = createHttpsTransport(200, testCase.body);
  const exitCode = await runCodecksReadonlyAuthClient({
    environment: { [CODECKS_READONLY_AUTH_ACCOUNT_ENV]: "example-team", [CODECKS_READONLY_AUTH_TOKEN_ENV]: sentinel },
    transport: fake.transport,
  });
  assert.equal(exitCode, testCase.expected, `shipped child exit for ${testCase.expected}`);
  assert.equal(fake.url, CODECKS_READONLY_AUTH_URL);
  assert.equal(fake.options?.method, "POST");
  assert.equal(fake.options?.headers["Content-Type"], "application/json");
  assert.equal(fake.options?.headers["X-Account"], "example-team");
  assert.equal(fake.options?.headers["X-Auth-Token"], sentinel);
  assert.deepEqual(JSON.parse(fake.body ?? ""), { query: CODECKS_READONLY_AUTH_QUERY });
  if (testCase.expected === 12) assert.equal(fake.destroyed, true, "oversized child response must terminate its request");
}

for (const status of [401, 403, 500]) {
  const exitCode = await runCodecksReadonlyAuthClient({
    environment: { [CODECKS_READONLY_AUTH_ACCOUNT_ENV]: "example-team", [CODECKS_READONLY_AUTH_TOKEN_ENV]: sentinel },
    transport: createHttpsTransport(status, success).transport,
  });
  assert.equal(exitCode, status < 500 ? CODECKS_READONLY_AUTH_EXIT.authenticationRejected : CODECKS_READONLY_AUTH_EXIT.unavailable);
}

const cli = spawnSync(process.execPath, [resolveCodecksReadonlyAuthClientExecutable(), "--ignored"], {
  encoding: "utf8",
  env: {},
});
assert.equal(cli.status, CODECKS_READONLY_AUTH_EXIT.invalidConfiguration);
assert.equal(cli.stdout, "", "the command-line child must not emit stdout");
assert.equal(cli.stderr, "", "the command-line child must not emit stderr");

const invalidChildTransport = createHttpsTransport(200, success);
assert.equal(await runCodecksReadonlyAuthClient({
  environment: { [CODECKS_READONLY_AUTH_ACCOUNT_ENV]: "https://elsewhere.invalid", [CODECKS_READONLY_AUTH_TOKEN_ENV]: sentinel },
  transport: invalidChildTransport.transport,
}), CODECKS_READONLY_AUTH_EXIT.invalidConfiguration);
assert.equal(invalidChildTransport.calls, 0, "invalid child configuration must not open a request");

console.log("codecks readonly auth contract test passed");

function createHttpsTransport(statusCode: number, body: string): {
  transport: { request: (url: string, options: { method: string; headers: Record<string, string> }, callback: (response: EventEmitter & { statusCode: number; resume(): void }) => void) => EventEmitter & { end(body: string): void; destroy(): void } };
  calls: number;
  url?: string;
  options?: { method: string; headers: Record<string, string> };
  body?: string;
  destroyed: boolean;
} {
  const state = { calls: 0, url: undefined as string | undefined, options: undefined as { method: string; headers: Record<string, string> } | undefined, body: undefined as string | undefined, destroyed: false };
  return {
    get calls() { return state.calls; },
    get url() { return state.url; },
    get options() { return state.options; },
    get body() { return state.body; },
    get destroyed() { return state.destroyed; },
    transport: {
      request(url, options, callback) {
        state.calls += 1;
        state.url = url;
        state.options = options;
        const request = new EventEmitter() as EventEmitter & { end(body: string): void; destroy(): void };
        request.destroy = () => { state.destroyed = true; };
        request.end = (requestBody) => {
          state.body = requestBody;
          queueMicrotask(() => {
            const response = new EventEmitter() as EventEmitter & { statusCode: number; resume(): void };
            response.statusCode = statusCode;
            response.resume = () => undefined;
            callback(response);
            if (statusCode >= 200 && statusCode < 300) {
              response.emit("data", Buffer.from(body));
              response.emit("end");
            }
          });
        };
        return request;
      },
    },
  };
}
