import assert from "node:assert/strict";
import { CodecksProfileSession, isProfileConfigured } from "../src/codecks-profile-session.ts";
import * as core from "../src/codecks-core.ts";
import { PiToolHarness } from "./pi-tool-harness.ts";

const profile = new CodecksProfileSession(() => undefined);
profile.start();
assert.equal(profile.profile, "ORG");
profile.select("PERSONAL", "task");
assert.equal(profile.profile, "PERSONAL");
profile.settle();
assert.equal(profile.profile, "ORG");
profile.select("PERSONAL", "session");
profile.settle();
assert.equal(profile.profile, "PERSONAL");
profile.start();
assert.equal(profile.profile, "ORG", "new, resumed and forked sessions cannot inherit the previous instance's selection");
assert.equal(new CodecksProfileSession(() => "PERSONAL").profile, "ORG", "startup override applies only on start");
assert.equal(isProfileConfigured("PERSONAL", { CODECKS_CREDENTIAL_PROVIDER: "onepassword", PI_CODECKS_ONEPASSWORD_REFERENCE: "synthetic-global" }), false);
assert.equal(isProfileConfigured("ORG", { CODECKS_CREDENTIAL_PROVIDER: "onepassword", PI_CODECKS_ONEPASSWORD_REFERENCE: "synthetic-global" }), true);
assert.equal(isProfileConfigured("ORG", { CODECKS_CREDENTIAL_PROVIDER: "onepassword" }), false);
assert.equal(isProfileConfigured("PERSONAL", { CODECKS_CREDENTIAL_PROVIDER: "onepassword", CODECKS_PROFILE_PERSONAL_ONEPASSWORD_REFERENCE: "synthetic-personal" }), true);

