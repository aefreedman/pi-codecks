import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../src/codecks-core.ts";
import { __onepasswordTest, resolveOnePasswordCredential } from "../src/codecks-onepassword.ts";

const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-codecks-onepassword-"));
const op = process.execPath;
const fakeOpScript = path.join(temporary, "run");
const originalCwd = process.cwd();
const keys = ["CODECKS_ACCOUNT", "CODECKS_TOKEN", "CODECKS_CREDENTIAL_PROVIDER", "PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE", "PI_CODECKS_ONEPASSWORD_REFERENCE", "OP_SERVICE_ACCOUNT_TOKEN", "CODECKS_ONEPASSWORD_REUSE_TTL_MS", "CODECKS_API_BASE"] as const;
const saved = new Map(keys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

writeFileSync(fakeOpScript, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = ["run", ...process.argv.slice(2)];
const [command, flag, delimiter, child, ...childArgs] = args;
if (command !== "run" || flag !== "--no-masking" || delimiter !== "--" || !child || process.env.OP_SERVICE_ACCOUNT_TOKEN !== "inert-service-token") process.exit(64);
const result = spawn(child, childArgs, { env: { ...process.env, PI_CODECKS_ONEPASSWORD_CREDENTIAL: "inert-onepassword-token" }, stdio: ["ignore", "pipe", "pipe"] });
const output = []; result.stdout.on("data", (chunk) => output.push(chunk)); result.stderr.pipe(process.stderr);
result.on("close", (status) => { const value = Buffer.concat(output).toString("utf8"); process.stdout.write(flag === "--no-masking" ? value : value.replaceAll("inert-onepassword-token", "[REDACTED]")); process.exit(status ?? 1); });
`);
chmodSync(fakeOpScript, 0o755);

const pathEntrySeparator = process.platform === "win32" ? ";" : ":";
const executableName = process.platform === "win32" ? "op.exe" : "op";
const startupFixture = path.join(temporary, "startup-path-resolution.mjs");
const onepasswordModule = pathToFileURL(path.resolve("src/codecks-onepassword.ts")).href;
const tsxLoader = pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href;
writeFileSync(startupFixture, `
import { renameSync } from "node:fs";
import { __onepasswordTest, resolveOnePasswordExecutable } from ${JSON.stringify(onepasswordModule)};
try {
  const first = resolveOnePasswordExecutable();
  if (process.env.PI_TEST_ACTION === "retention") renameSync(process.env.PI_TEST_CANDIDATE, process.env.PI_TEST_CANDIDATE + ".moved");
  const second = resolveOnePasswordExecutable();
  process.stdout.write(JSON.stringify({ ok: true, first, second }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }));
}
`);
const startupResolution = (startupPath: string, action?: string, candidate?: string, cwd = temporary): { ok: boolean; first?: string; second?: string; message?: string } => {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["PATH", "PATHEXT", "PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE"].includes(key.toUpperCase())));
  environment.PATH = startupPath;
  environment.PATHEXT = ".EXE";
  environment.PI_TEST_ACTION = action;
  environment.PI_TEST_CANDIDATE = candidate;
  const result = spawnSync(process.execPath, ["--import", tsxLoader, startupFixture], {
    cwd,
    env: environment,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `startup-PATH fixture failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as { ok: boolean; first?: string; second?: string; message?: string };
};
const writeCandidate = (directory: string): string => {
  const candidate = path.join(directory, executableName);
  writeFileSync(candidate, "inert executable candidate");
  chmodSync(candidate, 0o755);
  return candidate;
};

