import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as core from "../src/codecks-core.ts";
import { __externalHelperTest, resolveExternalHelperCredential } from "../src/codecks-external-helper.ts";

const fixture = path.resolve("tests/fixtures/codecks-external-helper.mjs");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "pi-codecks-external-helper-"));
const capturePath = path.join(tempRoot, "capture.json");
const counterPath = path.join(tempRoot, "counter.txt");
const sentinel = "inert-helper-token";
const ENV_KEYS = [
  "CODECKS_ACCOUNT", "CODECKS_TOKEN", "CODECKS_PROFILE", "CODECKS_PROFILE_ALPHA_PROD_ACCOUNT",
  "CODECKS_PROFILE_ALPHA_PROD_TOKEN", "CODECKS_PROFILE_ALPHA_PROD_API_TOKEN", "CODECKS_PROFILE_ALPHA_PROD_TOKEN_REF", "CODECKS_PROFILE_ALPHA_PROD_TOKEN_OP_REF",
  "CODECKS_TOKEN_REF", "CODECKS_TOKEN_OP_REF", "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_CREDENTIAL_HELPER_MODULE", "PI_CODECKS_HELPER_MODE",
  "PI_CODECKS_HELPER_CAPTURE_PATH", "PI_CODECKS_HELPER_COUNTER_PATH", "PI_CODECKS_HELPER_MANAGER_SETTING",
] as const;
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

const clearEnvironment = (): void => {
  for (const key of ENV_KEYS) delete process.env[key];
};
const expectFailure = async (operation: Promise<unknown>, message: string): Promise<void> => {
  await assert.rejects(operation, { message });
};

