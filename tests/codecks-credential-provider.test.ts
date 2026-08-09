import assert from "node:assert/strict";
import * as core from "../src/codecks-core.ts";

const ENV_KEYS = [
  "CODECKS_ACCOUNT", "CODECKS_SUBDOMAIN", "CODECKS_API_BASE", "CODECKS_TOKEN", "CODECKS_API_TOKEN",
  "CODECKS_PROFILE", "CODECKS_CREDENTIAL_PROVIDER", "CODECKS_CREDENTIAL_HELPER_MODULE",
  "CODECKS_PROFILE_ALPHA_PROD_ACCOUNT", "CODECKS_PROFILE_ALPHA_PROD_SUBDOMAIN", "CODECKS_PROFILE_ALPHA_PROD_API_BASE",
  "CODECKS_PROFILE_ALPHA_PROD_TOKEN", "CODECKS_PROFILE_ALPHA_PROD_API_TOKEN", "CODECKS_PROFILE_ALPHA_PROD_TOKEN_REF", "CODECKS_PROFILE_ALPHA_PROD_TOKEN_OP_REF",
] as const;
const savedEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

const clearEnvironment = (): void => {
  for (const key of ENV_KEYS) delete process.env[key];
};

try {
  clearEnvironment();
  process.env.CODECKS_ACCOUNT = "global-account";
  process.env.CODECKS_SUBDOMAIN = "fallback-account";
  process.env.CODECKS_API_BASE = "https://global-api.invalid";
  process.env.CODECKS_TOKEN = "direct-token";
  process.env.CODECKS_API_TOKEN = "api-token";
  assert.deepEqual(core.__test.getBaseConfig(), { account: "global-account", baseUrl: "https://global-api.invalid", profileKey: undefined });
  assert.deepEqual(await core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), { token: "direct-token", providerId: "environment" });

  delete process.env.CODECKS_TOKEN;
  assert.deepEqual(await core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), { token: "api-token", providerId: "environment" });

  process.env.CODECKS_PROFILE = "alpha-prod";
  process.env.CODECKS_PROFILE_ALPHA_PROD_ACCOUNT = "profile-account";
  process.env.CODECKS_PROFILE_ALPHA_PROD_SUBDOMAIN = "profile-subdomain";
  process.env.CODECKS_PROFILE_ALPHA_PROD_API_BASE = "https://profile-api.invalid";
  process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN = "profile-token";
  process.env.CODECKS_PROFILE_ALPHA_PROD_API_TOKEN = "profile-api-token";
  assert.deepEqual(core.__test.getBaseConfig(), { account: "profile-account", baseUrl: "https://profile-api.invalid", profileKey: "alpha-prod" });
  assert.deepEqual(await core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), { token: "profile-token", providerId: "environment" });

  delete process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN;
  assert.deepEqual(await core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), { token: "profile-api-token", providerId: "environment" });

  delete process.env.CODECKS_PROFILE_ALPHA_PROD_API_TOKEN;
  delete process.env.CODECKS_API_TOKEN;
  process.env.CODECKS_TOKEN = "global-fallback-token";
  assert.deepEqual(await core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), { token: "global-fallback-token", providerId: "environment" });

  process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN_OP_REF = "inert-operation-reference";
  await assert.rejects(core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), {
    message: "Codecks profile 'alpha-prod' uses a TOKEN_REF/TOKEN_OP_REF value, but pi-codecks no longer executes 1Password helpers directly. Resolve the secret through pi-onepassword or another explicit secret integration, then set CODECKS_TOKEN or CODECKS_PROFILE_<PROFILE>_TOKEN.",
  });
  delete process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN_OP_REF;
  process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN_REF = "inert-reference";
  await assert.rejects(core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), /TOKEN_REF\/TOKEN_OP_REF/);
  delete process.env.CODECKS_PROFILE_ALPHA_PROD_TOKEN_REF;

  clearEnvironment();
  assert.throws(() => core.__test.getBaseConfig(), /Missing Codecks account\. Set CODECKS_ACCOUNT \(or CODECKS_SUBDOMAIN\), or configure CODECKS_PROFILE\./);
  process.env.CODECKS_ACCOUNT = "account-only";
  await assert.rejects(core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), /Missing Codecks credentials\. Set CODECKS_TOKEN \(or CODECKS_API_TOKEN\) and CODECKS_ACCOUNT/);
  process.env.CODECKS_PROFILE = "alpha-prod";
  delete process.env.CODECKS_ACCOUNT;
  assert.throws(() => core.__test.getBaseConfig(), /Missing Codecks account for profile 'alpha-prod'\. Set CODECKS_PROFILE_ALPHA_PROD_ACCOUNT\./);
  process.env.CODECKS_PROFILE_ALPHA_PROD_ACCOUNT = "profile-account-only";
  await assert.rejects(core.__test.resolveEnvironmentCredential(core.__test.getBaseConfig()), {
    message: "Missing Codecks token for profile 'alpha-prod'. Set CODECKS_PROFILE_ALPHA_PROD_TOKEN.",
  });

  clearEnvironment();
  process.env.CODECKS_PROFILE = "invalid profile";
  assert.throws(() => core.__test.getBaseConfig(), {
    message: "Invalid CODECKS_PROFILE value. Use letters, numbers, '-', or '_'.",
  });

  clearEnvironment();
  process.env.CODECKS_ACCOUNT = "selector-account";
  process.env.CODECKS_TOKEN = "selector-token";
  assert.deepEqual(await core.__test.resolveAuthenticatedConfig(), { account: "selector-account", baseUrl: "https://api.codecks.io", token: "selector-token" });
  process.env.CODECKS_CREDENTIAL_PROVIDER = "environment";
  assert.deepEqual(await core.__test.resolveAuthenticatedConfig(), { account: "selector-account", baseUrl: "https://api.codecks.io", token: "selector-token" });
  process.env.CODECKS_CREDENTIAL_PROVIDER = "external-helper";
  await assert.rejects(core.__test.resolveAuthenticatedConfig(), /Codecks credential provider 'external-helper' is unavailable in this version\./);
  process.env.CODECKS_CREDENTIAL_PROVIDER = "unknown-provider";
  await assert.rejects(core.__test.resolveAuthenticatedConfig(), /Unsupported Codecks credential provider\. Set CODECKS_CREDENTIAL_PROVIDER=environment or remove it\./);

  delete process.env.CODECKS_CREDENTIAL_PROVIDER;
  let resolutions = 0;
  const requestedAccounts: string[] = [];
  core.__test.setCredentialProviderForTests({
    id: "test",
    async resolve(request) {
      resolutions += 1;
      requestedAccounts.push(request.account);
      return { token: "inert-provider-token", providerId: "test" };
    },
  });
  let fetchCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    fetchCalls += 1;
    assert.equal((init?.headers as Record<string, string>)["X-Account"], "selector-account");
    assert.equal((init?.headers as Record<string, string>)["X-Auth-Token"], "inert-provider-token");
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await core.runWithAbortSignal(undefined, async () => {
    await Promise.all([
      core.query.execute({ query: { _root: [] } }),
      core.query.execute({ query: { _root: [] } }),
    ]);
  });
  assert.equal(resolutions, 1, "multiple authenticated requests in one operation resolve credentials once");
  assert.equal(fetchCalls, 2);
  assert.deepEqual(requestedAccounts, ["selector-account"]);

  await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
  assert.equal(resolutions, 2, "separate operations do not retain credentials");

  fetchCalls = 0;
  await Promise.all([
    core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } })),
    core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } })),
  ]);
  assert.equal(fetchCalls, 2, "concurrent distinct operations make their own authenticated requests");
  assert.equal(resolutions, 4, "concurrent distinct operations resolve credentials independently");

  fetchCalls = 0;
  await core.query.execute({ query: { _root: [] } });
  assert.equal(fetchCalls, 1, "direct execution outside an operation context makes an authenticated request");
  assert.equal(resolutions, 5, "direct execution outside an operation context resolves credentials");

  fetchCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    fetchCalls += 1;
    assert.equal((init?.headers as Record<string, string>)["X-Auth-Token"], "inert-provider-token");
    return fetchCalls === 1
      ? new Response("retry", { status: 503, statusText: "Unavailable" })
      : new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await core.runWithAbortSignal(undefined, () => core.query.execute({ query: { _root: [] } }));
  assert.equal(fetchCalls, 2, "read retry makes two authenticated requests");
  assert.equal(resolutions, 6, "retry shares its operation credential resolution");

  fetchCalls = 0;
  globalThis.fetch = (async (_input, init) => {
    fetchCalls += 1;
    assert.equal((init?.headers as Record<string, string>)["X-Auth-Token"], "inert-provider-token");
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await core.runWithAbortSignal(undefined, () => core.dispatch.execute({ path: "cards/update", payload: { id: "fixture" }, format: "json" }));
  assert.equal(fetchCalls, 1, "representative mutation makes one authenticated request");
  assert.equal(resolutions, 7, "mutation resolves once in its distinct operation");

  console.log("Codecks credential-provider characterization tests passed");
} finally {
  core.__test.setCredentialProviderForTests();
  globalThis.fetch = originalFetch;
  clearEnvironment();
  for (const [key, value] of savedEnvironment) {
    if (value !== undefined) process.env[key] = value;
  }
}