try {
  for (const key of keys) delete process.env[key];
  process.env.CODECKS_ACCOUNT = "inert-account";
  process.env.CODECKS_TOKEN = "ambient-token-must-not-be-used";
  process.env.CODECKS_CREDENTIAL_PROVIDER = "onepassword";
  process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE = op;
  process.env.PI_CODECKS_ONEPASSWORD_REFERENCE = "op://inert/vault/item";
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "inert-service-token";
  __onepasswordTest.resetExecutable();
  globalThis.fetch = (async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>)["X-Auth-Token"], "inert-onepassword-token");
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  process.chdir(temporary);
  const actualHelperResult = await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
  assert.doesNotMatch(String(actualHelperResult), /Error:/, "real bundled helper succeeds using the cross-platform fake op");
  process.chdir(originalCwd);
  let now = 1000;
  let resolutions = 0;
  process.env.CODECKS_ONEPASSWORD_REUSE_TTL_MS = "1000";
  __onepasswordTest.resetProcessLocalState();
  __onepasswordTest.setLifecycleDependenciesForTests({ now: () => now, resolve: async () => ({ token: `inert-${++resolutions}`, providerId: "onepassword" }) });
  const first = await resolveOnePasswordCredential({ account: "inert-account", signal: new AbortController().signal });
  const reused = await resolveOnePasswordCredential({ account: "inert-account", signal: new AbortController().signal });
  assert.equal(first.token, reused.token, "enabled reuse starts after successful resolution");
  assert.equal(resolutions, 1);
  now += 1000;
  await resolveOnePasswordCredential({ account: "inert-account", signal: new AbortController().signal });
  assert.equal(resolutions, 2, "expired reuse resolves afresh");
  process.env.CODECKS_ONEPASSWORD_REUSE_TTL_MS = "0";
  await resolveOnePasswordCredential({ account: "inert-account", signal: new AbortController().signal });
  assert.equal(resolutions, 3, "default/disabled reuse does not cache");
  __onepasswordTest.resetLifecycleDependenciesForTests();

  // Effective configuration isolation uses the actual provider, not seeded cache entries.
  let isolatedCalls = 0;
  process.env.CODECKS_ONEPASSWORD_REUSE_TTL_MS = "60000";
  __onepasswordTest.setLifecycleDependenciesForTests({ resolve: async () => {
    isolatedCalls++;
    return { token: "inert-isolated", providerId: "onepassword" };
  } });
  const request = { account: "fixture", profileKey: "alpha", baseUrl: "https://a.invalid", signal: new AbortController().signal };
  const isolated = await resolveOnePasswordCredential(request);
  assert.equal((await resolveOnePasswordCredential(request)).credentialGeneration, isolated.credentialGeneration);
  await resolveOnePasswordCredential({ ...request, account: "other" });
  await resolveOnePasswordCredential({ ...request, profileKey: "beta" });
  await resolveOnePasswordCredential({ ...request, baseUrl: "https://b.invalid" });
  process.env.PI_CODECKS_ONEPASSWORD_REFERENCE = "op://fixture/other/field";
  await resolveOnePasswordCredential(request);
  process.env["OP_SERVICE_ACCOUNT_TOKEN"] = "inert-rotated-service";
  await resolveOnePasswordCredential(request);
  const alternativeExecutable = path.join(temporary, "other-executable");
  writeFileSync(alternativeExecutable, "inert executable candidate"); chmodSync(alternativeExecutable, 0o755);
  process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE = alternativeExecutable;
  await resolveOnePasswordCredential(request);
  assert.equal(isolatedCalls, 7, "account, profile, effective API base, reference, service identity and executable cannot reuse incompatible credentials");
  assert.doesNotMatch(JSON.stringify(__onepasswordTest.getProcessLocalState()), /inert|fixture|op:\/\//);
  __onepasswordTest.resetLifecycleDependenciesForTests();

  // Real bundled helper + inert fake op: diagnostics cross only the private envelope.
  const limitedOp = process.execPath;
  const launches = path.join(temporary, "launches.txt");
  const sentinel = "PRIVATE_DIAGNOSTIC_SENTINEL";
  writeFileSync(fakeOpScript, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(launches)}, 'x');\nprocess.stderr.write(${JSON.stringify(sentinel + ' Too many requests. Your client has been rate-limited. ' + sentinel)});\nprocess.exitCode = 1;\n`);
  process.chdir(temporary);
  process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE = limitedOp;
  process.env.PI_CODECKS_ONEPASSWORD_REFERENCE = "op://fixture/item/field";
  now = 0;
  __onepasswordTest.setLifecycleDependenciesForTests({ now: () => now });
  const safeLimit = (error: unknown) => {
    assert.equal((error as { credentialCategory: string }).credentialCategory, "credential_rate_limited");
    assert.doesNotMatch(String(error) + JSON.stringify(error), /PRIVATE_DIAGNOSTIC_SENTINEL|fixture|inert-rotated|op:\/\//);
    return true;
  };
  await assert.rejects(resolveOnePasswordCredential(request), safeLimit);
  await assert.rejects(resolveOnePasswordCredential(request), safeLimit);
  const { readFileSync } = await import("node:fs");
  assert.equal(readFileSync(launches, "utf8"), "x", "cooldown suppresses a second real bundled-helper invocation");
  now = 60000;
  await assert.rejects(resolveOnePasswordCredential(request), safeLimit);
  assert.equal(readFileSync(launches, "utf8"), "xx", "expiry permits the next caller to resolve without automatic retry");
  for (const [diagnostic, exitCode] of [[sentinel + " rate 429 unavailable", 1], ["Too many requests. Your client has been rate-limited.", 0]] as const) {
    __onepasswordTest.resetProcessLocalState();
    writeFileSync(fakeOpScript, `process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = ${exitCode};`);
    await assert.rejects(resolveOnePasswordCredential(request), (error: unknown) => {
      assert.equal((error as { credentialCategory: string }).credentialCategory, "credential_helper_unavailable");
      assert.doesNotMatch(String(error), /PRIVATE_DIAGNOSTIC_SENTINEL|429/);
      return true;
    });
    assert.equal(__onepasswordTest.getProcessLocalState().cooldownEntries, 0, "unknown failure or zero-exit warning cannot create a cooldown");
  }
  process.chdir(originalCwd);
  __onepasswordTest.resetLifecycleDependenciesForTests();

  // The fake returns the token only when it observes the exact fixed invocation.
  const childSource = await (await import("node:fs/promises")).readFile(__onepasswordTest.childPath, "utf8");
  assert.match(childSource, /\["run", "--no-masking", "--", process\.execPath/);

  process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE = path.join(temporary, "missing-op");
  __onepasswordTest.resetExecutable();
  await assert.rejects(core.__test.resolveAuthenticatedConfig(), { message: __onepasswordTest.failure });
  assert.equal(__onepasswordTest.canonicalExecutable("op"), undefined, "relative overrides fail closed");
  assert.equal(__onepasswordTest.childPath.includes("codecks-onepassword-credential-helper.mjs"), true);

  // This subprocess imports the provider after PATH is set, proving it captures
  // only explicit startup entries rather than the parent cwd or later state.
  const explicitBin = path.join(temporary, "explicit-bin");
  const duplicateBin = path.join(temporary, "duplicate-bin");
  const invalidBin = path.join(temporary, "invalid-bin");
  const decoyCwd = path.join(temporary, "cwd-decoy");
  for (const directory of [explicitBin, duplicateBin, invalidBin, decoyCwd]) mkdirSync(directory);
  const explicitCandidate = writeCandidate(explicitBin);
  writeCandidate(duplicateBin);
  mkdirSync(path.join(invalidBin, executableName));
  writeCandidate(decoyCwd);
  const explicit = startupResolution(explicitBin, undefined, explicitCandidate);
  assert.deepEqual(explicit, { ok: true, first: path.resolve(explicitCandidate), second: path.resolve(explicitCandidate) }, "one explicit startup PATH candidate resolves canonically");
  assert.equal(startupResolution([explicitBin, duplicateBin].join(pathEntrySeparator)).ok, false, "multiple distinct PATH candidates fail closed");
  assert.equal(startupResolution(pathEntrySeparator, undefined, undefined, decoyCwd).ok, false, "empty PATH entry does not search a cwd decoy");
  assert.equal(startupResolution(invalidBin).ok, false, "non-file PATH candidate fails closed");
  const retained = startupResolution(explicitBin, "retention", explicitCandidate);
  assert.deepEqual(retained, { ok: true, first: path.resolve(explicitCandidate), second: path.resolve(explicitCandidate) }, "canonical executable path remains fixed after initial resolution");
  assert.equal(startupResolution(path.join(temporary, "missing-bin")).ok, false, "missing PATH candidate fails closed");
  console.log("Codecks built-in onepassword provider tests passed");
} finally {
  process.chdir(originalCwd);
  __onepasswordTest.resetLifecycleDependenciesForTests();
  __onepasswordTest.resetExecutable();
  globalThis.fetch = originalFetch;
  for (const key of keys) delete process.env[key];
  for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  rmSync(temporary, { recursive: true, force: true });
}
