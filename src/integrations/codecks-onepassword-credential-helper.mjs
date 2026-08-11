#!/usr/bin/env node
/**
 * Neutral Codecks v1 credential-helper adapter. This file is intentionally not
 * a Pi extension: pi-codecks launches it directly with the current Node binary.
 */
import { spawn } from "node:child_process";
import { isAbsolute as isPosixAbsolute } from "node:path/posix";
import { isAbsolute as isWindowsAbsolute } from "node:path/win32";

const REQUEST_LIMIT_BYTES = 8 * 1024;
const STDOUT_LIMIT_BYTES = 8 * 1024;
const STDERR_LIMIT_BYTES = 8 * 1024;
const OUTPUT_LIMIT_BYTES = 12 * 1024;
const TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 250;
const REFERENCE_ENVIRONMENT_NAME = "PI_CODECKS_ONEPASSWORD_CREDENTIAL";
const OP_REFERENCE_PREFIX = "op:" + "//";

// This is deliberately a fixed current-Node program. It has no request-derived
// arguments and can only receive the resolved value through its fixed binding.
// `op run --no-masking` is required solely because this stdout is the private,
// bounded adapter protocol read by trusted pi-codecks. The credential never
// reaches argv, stderr, diagnostics, or any public/model-facing output.
const FIXED_CHILD_SOURCE = `
const credential = process.env.${REFERENCE_ENVIRONMENT_NAME};
if (typeof credential !== "string" || credential.length === 0) process.exit(1);
process.stdout.write(JSON.stringify({ version: 1, credential }));
`;

// This controller exists before stdin is observed, so every failure path has
// the same bounded teardown even when the protocol parent leaves stdin open.
const overall = createOverallAbortController();

void main().then(
  () => overall.succeed(),
  () => overall.abort(),
);

async function main() {
  const request = await readRequest(overall);
  validateRequest(request);
  overall.throwIfAborted();
  const configuration = readConfiguration();
  const output = await runOp(configuration, overall);
  const response = parseFixedChildResponse(output);
  await writeResponse(response, overall);
}

function createOverallAbortController() {
  let state = "active";
  const abortListeners = new Set();
  const streamErrorListeners = [];
  const signalListeners = [];
  const overallTimeout = setTimeout(() => abort(), TIMEOUT_MS);
  overallTimeout.unref();

  // Never let a hostile inherited stream turn into an uncaught diagnostic.
  for (const stream of [process.stdin, process.stdout, process.stderr]) {
    const listener = () => abort();
    stream.on("error", listener);
    streamErrorListeners.push([stream, listener]);
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const listener = () => abort();
    process.once(signal, listener);
    signalListeners.push([signal, listener]);
  }

  const releaseSuccessListeners = () => {
    clearTimeout(overallTimeout);
    for (const [stream, listener] of streamErrorListeners) stream.removeListener("error", listener);
    for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
  };

  function abort() {
    if (state !== "active") return;
    state = "aborted";
    process.exitCode = 1;
    clearTimeout(overallTimeout);
    for (const [signal, listener] of signalListeners) process.removeListener(signal, listener);
    for (const [stream, listener] of streamErrorListeners) {
      stream.removeListener("error", listener);
      // Destroying hostile inherited streams can itself report a late error.
      // Retain only an inert guard until the bounded process exit.
      stream.on("error", () => {});
    }
    try { process.stdin.pause(); } catch {}
    try { process.stdin.destroy(); } catch {}
    for (const listener of abortListeners) {
      try { listener(); } catch { /* each teardown is independently best effort */ }
    }
    abortListeners.clear();
    // Do not keep a healthy process alive just for this timer. If a hostile
    // child, taskkill, or inherited handle does keep it alive, force silence
    // and a nonzero result after the fixed grace deadline.
    const deadline = setTimeout(() => process.exit(1), TERMINATION_GRACE_MS);
    deadline.unref();
  }

  return {
    get aborted() { return state === "aborted"; },
    onAbort(listener) {
      if (state === "aborted") listener();
      else if (state === "active") abortListeners.add(listener);
      return () => abortListeners.delete(listener);
    },
    throwIfAborted() {
      if (state === "aborted") throw new Error();
    },
    succeed() {
      if (state !== "active") return false;
      state = "succeeded";
      releaseSuccessListeners();
      return true;
    },
    abort,
  };
}

function readConfiguration() {
  const opExecutable = process.env.PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE;
  const rawReference = process.env.PI_CODECKS_ONEPASSWORD_REFERENCE;
  const serviceAccountToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  if (!isAbsoluteExecutable(opExecutable) || typeof rawReference !== "string" || !serviceAccountToken?.trim()) throw new Error();
  const reference = normalizeOuterStraightQuotes(rawReference);
  if (!isSecretReference(reference)) throw new Error();
  return { opExecutable: opExecutable.trim(), reference, serviceAccountToken };
}

function isAbsoluteExecutable(value) {
  return typeof value === "string" && value.trim() !== "" && (isPosixAbsolute(value.trim()) || isWindowsAbsolute(value.trim()));
}

function normalizeOuterStraightQuotes(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed[0] === '"' && trimmed.at(-1) === '"') || (trimmed[0] === "'" && trimmed.at(-1) === "'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isSecretReference(value) {
  const path = value.startsWith(OP_REFERENCE_PREFIX) ? value.slice(OP_REFERENCE_PREFIX.length) : "";
  const segments = path.split("/");
  return Boolean(path) && segments.length >= 3 && segments.every((segment) => segment.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(segment));
}

