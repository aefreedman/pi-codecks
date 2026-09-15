import assert from "node:assert/strict";
import { OnePasswordState, OnePasswordStateError } from "../src/codecks-onepassword-state.ts";
const signal = () => new AbortController().signal;
const deferred = <T>() => {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const limit = () => new OnePasswordStateError("credential_rate_limited", "safe provider limit");
let now = 0;
const state = new OnePasswordState({ now: () => now });
let calls = 0;
const load = async () => { calls++; return { token: "same-inert-token" }; };
const get = (key = "a", scope = key, ttl = 1000) => state.resolve(key, scope, ttl, signal(), load);

// Success starts TTL, not the start of a slow helper; same-config misses coalesce.
const slow = deferred<{ token: string }>();
const a = state.resolve("a", "a", 1000, signal(), () => { calls++; return slow.promise; });
const b = state.resolve("a", "a", 1000, signal(), load);
await tick(); assert.equal(calls, 1);
now = 9000; slow.resolve({ token: "same-inert-token" });
const [old, shared] = await Promise.all([a, b]);
assert.equal(old.credentialGeneration, shared.credentialGeneration);
now = 9999; assert.equal((await get()).credentialGeneration, old.credentialGeneration);
now = 10000; const newer = await get(); assert.notEqual(newer.credentialGeneration, old.credentialGeneration);
state.evict(old.credentialGeneration);
assert.equal((await get()).credentialGeneration, newer.credentialGeneration, "old 401 cannot evict identical-token newer generation");
state.evict(newer.credentialGeneration);
assert.notEqual((await get()).credentialGeneration, newer.credentialGeneration);

// Disabled reuse preserves independent-operation behavior including concurrent calls.
state.clear(); calls = 0;
await Promise.all(Array.from({ length: 17 }, () => get("a", "a", 0)));
assert.equal(calls, 17); assert.equal(state.counts().cacheEntries, 0);
await Promise.all(Array.from({ length: 37 }, () => get()));
assert.equal(calls, 18, "37 enabled same-process calls launch one helper");

// Cancellation belongs to a caller, while abandoned work is aborted and cannot publish.
state.clear();
const pending = deferred<{ token: string }>();
let helperSignal!: AbortSignal;
const cancelOne = new AbortController();
const first = state.resolve("a", "a", 1000, cancelOne.signal, s => { helperSignal = s; return pending.promise; });
const second = state.resolve("a", "a", 1000, signal(), load);
await tick();
const rejectedFirst = assert.rejects(first, /cancelled/);
cancelOne.abort(); await rejectedFirst;
assert.equal(helperSignal.aborted, false);
pending.resolve({ token: "inert" }); await second;
state.clear();
const abandoned = deferred<{ token: string }>();
const cancelAll = new AbortController();
const orphan = state.resolve("a", "a", 1000, cancelAll.signal, s => { helperSignal = s; return abandoned.promise; });
await tick(); const rejectedOrphan = assert.rejects(orphan, /cancelled/);
cancelAll.abort(); await rejectedOrphan; await tick();
assert.equal(helperSignal.aborted, true);
const fresh = await get();
abandoned.resolve({ token: "obsolete" }); await tick();
assert.equal((await get()).credentialGeneration, fresh.credentialGeneration);
assert.equal(state.counts().inFlight, 0);
const preaborted = new AbortController(); preaborted.abort();
await assert.rejects(state.resolve("a", "a", 1000, preaborted.signal, load), /cancelled/);

// A never-settling loader is still bounded by the private resolver deadline.
let fire!: () => void; let cleared = 0;
const timed = new OnePasswordState({ schedule: callback => { fire = callback; return { unref() {} } as ReturnType<typeof setTimeout>; }, cancel: () => { cleared++; } });
const hung = timed.resolve("a", "a", 1000, signal(), s => { helperSignal = s; return new Promise(() => {}); });
const hungCheck = assert.rejects(hung, /timed out/);
await tick(); fire(); await hungCheck; await tick();
assert.equal(helperSignal.aborted, true); assert.equal(cleared, 1); assert.equal(timed.counts().inFlight, 0);

// A scope change invalidates old publications even if that configuration returns later.
state.clear(); now = 0;
const oldLoad = deferred<{ token: string }>();
const oldPending = state.resolve("config-old", "scope", 1000, signal(), () => oldLoad.promise);
await tick(); await get("config-new", "scope");
const newerLoad = deferred<{ token: string }>();
const newPending = state.resolve("config-old", "scope", 1000, signal(), () => newerLoad.promise);
await tick(); oldLoad.resolve({ token: "old" }); await oldPending;
const third = state.resolve("config-old", "scope", 1000, signal(), () => { throw new Error("old cleanup deleted newer flight"); });
newerLoad.resolve({ token: "new" });
assert.equal((await newPending).credentialGeneration, (await third).credentialGeneration);
assert.equal((await get("config-old", "scope")).token, "new");

// Changing TTL/disable policy while a helper runs cannot resurrect an enabled entry.
state.clear(); const obsolete = deferred<{ token: string }>();
const obsoleteResult = state.resolve("a", "a", 1000, signal(), () => obsolete.promise);
await tick(); await get("a", "a", 0); obsolete.resolve({ token: "old" }); await obsoleteResult;
assert.equal(state.counts().cacheEntries, 0);

// Positive rate limits suppress launches until expiry, even across a configuration switch back.
state.clear(); calls = 0; now = 100;
await assert.rejects(state.resolve("a", "scope", 1000, signal(), async () => { calls++; throw limit(); }), /safe provider limit/);
await assert.rejects(state.resolve("a", "scope", 1000, signal(), load), /rate-limited/);
assert.equal(calls, 1);
await get("b", "scope");
await assert.rejects(state.resolve("a", "scope", 1000, signal(), load), /rate-limited/);
now = 60099; await assert.rejects(state.resolve("a", "scope", 1000, signal(), load), /rate-limited/);
now = 60100; await get("a", "scope"); assert.equal(calls, 3);
state.clear();
await assert.rejects(state.resolve("a", "a", 1000, signal(), async () => { throw new Error("unknown"); }), /unknown/);
assert.equal(state.counts().cooldownEntries, 0); await get();

// Concurrent non-reused calls: late success cannot undo authoritative rate limit.
state.clear(); const late = deferred<{ token: string }>();
const lateResult = state.resolve("a", "a", 0, signal(), () => late.promise);
await tick();
await assert.rejects(state.resolve("a", "a", 0, signal(), async () => { throw limit(); }), /safe provider limit/);
late.resolve({ token: "late" }); await lateResult;
await assert.rejects(get(), /rate-limited/); assert.equal(state.counts().cacheEntries, 0);

// State bounds do not evict active cooldowns just to permit another configuration.
state.clear(); now = 0;
for (let i = 0; i < 65; i++) await get(String(i));
assert.equal(state.counts().entries, 64); assert.equal(state.counts().cacheEntries, 64);
state.clear();
for (let i = 0; i < 64; i++) await assert.rejects(state.resolve(String(i), String(i), 0, signal(), async () => { throw limit(); }));
await assert.rejects(get("65"), /capacity/);
assert.equal(state.counts().cooldownEntries, 64);
now = 60000; await get("65"); assert.equal(state.counts().entries, 64);
// Separate process state objects cannot coalesce or share cached credentials.
let independent = 0;
await Promise.all([new OnePasswordState(), new OnePasswordState()].map(s => s.resolve("a", "a", 1000, signal(), async () => { independent++; return { token: "inert" }; })));
assert.equal(independent, 2);
state.clear(); timed.clear();
console.log("Codecks 1Password state-machine tests passed");
