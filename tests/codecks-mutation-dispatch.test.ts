import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerCodecks from "../index.ts";
import { __test as codecksTest } from "../src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "test-account";
process.env.CODECKS_TOKEN = "test-token";
process.env.PI_CODECKS_TOOL_LOADING_MODE = "all-active";

type Tool = { parameters?: { properties?: Record<string, unknown> }; execute: (...args: any[]) => Promise<any> };
const tools = new Map<string, Tool>();
registerCodecks({
  registerTool(definition: Tool & { name: string }) { tools.set(definition.name, definition); },
  on() {},
  getActiveTools() { return []; },
  getAllTools() { return []; },
  setActiveTools() {},
} as any);

const mutationToolNames = [
  "codecks_dispatch", "codecks_card_create", "codecks_card_bulk_update", "codecks_deck_update",
  "codecks_card_add_attachment", "codecks_card_update_status", "codecks_card_reply_resolvable",
];
for (const name of mutationToolNames) {
  assert.equal(tools.get(name)?.parameters?.properties?.authorizationToken, undefined, `${name} must not expose authorizationToken`);
}

const dispatch = tools.get("codecks_dispatch")!;
const query = tools.get("codecks_query")!;
const attachment = tools.get("codecks_card_add_attachment")!;
const CARD_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCH_PATHS = [
  "cards/create", "cards/update", "cards/addFile", "decks/update", "milestones/update",
  "sprints/updateSprint", "resolvables/create", "resolvables/comment", "resolvables/updateComment",
  "resolvables/close", "resolvables/reopen",
] as const;

const payloadFor = (dispatchPath: string): Record<string, unknown> => {
  switch (dispatchPath) {
    case "cards/create": return { content: "Direct mutation fixture" };
    case "cards/update": return { id: CARD_ID, status: "done" };
    case "cards/addFile": return { cardId: CARD_ID, fileData: { fileName: "proof.txt" } };
    case "decks/update": return { id: "deck-1", description: "updated" };
    case "milestones/update": return { id: "milestone-1", description: "updated" };
    case "sprints/updateSprint": return { id: "run-1", description: "updated" };
    case "resolvables/create": return { cardId: CARD_ID, context: "comment", content: "fixture" };
    case "resolvables/comment": return { id: "resolvable-1", content: "fixture" };
    case "resolvables/updateComment": return { id: "entry-1", content: "fixture" };
    case "resolvables/close": return { id: "resolvable-1" };
    case "resolvables/reopen": return { id: "resolvable-1" };
    default: return { id: "fixture" };
  }
};

let confirmationCalls = 0;
const directContext = (cwd = process.cwd()) => ({
  cwd,
  sessionManager: {},
  mode: "tui",
  hasUI: true,
  ui: { async confirm() { confirmationCalls += 1; throw new Error("Codecks must not request UI mutation confirmation"); } },
});
const invoke = async (dispatchPath: string, payload: Record<string, unknown>) => dispatch.execute(
  "mutation-test",
  { path: dispatchPath, payload, format: "json" },
  new AbortController().signal,
  undefined,
  directContext(),
);

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

