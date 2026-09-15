import assert from "node:assert/strict";
import * as core from "../src/codecks-core.ts";
import { CodecksCredentialError, type CredentialFailureCategory } from "../src/codecks-credential-error.ts";
const account = process.env.CODECKS_ACCOUNT;
const profile = process.env.CODECKS_PROFILE;
const originalFetch = globalThis.fetch;
const payload = (value: unknown) => JSON.parse(String(value).match(/```json\s*([\s\S]*?)```/)![1]);
try
{
    process.env.CODECKS_ACCOUNT = "fixture"; delete process.env.CODECKS_PROFILE;
    let requests = 0;
    globalThis.fetch = (async () => { requests++; throw new Error("unexpected fetch"); }) as typeof fetch;
    for (const category of ["credential_rate_limited", "credential_configuration_invalid", "credential_helper_unavailable", "credential_helper_timeout", "credential_helper_protocol_error", "credential_cancelled", "credential_capacity"] as CredentialFailureCategory[])
    {
        core.__test.setCredentialProviderForTests({ id: "onepassword", resolve: async () => { throw new CodecksCredentialError(category); } });
        const result = payload(await core.runWithAbortSignal(undefined, () => core.card_get.execute({ cardId: "seq:42", format: "json" })));
        assert.equal(result.error.category, category);
        assert.equal(result.error.provider, "onepassword");
        assert.equal(result.error.requestSent, false);
        assert.match(result.error.message, /No request was sent to Codecks/);
        assert.equal(result.error.retryable, category === "credential_rate_limited");
        const batch = payload(await core.card_get_batch.execute({ cardIds: ["seq:42"], format: "json" }));
        assert.equal(batch.error.category, category);
        assert.deepEqual(batch.error.unqueried, ["seq:42"]);
        assert.equal(batch.error.complete, false);
        const milestone = payload(await core.runWithAbortSignal(undefined, () => core.milestone_list.execute({ format: "json" })));
        assert.equal(milestone.error.category, category);
        const text = String(await core.runWithAbortSignal(undefined, () => core.card_get.execute({ cardId: "seq:42", format: "text" })));
        assert.match(text, /No request was sent to Codecks/);
    }
    assert.equal(requests, 0);
    // Direct execution without an accounting context cannot claim definite absence of requests.
    const direct = payload(await core.card_get.execute({ cardId: "seq:42", format: "json" }));
    assert.equal(direct.error.requestSent, undefined);
    core.__test.setCredentialProviderForTests({ id: "test", resolve: async () => ({ token: "inert", providerId: "test" }) });
    // An error surfacing after dispatch must not erase that dispatch, even if typed as credential failure.
    globalThis.fetch = (async () => { requests++; throw new CodecksCredentialError("credential_rate_limited"); }) as typeof fetch;
    const afterDispatch = payload(await core.runWithAbortSignal(undefined, () => core.card_get.execute({ cardId: "seq:42", format: "json" })));
    assert.equal(afterDispatch.error.requestSent, true);
    assert.doesNotMatch(afterDispatch.error.message, /No request was sent/);
    assert.equal(requests, 1, "provider errors do not cause automatic replay");
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
    core.__test.resetRateGate();
    const codecksLimit = payload(await core.runWithAbortSignal(undefined, () => core.card_get.execute({ cardId: "seq:42", format: "json" })));
    assert.equal(codecksLimit.error.category, "rate_limited");
    assert.equal(codecksLimit.error.provider, undefined);
    console.log("Codecks safe credential error tests passed");
}
finally
{
    core.__test.setCredentialProviderForTests(); core.__test.resetRateGate();
    globalThis.fetch = originalFetch;
    if (account === undefined) delete process.env.CODECKS_ACCOUNT; else process.env.CODECKS_ACCOUNT = account;
    if (profile === undefined) delete process.env.CODECKS_PROFILE; else process.env.CODECKS_PROFILE = profile;
}