async function readRequest(overall) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      unsubscribe();
      error ? reject(error) : resolve(value);
    };
    const stop = () => {
      try { process.stdin.pause(); } catch {}
      try { process.stdin.destroy(); } catch {}
      finish(new Error());
    };
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      bytes += buffer.length;
      if (bytes > REQUEST_LIMIT_BYTES) overall.abort();
      else chunks.push(buffer);
    };
    const onEnd = () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) throw new Error();
        finish(undefined, JSON.parse(text));
      } catch { overall.abort(); }
    };
    let unsubscribe = () => {};
    unsubscribe = overall.onAbort(stop);
    if (overall.aborted) return;
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

function validateRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const keys = Object.keys(value).sort();
  const expected = value.profile === undefined ? ["account", "service", "version"] : ["account", "profile", "service", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error();
  if (value.version !== 1 || value.service !== "codecks" || !isRequestMetadata(value.account)) throw new Error();
  if (value.profile !== undefined && !isRequestMetadata(value.profile)) throw new Error();
}

function isRequestMetadata(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
}

function createInvocationEnvironment(configuration) {
  const environment = Object.create(null);
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isConflictingOnePasswordEnvironment(name) || /^CODECKS_/i.test(name) || /^PI_CODECKS_ONEPASSWORD_/i.test(name) || /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(name) || name.toUpperCase() === REFERENCE_ENVIRONMENT_NAME) continue;
    environment[name] = value;
  }
  environment.OP_SERVICE_ACCOUNT_TOKEN = configuration.serviceAccountToken;
  environment[REFERENCE_ENVIRONMENT_NAME] = configuration.reference;
  return environment;
}

function isConflictingOnePasswordEnvironment(name) {
  return /^OP_SERVICE_ACCOUNT_TOKEN(?:_|$)/i.test(name) || /^OP_CONNECT(?:_|$)/i.test(name) || /^OP_SESSION(?:_|$)/i.test(name);
}

function runOp(configuration, overall) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let stopping = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputBytes = 0;
    const stdout = [];
    let terminationDeadline;
    let unsubscribe = () => {};

    const releaseLocalHandles = () => {
      child?.stdout?.removeAllListeners();
      child?.stderr?.removeAllListeners();
      child?.removeAllListeners();
      // Keep inert error listeners: streams can report a late error while
      // destruction races with a hostile child lifecycle.
      child?.stdout?.on("error", () => {});
      child?.stderr?.on("error", () => {});
      child?.on("error", () => {});
      try { child?.stdout?.destroy(); } catch {}
      try { child?.stderr?.destroy(); } catch {}
      try { child?.unref(); } catch {}
    };
    const cleanup = () => {
      clearTimeout(terminationDeadline);
      unsubscribe();
      releaseLocalHandles();
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(value);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      terminate(child);
      releaseLocalHandles();
      terminationDeadline = setTimeout(() => finish(new Error()), TERMINATION_GRACE_MS);
      terminationDeadline.unref();
    };
    const fail = () => overall.abort();
    const count = (kind, chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += buffer.length;
      if (kind === "stdout") {
        stdoutBytes += buffer.length;
        if (!stopping && stdoutBytes <= STDOUT_LIMIT_BYTES && outputBytes <= OUTPUT_LIMIT_BYTES) stdout.push(buffer);
      } else stderrBytes += buffer.length;
      // A successful fixed child is silent on stderr. Any byte is a failure,
      // while all streams remain bounded before being discarded.
      if (stderrBytes > 0 || stdoutBytes > STDOUT_LIMIT_BYTES || stderrBytes > STDERR_LIMIT_BYTES || outputBytes > OUTPUT_LIMIT_BYTES) fail();
    };

    unsubscribe = overall.onAbort(stop);
    if (overall.aborted) {
      finish(new Error());
      return;
    }
    try {
      child = spawn(configuration.opExecutable, ["run", "--no-masking", "--", process.execPath, "--input-type=module", "--eval", FIXED_CHILD_SOURCE], {
        env: createInvocationEnvironment(configuration),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      child.stdout?.on("data", (chunk) => count("stdout", chunk));
      child.stderr?.on("data", (chunk) => count("stderr", chunk));
      child.stdout?.once("error", fail);
      child.stderr?.once("error", fail);
      child.once("error", fail);
      child.once("close", (code) => {
        if (stopping || code !== 0 || stderrBytes !== 0) {
          overall.abort();
          finish(new Error());
        } else finish(undefined, Buffer.concat(stdout).toString("utf8"));
      });
      if (overall.aborted) stop();
    } catch {
      overall.abort();
      finish(new Error());
    }
  });
}

function terminate(child) {
  if (!child) return;
  const directKill = () => { try { child.kill("SIGKILL"); } catch {} };
  if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
    try {
      const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      taskkill.once("error", directKill);
      taskkill.once("close", (code) => { if (code !== 0) directKill(); });
      taskkill.unref();
      return;
    } catch { directKill(); return; }
  }
  if (process.platform !== "win32" && typeof child.pid === "number" && child.pid > 0) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
  }
  directKill();
}

function parseFixedChildResponse(text) {
  if (!text || Buffer.byteLength(text) > STDOUT_LIMIT_BYTES) throw new Error();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 || value.version !== 1 || typeof value.credential !== "string" || value.credential.length === 0) throw new Error();
  return { version: 1, credential: value.credential };
}

function writeResponse(response, overall) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      unsubscribe();
      error ? reject(error) : resolve();
    };
    let unsubscribe = () => {};
    unsubscribe = overall.onAbort(() => finish(new Error()));
    if (overall.aborted) return;
    try { process.stdout.write(JSON.stringify(response), (error) => finish(error)); } catch { finish(new Error()); }
  });
}
