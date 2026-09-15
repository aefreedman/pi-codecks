import assert from "node:assert/strict";
import { readBoundedResponse } from "../src/codecks-bounded-response.ts";
const options = { timeoutMs: 1000 };
for (const headers of [{}, { "Content-Length": "1" }, { "Content-Length": "999999" }])
{
    assert.equal(await readBoundedResponse(new Response("four", { headers }), 4, options), "four");
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode("12345")); }, cancel() { cancelled++; } });
    const response = new Response(body, { headers });
    await assert.rejects(readBoundedResponse(response, 4, options), /exceeded/);
    assert.equal(cancelled, 1); assert.equal(body.locked, false);
}
assert.equal(await readBoundedResponse(new Response("é"), 2, options), "é", "limit counts UTF8 bytes not characters");
await assert.rejects(readBoundedResponse(new Response("é"), 1, options), /exceeded/);
assert.equal(await readBoundedResponse(new Response(null), 4, options), "");
await assert.rejects(readBoundedResponse({ text: async () => "unbounded" } as Response, 4, options), /no readable stream/);
let cancelCalls = 0;
const stalled = new ReadableStream<Uint8Array>({ cancel() { cancelCalls++; return new Promise(() => {}); } });
const controller = new AbortController();
const reading = readBoundedResponse(new Response(stalled), 4, { ...options, signal: controller.signal });
const rejected = assert.rejects(reading, /cancelled/); controller.abort(); await rejected;
assert.equal(cancelCalls, 1); assert.equal(stalled.locked, false, "stalled cancel cannot retain the reader lock");
let fire!: () => void; let cleared = 0;
const timedStream = new ReadableStream<Uint8Array>({ cancel() { cancelCalls++; } });
const timed = readBoundedResponse(new Response(timedStream), 4, {
    ...options, schedule: callback => { fire = callback; return { unref() {} } as ReturnType<typeof setTimeout>; }, cancel: () => { cleared++; },
});
const timedCheck = assert.rejects(timed, /timed out/); fire(); await timedCheck;
assert.equal(cleared, 1); assert.equal(timedStream.locked, false);
const broken = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("stream failed")); } });
await assert.rejects(readBoundedResponse(new Response(broken), 4, options), /stream failed/);
assert.equal(broken.locked, false);
console.log("Codecks bounded response tests passed");
