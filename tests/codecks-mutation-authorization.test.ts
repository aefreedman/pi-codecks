import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerCodecks from "../index.ts";
import { __test as codecksTest } from "../src/codecks-core.ts";
import {
  CODECKS_MUTATION_DISPATCH_PATHS_V1,
  classifyCodecksDispatchMutationV1,
  codecksAttachmentMutationTargetV1,
} from "../src/mutation-authorization.ts";
import { issueWorkflowAuthorizationTokenV1 } from "@aefree/pi-workflow/authorization/v1";

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
const dispatch = tools.get("codecks_dispatch")!;
const query = tools.get("codecks_query")!;
const attachment = tools.get("codecks_card_add_attachment")!;
for (const name of ["codecks_dispatch", "codecks_card_create", "codecks_card_bulk_update", "codecks_deck_update", "codecks_card_add_attachment", "codecks_card_update_status", "codecks_card_reply_resolvable"]) {
  assert.ok(tools.get(name)?.parameters?.properties?.authorizationToken, `${name} must expose optional authorizationToken`);
}
assert.equal(tools.get("codecks_query")?.parameters?.properties?.authorizationToken, undefined, "legacy reads remain unchanged");
const CARD_ID = "11111111-1111-4111-8111-111111111111";

const payloadFor = (dispatchPath: string): Record<string, unknown> => {
  switch (dispatchPath) {
    case "cards/create": return { content: "Mutation authorization fixture" };
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

const invoke = async (
  dispatchPath: string,
  payload: Record<string, unknown>,
  ctx: Record<string, unknown>,
  authorizationToken?: string,
) => dispatch.execute("mutation-test", {
  path: dispatchPath,
  payload,
  format: "json",
  ...(authorizationToken === undefined ? {} : { authorizationToken }),
}, new AbortController().signal, undefined, ctx);

const originalFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

try {
  for (const dispatchPath of CODECKS_MUTATION_DISPATCH_PATHS_V1) {
    fetchCalls = 0;
    const sessionManager = {};
    const result = await invoke(dispatchPath, payloadFor(dispatchPath), {
      cwd: process.cwd(), sessionManager, mode: "json", hasUI: false,
    });
    assert.equal(fetchCalls, 0, `${dispatchPath} must block before fetch without a token`);
    assert.match(result.content[0].text, /authorization_token_required|authorization_context_required/);
  }

  for (const dispatchPath of CODECKS_MUTATION_DISPATCH_PATHS_V1) {
    fetchCalls = 0;
    let confirmations = 0;
    const result = await invoke(dispatchPath, payloadFor(dispatchPath), {
      cwd: process.cwd(), sessionManager: {}, mode: "tui", hasUI: true,
      ui: { async confirm(_title: string, message: string) { confirmations += 1; assert.match(message, /tracker_mutation/); assert.match(message, /codecks:/); return true; } },
    });
    assert.equal(fetchCalls, 1, `${dispatchPath} must dispatch once after direct confirmation`);
    assert.equal(confirmations, 1, `${dispatchPath} must bind one direct confirmation`);
    assert.doesNotMatch(JSON.stringify(result), /wfa_[A-Za-z0-9_-]+/, "results must not expose authorization tokens");
  }

  const repeatedPayload = payloadFor("cards/update");
  let repeatedConfirmations = 0;
  const repeatedContext = {
    cwd: process.cwd(), sessionManager: {}, mode: "tui", hasUI: true,
    ui: { async confirm() { repeatedConfirmations += 1; return true; } },
  };
  fetchCalls = 0;
  await invoke("cards/update", repeatedPayload, repeatedContext);
  await invoke("cards/update", repeatedPayload, repeatedContext);
  assert.equal(fetchCalls, 2);
  assert.equal(repeatedConfirmations, 2, "direct confirmation must not be cached across remote mutation attempts");

  const payload = payloadFor("cards/update");
  const target = classifyCodecksDispatchMutationV1("test-account", "cards/update", payload).target;
  const sessionManager = {};
  const issued = issueWorkflowAuthorizationTokenV1(sessionManager, "tracker_mutation", [target]);
  fetchCalls = 0;
  const consumedResult = await invoke("cards/update", payload, { cwd: process.cwd(), sessionManager, mode: "json", hasUI: false }, issued.authorizationToken);
  assert.equal(fetchCalls, 1, "one exact matching token must permit one dispatch");
  assert.deepEqual(consumedResult.details.authorizationProvenance, [{
    authoritySource: "authorization_token_consumed", action: "tracker_mutation", canonicalTargets: [target], consumed: true,
  }]);
  assert.doesNotMatch(JSON.stringify(consumedResult), new RegExp(issued.authorizationToken));
  fetchCalls = 0;
  const replay = await invoke("cards/update", payload, { cwd: process.cwd(), sessionManager, mode: "json", hasUI: false }, issued.authorizationToken);
  assert.equal(fetchCalls, 0, "replay must fail before dispatch");
  assert.match(replay.content[0].text, /authorization_token_replayed/);

  for (const [label, token, scope] of [
    ["wrong action", issueWorkflowAuthorizationTokenV1(sessionManager, "commit", [target]).authorizationToken, sessionManager],
    ["wrong target", issueWorkflowAuthorizationTokenV1(sessionManager, "tracker_mutation", [`${target}-other`]).authorizationToken, sessionManager],
    ["wrong session", issueWorkflowAuthorizationTokenV1({}, "tracker_mutation", [target]).authorizationToken, sessionManager],
    ["expired", issueWorkflowAuthorizationTokenV1(sessionManager, "tracker_mutation", [target], 0).authorizationToken, sessionManager],
  ] as const) {
    fetchCalls = 0;
    await invoke("cards/update", payload, { cwd: process.cwd(), sessionManager: scope, mode: "json", hasUI: false }, token);
    assert.equal(fetchCalls, 0, `${label} must fail before dispatch`);
  }
  assert.throws(() => issueWorkflowAuthorizationTokenV1(sessionManager, "tracker_mutation", []), /at least one exact target/);
  assert.throws(() => issueWorkflowAuthorizationTokenV1(sessionManager, "tracker_mutation", [" "]), /non-empty/);

  // A timeout or retryable response after a non-idempotent dispatch is
  // ambiguous: the consumed token must never fan out into a retry.
  for (const responseKind of ["timeout", "retryable"] as const) {
    fetchCalls = 0;
    const retrySession = {};
    const retryPayload = payloadFor("cards/update");
    const retryTarget = classifyCodecksDispatchMutationV1("test-account", "cards/update", retryPayload).target;
    const retryToken = issueWorkflowAuthorizationTokenV1(retrySession, "tracker_mutation", [retryTarget]);
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (responseKind === "timeout") throw new Error("mock timeout after request started");
      return new Response("retry later", { status: 503, statusText: "Unavailable" });
    }) as typeof fetch;
    const retryResult = await invoke("cards/update", retryPayload, {
      cwd: process.cwd(), sessionManager: retrySession, mode: "json", hasUI: false,
    }, retryToken.authorizationToken);
    assert.equal(fetchCalls, 1, `${responseKind} mutation must make exactly one remote attempt per token`);
    assert.match(retryResult.content[0].text, /timed out|503/);
  }

  // Read-only query retries remain enabled.
  fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return fetchCalls === 1
      ? new Response("retry later", { status: 503, statusText: "Unavailable" })
      : new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  await query.execute("query-retry", { query: { _root: [] } }, new AbortController().signal, undefined, {
    cwd: process.cwd(), sessionManager: {}, mode: "json", hasUI: false,
  });
  assert.equal(fetchCalls, 2, "read-only Codecks queries retain transparent retry behavior");

  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  fetchCalls = 0;
  const unknownTarget = classifyCodecksDispatchMutationV1("test-account", "custom/write", { id: "x" }).target;
  const unknownToken = issueWorkflowAuthorizationTokenV1(sessionManager, "tracker_mutation", [unknownTarget]);
  await invoke("custom/write", { id: "x" }, { cwd: process.cwd(), sessionManager, mode: "json", hasUI: false }, unknownToken.authorizationToken);
  assert.equal(fetchCalls, 0, "unclassified raw mutation must reject token-only execution");
  let rawConfirmed = false;
  await invoke("custom/write", { id: "x" }, {
    cwd: process.cwd(), sessionManager: {}, mode: "rpc", hasUI: true,
    ui: { async confirm() { rawConfirmed = true; return true; } },
  });
  assert.equal(rawConfirmed, true);
  assert.equal(fetchCalls, 1, "unclassified raw mutation may run only after direct confirmation");

  const temp = await mkdtemp(path.join(os.tmpdir(), "pi-codecks-auth-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "pi-codecks-outside-"));
  try {
    const insideA = path.join(temp, "a", "proof.txt");
    const insideB = path.join(temp, "b", "proof.txt");
    const outsideFile = path.join(outside, "proof.txt");
    await mkdir(path.dirname(insideA), { recursive: true });
    await mkdir(path.dirname(insideB), { recursive: true });
    await writeFile(insideA, "proof-a");
    await writeFile(insideB, "proof-a");
    await writeFile(outsideFile, "outside-proof");

    fetchCalls = 0;
    await assert.rejects(attachment.execute("attachment-token", { cardId: CARD_ID, filePath: insideA, authorizationToken: "one-use-fixture" }, new AbortController().signal, undefined, {
      cwd: temp, sessionManager: {}, mode: "json", hasUI: false,
    }), /multiple remote mutation attempts.*cannot use one authorizationToken/);
    assert.equal(fetchCalls, 0, "one token must not fan out across the compound attachment workflow");

    const sourceA = await codecksTest.snapshotAttachmentSource(insideA, temp);
    const sourceB = await codecksTest.snapshotAttachmentSource(insideB, temp);
    const targetA = codecksAttachmentMutationTargetV1("test-account", CARD_ID, sourceA);
    const targetB = codecksAttachmentMutationTargetV1("test-account", CARD_ID, sourceB);
    assert.notEqual(targetA.target, targetB.target, "same-basename files with distinct canonical identities/content must bind distinct targets");
    assert.doesNotMatch(targetA.target, new RegExp(sourceA.sha256), "target must not disclose the content digest");

    fetchCalls = 0;
    await assert.rejects(attachment.execute("attachment-outside", { cardId: CARD_ID, filePath: outsideFile }, new AbortController().signal, undefined, {
      cwd: temp, sessionManager: {}, mode: "json", hasUI: false,
    }), /external_attachment_direct_confirmation_required/);
    assert.equal(fetchCalls, 0, "non-UI outside-workspace upload must have zero network side effects");

    const outsideConfirmations: string[] = [];
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("signing unavailable", { status: 503, statusText: "Unavailable" });
    }) as typeof fetch;
    await assert.rejects(attachment.execute("attachment-outside-direct", { cardId: CARD_ID, filePath: outsideFile }, new AbortController().signal, undefined, {
      cwd: temp, sessionManager: {}, mode: "rpc", hasUI: true,
      ui: { async confirm(_title: string, message: string) { outsideConfirmations.push(message); return true; } },
    }), /upload signing failed 503/);
    assert.equal(fetchCalls, 1, "outside direct confirmation may proceed to one non-retried signing request");
    assert.match(outsideConfirmations[0], new RegExp(path.resolve(outsideFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(outsideConfirmations[0], /Source size: 13 bytes/);
    assert.equal(outsideConfirmations.length, 2, "external-source approval is separate from mutation-attempt authorization");

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
      await assert.rejects(attachment.execute("attachment-escape", { cardId: CARD_ID, filePath: path.join(escapeDir, "proof.txt") }, new AbortController().signal, undefined, {
        cwd: temp, sessionManager: {}, mode: "tui", hasUI: true, ui: { async confirm() { return true; } },
      }), /attachment_symlink_escape/);
      assert.equal(fetchCalls, 0, "symlink/junction escape must be rejected before network access");
    }

    let uploadMutationCalls = 0;
    fetchCalls = 0;
    globalThis.fetch = (async (input, init) => {
      fetchCalls += 1;
      const url = String(input);
      if (url.includes("/s3/sign")) {
        await writeFile(insideA, "changed-after-authorization");
        return new Response(JSON.stringify({ signedUrl: "https://upload.test/object", fields: { key: "fixture" }, publicUrl: "https://cdn.test/proof.txt" }), { status: 200 });
      }
      if (url === "https://upload.test/object" || url.includes("/dispatch/")) uploadMutationCalls += 1;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }) as typeof fetch;
    const changeConfirmations: string[] = [];
    await assert.rejects(attachment.execute("attachment-change", { cardId: CARD_ID, filePath: insideA }, new AbortController().signal, undefined, {
      cwd: temp, sessionManager: {}, mode: "tui", hasUI: true,
      ui: { async confirm(_title: string, message: string) { changeConfirmations.push(message); return true; } },
    }), /changed after authorization/);
    assert.equal(fetchCalls, 1, "TOCTOU fixture may request signing once but must not continue");
    assert.equal(uploadMutationCalls, 0, "changed file must cause zero upload/dispatch mutation attempts");
    assert.match(changeConfirmations[0], new RegExp(sourceA.canonicalPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(changeConfirmations[0], /Source size: 7 bytes/);
    assert.doesNotMatch(changeConfirmations[0], /[a-f0-9]{64}/i, "agent-facing confirmation must not disclose the content SHA-256");

    await writeFile(insideA, "proof-a");
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
    const successConfirmations: string[] = [];
    const successResult = await attachment.execute("attachment-success", { cardId: CARD_ID, filePath: insideA, format: "json" }, new AbortController().signal, undefined, {
      cwd: temp, sessionManager: {}, mode: "tui", hasUI: true,
      ui: { async confirm(_title: string, message: string) { successConfirmations.push(message); return true; } },
    });
    assert.equal(successfulMutationUrls.length, 2, "compound attachment performs one upload and one card mutation");
    assert.equal(successConfirmations.length, 2, "each attachment mutation attempt requires its own direct confirmation");
    assert.doesNotMatch(JSON.stringify(successResult), /[a-f0-9]{64}/i, "attachment results must not disclose content SHA-256");
  } finally {
    await rm(temp, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }

  console.log("Codecks mutation authorization sink tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