try {
  clearEnvironment();
  process.env.CODECKS_ACCOUNT = "helper-account";
  process.env.CODECKS_TOKEN = "ambient-token-must-not-reach-helper";
  process.env.CODECKS_PROFILE = "alpha-prod";
  process.env.CODECKS_PROFILE_ALPHA_PROD_ACCOUNT = "profile-helper-account";
  process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN = "profile-token-must-not-reach-helper";
  process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN_REF = "reference-must-not-reach-helper";
  process.env.CODECKS_PROFILE_ALPHA_PROD_API_TOKEN = "profile-api-token-must-not-reach-helper";
  process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN_OP_REF = "profile-operation-reference-must-not-reach-helper";
  process.env.CODECKS_TOKEN_REF = "global-reference-must-not-reach-helper";
  process.env.CODECKS_TOKEN_OP_REF = "global-operation-reference-must-not-reach-helper";
  process.env.CODECKS_CREDENTIAL_PROVIDER = "external-helper";
  process.env.CODECKS_CREDENTIAL_HELPER_MODULE = fixture;
  process.env.PI_CODECKS_HELPER_CAPTURE_PATH = capturePath;
  process.env.PI_CODECKS_HELPER_COUNTER_PATH = counterPath;
  process.env.PI_CODECKS_HELPER_MANAGER_SETTING = "inert-manager-setting";

  let fetchCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    fetchCalls += 1;
    assert.equal((init?.headers as Record<string, string>)["X-Account"], "profile-helper-account");
    assert.equal((init?.headers as Record<string, string>)["X-Auth-Token"], sentinel);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
  assert.equal(fetchCalls, 1, "normal Codecks requests accept a helper credential");
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  assert.equal(capture.requestText, JSON.stringify({ version: 1, service: "codecks", account: "profile-helper-account", profile: "alpha-prod" }));
  assert.equal(capture.extraArgCount, 0, "helper receives only its module argv");
  assert.deepEqual(capture.codecksCredentialKeys, [], "direct/global/profile credentials and selectors do not reach the helper");
  assert.deepEqual(__externalHelperTest.sanitizeHelperEnvironment({
    cOdEcKs_ToKeN: "mixed-direct",
    CoDeCkS_ApI_ToKeN: "mixed-api",
    CODECKS_token_ref: "mixed-reference",
    codecks_TOKEN_OP_REF: "mixed-operation-reference",
    cOdEcKs_PrOfIlE_AlPhA_ToKeN: "mixed-profile",
    CODECKS_profile_alpha_API_TOKEN: "mixed-profile-api",
    codecks_PROFILE_ALPHA_token_ref: "mixed-profile-reference",
    CoDeCkS_pRoFiLe_AlPhA_Token_Op_ReF: "mixed-profile-operation-reference",
    codecks_credential_provider: "external-helper",
    CODECKS_credential_helper_module: "/private/helper.mjs",
    CoDeCkS_PrOfIlE: "alpha",
    KEEP_ME: "inert",
  }), { KEEP_ME: "inert" }, "sanitization normalizes inherited key casing before matching");
  assert.equal(capture.managerSetting, "inert-manager-setting", "non-Codecks manager settings remain available");
  const helperResolutions = (): number => readFileSync(counterPath, "utf8").trim().split("\n").filter(Boolean).length;
  assert.equal(helperResolutions(), 1);
  await core.runWithAbortSignal(undefined, async () => {
    await Promise.all([
      core.query.execute({ query: { _root: [] } }),
      core.query.execute({ query: { _root: [] } }),
    ]);
  });
  assert.equal(helperResolutions(), 2, "concurrent requests in one operation share one helper resolution");
  await Promise.all([
    core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } })),
    core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } })),
  ]);
  assert.equal(helperResolutions(), 4, "distinct operations resolve independently");

  for (const mode of ["malformed", "extra", "wrong-version", "empty", "oversized"] as const) {
    process.env.PI_CODECKS_HELPER_MODE = mode;
    await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper returned an invalid response.");
  }
  process.env.PI_CODECKS_HELPER_MODE = "stderr";
  assert.deepEqual(await core.__test.resolveAuthenticatedConfig(), {
    account: "profile-helper-account", baseUrl: "https://api.codecks.io", token: sentinel,
  }, "helper stderr is ignored on success");
  process.env.PI_CODECKS_HELPER_MODE = "stderr-oversized";
  await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper is unavailable.");
  process.env.PI_CODECKS_HELPER_MODE = "nonzero";
  await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper is unavailable.");
  process.env.PI_CODECKS_HELPER_MODE = "close";
  await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper returned an invalid response.");

  // An explicitly selected helper is authoritative: even ambient direct/profile tokens cannot rescue it.
  process.env.CODECKS_CREDENTIAL_HELPER_MODULE = path.join(tempRoot, "missing.mjs");
  await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper configuration is invalid.");
  process.env.CODECKS_CREDENTIAL_HELPER_MODULE = "tests/fixtures/codecks-external-helper.mjs";
  await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper configuration is invalid.");
  process.env.CODECKS_CREDENTIAL_HELPER_MODULE = path.resolve("tests/fixtures/not-a-helper.txt");
  await expectFailure(core.__test.resolveAuthenticatedConfig(), "External Codecks credential helper configuration is invalid.");
  process.env.CODECKS_CREDENTIAL_HELPER_MODULE = fixture;

  process.env.PI_CODECKS_HELPER_MODE = "timeout";
  await expectFailure(resolveExternalHelperCredential({ account: "helper-account", signal: new AbortController().signal }, { modulePath: fixture, timeoutMs: 25 }), "External Codecks credential helper timed out.");
  const abortController = new AbortController();
  const cancelling = resolveExternalHelperCredential({ account: "helper-account", signal: abortController.signal }, { modulePath: fixture, timeoutMs: 5_000 });
  setTimeout(() => abortController.abort(), 10);
  await expectFailure(cancelling, "External Codecks credential helper cancelled.");

  const fakeChild = (behavior: "spawn" | "write" | "premature") => {
    const child = new EventEmitter() as any;
    child.pid = 0;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => true;
    child.stdin.end = (_input: string, callback?: (error?: Error | null) => void) => {
      queueMicrotask(() => {
        if (behavior === "write") {
          child.stdin.emit("error", new Error(`write ${sentinel}`));
          callback?.(new Error(`write ${sentinel}`));
        } else {
          callback?.(null);
          if (behavior === "premature") child.emit("close", 0, null);
        }
      });
    };
    return child;
  };
  const fakeRequest = { account: "fake-account", signal: new AbortController().signal };
  await expectFailure(resolveExternalHelperCredential(fakeRequest, {
    modulePath: fixture,
    validateModule: async () => undefined,
    spawnProcess: () => { throw new Error(`spawn ${sentinel}`); },
  }), "External Codecks credential helper is unavailable.");
  await expectFailure(resolveExternalHelperCredential(fakeRequest, {
    modulePath: fixture,
    validateModule: async () => undefined,
    spawnProcess: () => fakeChild("write"),
  }), "External Codecks credential helper is unavailable.");
  await expectFailure(resolveExternalHelperCredential(fakeRequest, {
    modulePath: fixture,
    validateModule: async () => undefined,
    spawnProcess: () => fakeChild("premature"),
  }), "External Codecks credential helper returned an invalid response.");

  const hostileChild = () => {
    const child = new EventEmitter() as any;
    child.pid = 0;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = () => true;
    child.stdin.end = (_input: string, callback?: (error?: Error | null) => void) => queueMicrotask(() => callback?.(null));
    return child;
  };
  const hostileRequest = () => ({ account: "hostile-account", signal: new AbortController().signal });
  for (const streamName of ["stdin", "stdout", "stderr"] as const) {
    const child = hostileChild();
    const pending = resolveExternalHelperCredential(hostileRequest(), {
      modulePath: fixture,
      validateModule: async () => undefined,
      spawnProcess: () => child,
    });
    queueMicrotask(() => child[streamName].emit("error", new Error(`${streamName} ${sentinel}`)));
    await expectFailure(pending, "External Codecks credential helper is unavailable.");
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      assert.doesNotThrow(() => stream.emit("error", new Error(`late ${sentinel}`)), "late stream errors remain consumed");
    }
  }

  const spawnAbortController = new AbortController();
  const abortDuringSpawnChild = hostileChild();
  let writesAfterSpawnAbort = 0;
  abortDuringSpawnChild.stdin.end = () => { writesAfterSpawnAbort += 1; };
  await expectFailure(resolveExternalHelperCredential({ account: "abort-during-spawn", signal: spawnAbortController.signal }, {
    modulePath: fixture,
    validateModule: async () => undefined,
    spawnProcess: () => { spawnAbortController.abort(); return abortDuringSpawnChild; },
  }), "External Codecks credential helper cancelled.");
  assert.equal(writesAfterSpawnAbort, 0, "an abort raised during spawn prevents the stdin write");

  const reentrantAbortController = new AbortController();
  const reentrantChild = hostileChild();
  let killCount = 0;
  reentrantChild.kill = () => {
    killCount += 1;
    reentrantChild.emit("close", 0, null);
    reentrantChild.emit("error", new Error(`reentrant child ${sentinel}`));
    reentrantChild.stdout.emit("error", new Error(`reentrant stdout ${sentinel}`));
    return true;
  };
  const reentrantPending = resolveExternalHelperCredential({ account: "reentrant", signal: reentrantAbortController.signal }, {
    modulePath: fixture,
    validateModule: async () => undefined,
    spawnProcess: () => reentrantChild,
  });
  queueMicrotask(() => reentrantAbortController.abort());
  await expectFailure(reentrantPending, "External Codecks credential helper cancelled.");
  assert.equal(killCount, 1, "reentrant close/error during kill cannot cause a second termination or settlement");
  assert.doesNotThrow(() => reentrantChild.stderr.emit("error", new Error(`late stderr ${sentinel}`)));

  const terminationChild = hostileChild();
  terminationChild.pid = 42;
  const groupSignals: string[] = [];
  let scheduledForce: (() => void) | undefined;
  let cancelledForce = 0;
  __externalHelperTest.terminateProcessTree(terminationChild, {
    platform: "linux",
    killProcess: (pid: number, signal: NodeJS.Signals) => { groupSignals.push(`${pid}:${signal}`); return true; },
    schedule: (callback) => { scheduledForce = callback; return {}; },
    cancelSchedule: () => { cancelledForce += 1; },
  });
  assert.deepEqual(groupSignals, ["-42:SIGTERM"]);
  terminationChild.emit("close", 0, null);
  assert.equal(cancelledForce, 1, "child close clears POSIX escalation without host OS behavior");
  assert.equal(scheduledForce === undefined, false);

  const closeDuringGroupKillChild = hostileChild();
  closeDuringGroupKillChild.pid = 45;
  let schedulesAfterSynchronousClose = 0;
  __externalHelperTest.terminateProcessTree(closeDuringGroupKillChild, {
    platform: "linux",
    killProcess: () => { closeDuringGroupKillChild.emit("close", 0, null); return true; },
    schedule: () => { schedulesAfterSynchronousClose += 1; return {}; },
  });
  assert.equal(schedulesAfterSynchronousClose, 0, "a synchronous group-kill close cannot leave an escalation timer behind");

  const windowsTerminationChild = hostileChild();
  windowsTerminationChild.pid = 43;
  let windowsDirectKills = 0;
  windowsTerminationChild.kill = () => { windowsDirectKills += 1; return true; };
  const taskkill = new EventEmitter() as any;
  taskkill.unref = () => undefined;
  __externalHelperTest.terminateProcessTree(windowsTerminationChild, {
    platform: "win32",
    spawnTaskkill: () => taskkill,
  });
  taskkill.emit("error", new Error("injected taskkill failure"));
  taskkill.emit("close", 1, null);
  assert.equal(windowsDirectKills, 2, "Windows taskkill error/nonzero paths safely use direct fallback");
  const taskkillThrowChild = hostileChild();
  taskkillThrowChild.pid = 46;
  let taskkillThrowDirectKills = 0;
  taskkillThrowChild.kill = () => { taskkillThrowDirectKills += 1; return true; };
  assert.doesNotThrow(() => __externalHelperTest.terminateProcessTree(taskkillThrowChild, {
    platform: "win32",
    spawnTaskkill: () => { throw new Error("injected taskkill spawn failure"); },
  }));
  assert.equal(taskkillThrowDirectKills, 1, "a throwing taskkill launcher cannot crash or strand termination");

  const throwingAbortController = new AbortController();
  const throwingTerminationChild = hostileChild();
  throwingTerminationChild.pid = 44;
  throwingTerminationChild.kill = () => { throw new Error("injected direct kill failure"); };
  const throwingTermination = resolveExternalHelperCredential({ account: "termination-failure", signal: throwingAbortController.signal }, {
    modulePath: fixture,
    validateModule: async () => undefined,
    spawnProcess: () => throwingTerminationChild,
    termination: { platform: "linux", killProcess: () => { throw new Error("injected group kill failure"); } },
  });
  queueMicrotask(() => throwingAbortController.abort());
  await expectFailure(throwingTermination, "External Codecks credential helper cancelled.");

  const publicEvidence = JSON.stringify({
    errors: ["External Codecks credential helper is unavailable."],
    capture: { extraArgCount: capture.extraArgCount },
  });
  for (const forbidden of [sentinel, "ambient-token-must-not-reach-helper", "reference-must-not-reach-helper", fixture, "profile-helper-account"]) {
    assert.equal(publicEvidence.includes(forbidden), false, `public evidence must not disclose ${forbidden}`);
  }
  console.log("Codecks external-helper credential tests passed");
} finally {
  globalThis.fetch = originalFetch;
  clearEnvironment();
  for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  rmSync(tempRoot, { recursive: true, force: true });
}
