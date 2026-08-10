import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runExternalProviderLiveValidation } from "../scripts/validate-external-provider-live.ts";

const originalEnvironment = new Map(
  Object.entries(process.env).filter(([key]) => /^(?:CODECKS|PI_CODECKS)_/i.test(key)),
);
const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-codecks-live-validation-"));
const helperCounterPath = path.join(temporaryDirectory, "helper-calls");

const clearCredentialEnvironment = (): void => {
  for (const key of Object.keys(process.env)) {
    if (/^(?:CODECKS|PI_CODECKS)_/i.test(key)) delete process.env[key];
  }
};

const configureAmbientCredentialFixture = (): void => {
  clearCredentialEnvironment();
  process.env.CODECKS_ACCOUNT = "live-check-account";
  process.env.CODECKS_TOKEN = "ambient-token-that-must-not-be-used";
  process.env.CODECKS_CREDENTIAL_HELPER_MODULE = path.resolve("tests/fixtures/codecks-external-helper.mjs");
  process.env.PI_CODECKS_HELPER_COUNTER_PATH = helperCounterPath;
};

const assertFailsClosedBeforeHelperOrFetch = async (configuration: {
  provider?: string;
  acknowledgement?: string;
}): Promise<void> => {
  configureAmbientCredentialFixture();
  if (configuration.provider !== undefined) process.env.CODECKS_CREDENTIAL_PROVIDER = configuration.provider;
  if (configuration.acknowledgement !== undefined) process.env.PI_CODECKS_ALLOW_LIVE_VALIDATION = configuration.acknowledgement;

  let fetchCalls = 0;
  const lines: string[] = [];
  const result = await runExternalProviderLiveValidation({
    fetchImplementation: (async () => {
      fetchCalls += 1;
      throw new Error("fetch must not be called without explicit live authorization");
    }) as typeof fetch,
    write: (line) => lines.push(line),
  });

  assert.equal(fetchCalls, 0, "unauthorized launcher configuration must not invoke fetch");
  assert.equal(existsSync(helperCounterPath), false, "unauthorized launcher configuration must not invoke the helper");
  assert.deepEqual(result, { status: "not_authenticated", category: "invalid_configuration", durationMs: result.durationMs });
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), result);
};

try {
  // Ambient tokens must not activate the launcher for any missing or wrong authorization value.
  await assertFailsClosedBeforeHelperOrFetch({ acknowledgement: "1" });
  await assertFailsClosedBeforeHelperOrFetch({ provider: "environment", acknowledgement: "1" });
  await assertFailsClosedBeforeHelperOrFetch({ provider: "external-helper" });
  await assertFailsClosedBeforeHelperOrFetch({ provider: "external-helper", acknowledgement: "true" });

  configureAmbientCredentialFixture();
  process.env.CODECKS_CREDENTIAL_PROVIDER = "external-helper";
  process.env.PI_CODECKS_ALLOW_LIVE_VALIDATION = "1";

  const lines: string[] = [];
  let calls = 0;
  const authenticated = await runExternalProviderLiveValidation({
    fetchImplementation: (async (input, init) => {
      calls += 1;
      assert.equal(input, "https://api.codecks.io/");
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>)["X-Account"], "live-check-account");
      assert.equal((init?.headers as Record<string, string>)["X-Auth-Token"], "inert-helper-token");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        query: { _root: [{ loggedInUser: ["id", "name", "fullName"] }] },
      });
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: { id: "user-1" } } } }), { status: 200 });
    }) as typeof fetch,
    write: (line) => lines.push(line),
  });
  assert.equal(calls, 1, "authorized launcher makes one exact-read request through injected fetch");
  assert.deepEqual(authenticated, { status: "authenticated", category: "authenticated", durationMs: authenticated.durationMs });
  assert.equal(lines.length, 1, "live launcher emits exactly one line");
  assert.deepEqual(JSON.parse(lines[0]), authenticated);
  assert.doesNotMatch(lines[0], /live-check-account|inert-helper-token|ambient-token-that-must-not-be-used|codecks-external-helper|X-Auth-Token/i);

  const rejectedLines: string[] = [];
  const rejected = await runExternalProviderLiveValidation({
    fetchImplementation: (async () => new Response("vendor body and inert-helper-token", { status: 401, statusText: "Unauthorized" })) as typeof fetch,
    write: (line) => rejectedLines.push(line),
  });
  assert.deepEqual(rejected, { status: "not_authenticated", category: "authentication_rejected", durationMs: rejected.durationMs });
  assert.equal(rejectedLines.length, 1);
  assert.doesNotMatch(rejectedLines[0], /vendor body|inert-helper-token|Unauthorized/i);

  const safeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:CODECKS|PI_CODECKS)_/i.test(key)),
  );
  const cli = spawnSync(process.execPath, [
    path.resolve("node_modules/tsx/dist/cli.mjs"),
    path.resolve("scripts/validate-external-provider-live.ts"),
  ], {
    encoding: "utf8",
    env: safeEnvironment,
  });
  assert.equal(cli.status, 1, "only an authenticated live check exits successfully");
  assert.equal(cli.stderr, "", "the CLI must suppress diagnostics");
  const outputLines = cli.stdout.trim().split("\n");
  assert.equal(outputLines.length, 1, "the CLI emits exactly one JSON line");
  assert.deepEqual(JSON.parse(outputLines[0]), {
    status: "not_authenticated",
    category: "invalid_configuration",
    durationMs: JSON.parse(outputLines[0]).durationMs,
  });

  console.log("external-provider live validation launcher tests passed");
} finally {
  clearCredentialEnvironment();
  for (const [key, value] of originalEnvironment) process.env[key] = value;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
