import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as core from "../src/codecks-core.ts";
import { __onepasswordTest } from "../src/codecks-onepassword.ts";

const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-codecks-onepassword-"));
const op = path.join(temporary, "op");
const keys = ["CODECKS_ACCOUNT", "CODECKS_TOKEN", "CODECKS_CREDENTIAL_PROVIDER", "PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE", "PI_CODECKS_ONEPASSWORD_REFERENCE", "OP_SERVICE_ACCOUNT_TOKEN"] as const;
const saved = new Map(keys.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

writeFileSync(op, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const [command, flag, delimiter, child, ...childArgs] = args;
if (command !== "run" || flag !== "--no-masking" || delimiter !== "--" || !child || process.env.OP_SERVICE_ACCOUNT_TOKEN !== "inert-service-token") process.exit(64);
const result = spawn(child, childArgs, { env: { ...process.env, PI_CODECKS_ONEPASSWORD_CREDENTIAL: "inert-onepassword-token" }, stdio: ["ignore", "pipe", "pipe"] });
const output = []; result.stdout.on("data", (chunk) => output.push(chunk)); result.stderr.pipe(process.stderr);
result.on("close", (status) => { const value = Buffer.concat(output).toString("utf8"); process.stdout.write(flag === "--no-masking" ? value : value.replaceAll("inert-onepassword-token", "[REDACTED]")); process.exit(status ?? 1); });
`);
chmodSync(op, 0o755);

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
  await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
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
  globalThis.fetch = originalFetch;
  for (const key of keys) delete process.env[key];
  for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  rmSync(temporary, { recursive: true, force: true });
}