const priorAccount = process.env.CODECKS_ACCOUNT;
const priorProfile = process.env.CODECKS_PROFILE;
const originalFetch = globalThis.fetch;
try {
  process.env.CODECKS_ACCOUNT = "synthetic-account";
  delete process.env.CODECKS_PROFILE;
  const requested: string[] = [];
  core.__test.setCredentialProviderForTests({ id: "fixture", resolve: async (request) => {
    requested.push(request.profileKey!);
    return { providerId: "fixture", token: request.profileKey === "PERSONAL" ? "cdxut_synthetic" : "cdxat_synthetic" };
  } });
  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.match(headers.Authorization, /^Bearer cdx(at|ut)_synthetic$/);
    assert.equal(headers["X-Auth-Token"], undefined);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await core.runWithAbortSignal(undefined, async () => {
    profile.select("PERSONAL", "session");
    await core.query.execute({ query: { _root: [] } });
  }, undefined, undefined, "ORG");
  await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }), undefined, undefined, profile.profile);
  assert.deepEqual(requested, ["ORG", "PERSONAL"], "operation start captures a profile independently of later selections");
  const parse = (value: unknown) => JSON.parse(String(value).match(/```json\s*([\s\S]*?)```/)![1]);
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: {} }), { status: 200 }); }) as typeof fetch;
  const guarded = parse(await core.runWithAbortSignal(undefined, () => core.dispatch.execute({ path: "resolvables/create", payload: { cardId: "synthetic", content: "test" }, format: "json" }), undefined, undefined, "ORG"));
  assert.equal(guarded.error.category, "org_actor_unverified");
  assert.equal(calls, 0);
  const deckless = parse(await core.runWithAbortSignal(undefined, () => core.dispatch.execute({ path: "cards/create", payload: { assigneeId: "synthetic" }, format: "json" }), undefined, undefined, "ORG"));
  assert.equal(deckless.error.category, "org_actor_unverified");
  assert.equal(calls, 0);
  const approvedOrgCreate = parse(await core.runWithAbortSignal(undefined, () => core.dispatch.execute({ path: "cards/create", payload: { deckId: "synthetic-deck", assigneeId: "synthetic-user", content: "synthetic" }, format: "json" }), undefined, undefined, "ORG"));
  assert.equal(approvedOrgCreate.ok, true);
  assert.equal(calls, 1, "documented org create omitting userId can dispatch once");
  calls = 0;
  const create = parse(await core.runWithAbortSignal(undefined, () => core.card_create.execute({ title: "synthetic", deck: "synthetic", format: "json" }), undefined, undefined, "ORG"));
  assert.equal(create.error.category, "org_actor_unverified");
  assert.equal(calls, 0);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "missing_scope", requiredScope: "cards:read", token: "cdxat_synthetic" } }), { status: 403 })) as typeof fetch;
  const denied = parse(await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }), undefined, undefined, "ORG"));
  assert.equal(denied.error.category, "missing_scope");
  assert.equal(denied.error.httpStatus, 403);
  assert.equal(denied.error.requiredScope, "cards:read");
  assert.doesNotMatch(JSON.stringify(denied), /cdxat_synthetic/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "token_account_mismatch" } }), { status: 400 })) as typeof fetch;
  const mismatch = parse(await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }), undefined, undefined, "ORG"));
  assert.equal(mismatch.error.category, "account_mismatch");
  const manualFailures = [
    { status: 403, body: { error: "missing_scope", path: "_root.account.cards", requiredScope: "cards:read" }, category: "missing_scope", code: "missing_scope" },
    { status: 400, body: { error: "token_account_mismatch", path: "_root.account" }, category: "account_mismatch", code: "token_account_mismatch" },
    { status: 400, body: { message: "token_expired" }, category: "authentication_rejected", code: "token_expired" },
    { status: 401, body: { message: "invalid_token" }, category: "authentication_rejected", code: "invalid_token" },
  ] as const;
  for (const failure of manualFailures) {
    globalThis.fetch = (async () => new Response(JSON.stringify(failure.body), { status: failure.status })) as typeof fetch;
    const rejected = parse(await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }), undefined, undefined, "ORG"));
    assert.equal(rejected.error.category, failure.category);
    assert.equal(rejected.error.apiCode, failure.code);
    assert.equal(rejected.error.httpStatus, failure.status);
    assert.equal(rejected.error.path, "/", "Codecks request endpoint is distinct from API query path");
    assert.equal(rejected.error.apiPath, "path" in failure.body ? failure.body.path : undefined);
    assert.equal(rejected.error.requiredScope, "requiredScope" in failure.body ? failure.body.requiredScope : undefined);
  }
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "vendor diagnostic: cdxat_synthetic-leak", message: "unsafe vendor text cdxut_synthetic-leak", path: "_root.account?token=cdxat_synthetic-leak", requiredScope: "cdxat_synthetic-leak" }), { status: 403 })) as typeof fetch;
  const unsafe = parse(await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }), undefined, undefined, "ORG"));
  assert.equal(unsafe.error.category, "forbidden");
  assert.equal(unsafe.error.apiCode, undefined);
  assert.equal(unsafe.error.apiPath, undefined);
  assert.equal(unsafe.error.requiredScope, undefined);
  assert.doesNotMatch(JSON.stringify(unsafe), /synthetic-leak|vendor diagnostic|unsafe vendor text/);
} finally {
  core.__test.setCredentialProviderForTests();
  globalThis.fetch = originalFetch;
  if (priorAccount === undefined) delete process.env.CODECKS_ACCOUNT; else process.env.CODECKS_ACCOUNT = priorAccount;
  if (priorProfile === undefined) delete process.env.CODECKS_PROFILE; else process.env.CODECKS_PROFILE = priorProfile;
}
const orgTokenBefore = process.env.CODECKS_PROFILE_ORG_TOKEN;
const personalTokenBefore = process.env.CODECKS_PROFILE_PERSONAL_TOKEN;
const startupProfileBefore = process.env.CODECKS_PROFILE;
const accountBefore = process.env.CODECKS_ACCOUNT;
const fetchBefore = globalThis.fetch;
try {
  process.env.CODECKS_PROFILE_ORG_TOKEN = "cdxat_synthetic-org-session";
  process.env.CODECKS_PROFILE_PERSONAL_TOKEN = "cdxut_synthetic-personal-session";
  process.env.CODECKS_ACCOUNT = "synthetic-session-account";
  delete process.env.CODECKS_PROFILE;
  const harness = new PiToolHarness();
  await harness.load();
  await harness.startSession([], "new");
  const selector = harness.registry.get("codecks_profile_select")!;
  const query = harness.registry.get("codecks_query")!;
  const select = async (profile: "ORG" | "PERSONAL", scope: "task" | "session") =>
    (await selector.execute("select", { profile, scope })).details;
  const seen: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let firstResolution!: () => void;
  const started = new Promise<void>((resolve) => { firstResolution = resolve; });
  core.__test.setCredentialProviderForTests({ id: "registered-fixture", resolve: async (request) => {
    seen.push(request.profileKey!);
    if (seen.length === 1) { firstResolution(); await held; }
    return { providerId: "registered-fixture", token: request.profileKey === "PERSONAL" ? "cdxut_synthetic-personal-session" : "cdxat_synthetic-org-session" };
  } });
  globalThis.fetch = (async (_input, init) => {
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, `Bearer ${seen.at(-1) === "PERSONAL" ? "cdxut_synthetic-personal-session" : "cdxat_synthetic-org-session"}`);
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  const runQuery = async () => query.execute("query", { query: { _root: [] }, format: "json" }, undefined, undefined, { cwd: process.cwd() });
  const pending = runQuery();
  await started;
  assert.deepEqual(await select("PERSONAL", "task"), { changed: true, profile: "PERSONAL", scope: "task" });
  release();
  assert.match(String((await pending).content[0].text), /query/i);
  await runQuery();
  assert.deepEqual(seen, ["ORG", "PERSONAL"], "registered tool retains in-flight ORG while later calls use PERSONAL");
  await harness.settleAgent();
  await runQuery();
  assert.equal(seen.at(-1), "ORG", "agent_settled restores task selection");
  await select("PERSONAL", "session");
  await harness.settleAgent();
  await runQuery();
  assert.equal(seen.at(-1), "PERSONAL", "session scope survives settlement");
  const selectedHistory = [{ type: "message", message: { role: "toolResult", toolName: "codecks_profile_select", details: { changed: true, profile: "PERSONAL", scope: "session" } } }];
  for (const reason of ["new", "resume", "fork"]) {
    await harness.startSession(selectedHistory, reason);
    await runQuery();
    assert.equal(seen.at(-1), "ORG", `${reason} must not restore PERSONAL selection from history`);
    await select("PERSONAL", "session");
  }
  process.env.CODECKS_PROFILE = "PERSONAL";
  await harness.startSession(selectedHistory, "resume");
  await runQuery();
  assert.equal(seen.at(-1), "PERSONAL", "explicit startup override applies when session starts");
  await harness.shutdownSession();
} finally {
  core.__test.setCredentialProviderForTests();
  globalThis.fetch = fetchBefore;
  for (const [key, value] of [["CODECKS_PROFILE_ORG_TOKEN", orgTokenBefore], ["CODECKS_PROFILE_PERSONAL_TOKEN", personalTokenBefore], ["CODECKS_PROFILE", startupProfileBefore], ["CODECKS_ACCOUNT", accountBefore]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log("Codecks profile session and registered lifecycle tests passed");