try {
  for (const dispatchPath of DISPATCH_PATHS) {
    fetchCalls = 0;
    const result = await invoke(dispatchPath, payloadFor(dispatchPath));
    assert.equal(fetchCalls, 1, `${dispatchPath} must proceed directly to one dispatch attempt`);
    assert.match(result.content[0].text, /"ok": true/);
  }
  assert.equal(confirmationCalls, 0, "direct mutation calls must not prompt for approval");

  fetchCalls = 0;
  await invoke("custom/write", { id: "x" });
  assert.equal(fetchCalls, 1, "validated in-scope raw dispatch does not require classification or approval");

  fetchCalls = 0;
  const missingId = await invoke("cards/update", { status: "done" });
  assert.equal(fetchCalls, 0, "cards/update entity validation must fail before dispatch");
  assert.match(missingId.content[0].text, /requires an 'id' value/);

  fetchCalls = 0;
  const outOfScope = await invoke("integrations/update", { id: "x" });
  assert.equal(fetchCalls, 0, "out-of-scope operation validation must fail before dispatch");
  assert.match(outOfScope.content[0].text, /out of scope/i);

  for (const responseKind of ["timeout", "retryable"] as const) {
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (responseKind === "timeout") throw new Error("mock timeout after request started");
      return new Response("retry later", { status: 503, statusText: "Unavailable" });
    }) as typeof fetch;
    const result = await invoke("cards/update", payloadFor("cards/update"));
    assert.equal(fetchCalls, 1, `${responseKind} mutation must make exactly one remote attempt`);
    assert.match(result.content[0].text, /timed out|503/);
  }

  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return fetchCalls === 1
      ? new Response("retry later", { status: 503, statusText: "Unavailable" })
      : new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await query.execute("query-retry", { query: { _root: [] } }, new AbortController().signal, undefined, directContext());
  assert.equal(fetchCalls, 2, "read-only Codecks queries retain bounded retries");

  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-codecks-mutation-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-codecks-outside-"));
  try {
    const inside = path.join(temp, "proof.txt");
    const second = path.join(temp, "nested", "proof.txt");
    const outsideFile = path.join(outside, "proof.txt");
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(inside, "proof-a");
    await writeFile(second, "proof-a");
    await writeFile(outsideFile, "outside-proof");

    const source = await codecksTest.snapshotAttachmentSource(inside, temp);
    const secondSource = await codecksTest.snapshotAttachmentSource(second, temp);
    assert.equal(source.size, 7);
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.notEqual(source.canonicalPath, secondSource.canonicalPath, "canonical source identity remains exact");

    fetchCalls = 0;
    await assert.rejects(
      attachment.execute("attachment-outside", { cardId: CARD_ID, filePath: outsideFile }, new AbortController().signal, undefined, directContext(temp)),
      /attachment_outside_workspace/,
    );
    assert.equal(fetchCalls, 0, "outside-workspace sources are blocked without an approval escape hatch");

    const escapeDir = path.join(temp, "escape-link");
    let junctionCreated = false;
    try {
      await symlink(outside, escapeDir, process.platform === "win32" ? "junction" : "dir");
      junctionCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    if (junctionCreated) {
      fetchCalls = 0;
      await assert.rejects(
        attachment.execute("attachment-escape", { cardId: CARD_ID, filePath: path.join(escapeDir, "proof.txt") }, new AbortController().signal, undefined, directContext(temp)),
        /attachment_symlink_escape/,
      );
      assert.equal(fetchCalls, 0, "symlink/junction escapes fail before network access");
    }

    let uploadOrDispatchCalls = 0;
    fetchCalls = 0;
    globalThis.fetch = (async (input) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("/s3/sign")) {
        await writeFile(inside, "changed-after-inspection");
        return new Response(JSON.stringify({ signedUrl: "https://upload.test/object", fields: { key: "fixture" }, publicUrl: "https://cdn.test/proof.txt" }), { status: 200 });
      }
      if (url === "https://upload.test/object" || url.includes("/dispatch/")) uploadOrDispatchCalls += 1;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(
      attachment.execute("attachment-change", { cardId: CARD_ID, filePath: inside }, new AbortController().signal, undefined, directContext(temp)),
      /changed after inspection/,
    );
    assert.equal(fetchCalls, 1, "TOCTOU fixture may sign once but must not upload changed bytes");
    assert.equal(uploadOrDispatchCalls, 0, "changed files cause no upload or card mutation");

    await writeFile(inside, "proof-a");
    const successfulMutationUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/s3/sign")) {
        return new Response(JSON.stringify({ signedUrl: "https://upload.test/object", fields: { key: "fixture" }, publicUrl: "https://cdn.test/proof.txt" }), { status: 200 });
      }
      if (url === "https://upload.test/object") {
        successfulMutationUrls.push(url);
        return new Response("", { status: 200 });
      }
      if (url.includes("/dispatch/cards/addFile")) {
        successfulMutationUrls.push(url);
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: "user-1" }, user: { "user-1": { id: "user-1", name: "Fixture" } } } }), { status: 200 });
    }) as typeof fetch;
    const successResult = await attachment.execute(
      "attachment-success",
      { cardId: CARD_ID, filePath: inside, format: "json" },
      new AbortController().signal,
      undefined,
      directContext(temp),
    );
    assert.equal(successfulMutationUrls.length, 2, "attachment performs one upload and one card dispatch");
    assert.equal(confirmationCalls, 0, "attachment does not request UI confirmation");
    assert.doesNotMatch(JSON.stringify(successResult), /[a-f0-9]{64}/i, "attachment results do not disclose content hashes");
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  console.log("Codecks direct mutation dispatch tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
