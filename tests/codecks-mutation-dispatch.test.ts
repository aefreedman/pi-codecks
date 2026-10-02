import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerCodecks from "../index.ts";
import * as core from "../src/codecks-core.ts";
import { executeLegacyCardWrite } from "../src/tools/cards/cards-write-output.ts";
import { Value } from "typebox/value";
import { CARD_WRITE_OUTPUT_SCHEMAS } from "../src/tools/cards/cards-write-output.ts";
const codecksTest = core.__test;
import { useInertEnvironmentCredentialProvider } from "./credential-test-environment.ts";
import { formatLiveErrorEvidence } from "./live-error-evidence.ts";

useInertEnvironmentCredentialProvider();
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
  "codecks_card_add_attachment", "codecks_card_update_status", "codecks_card_add_to_hand", "codecks_card_remove_from_hand", "codecks_card_reply_resolvable",
];
for (const name of mutationToolNames) {
  assert.equal(tools.get(name)?.parameters?.properties?.authorizationToken, undefined, `${name} must not expose authorizationToken`);
}

await tools.get("codecks_profile_select")!.execute("fixture", { profile: "PERSONAL", scope: "session" });
const dispatch = tools.get("codecks_dispatch")!;
const query = tools.get("codecks_query")!;
const attachment = tools.get("codecks_card_add_attachment")!;
function assertAttachmentFailure(result: any, diagnostic: RegExp, signing: string) {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(Value.Check(CARD_WRITE_OUTPUT_SCHEMAS.card_add_attachment, result.structuredContent), true);
  assert.match(result.content[0].text, diagnostic);
  assert.match(result.structuredContent.error.message, diagnostic);
  assert.equal(result.structuredContent.effects.certainty, "definitely_unsent");
  assert.equal(result.structuredContent.effects.dispatchInvoked, false);
  assert.equal(result.structuredContent.effects.readback, "not_performed");
  assert.equal(result.structuredContent.effects.replay, "not_authorized");
  if (result.structuredContent.effects.upload) {
    assert.equal(result.structuredContent.effects.upload.signing, signing);
    assert.equal(result.structuredContent.effects.upload.storage, "not_attempted");
    assert.equal(result.structuredContent.effects.upload.registration, "not_attempted");
  } else assert.equal(signing, "not_attempted");
}
async function assertLegacyAttachmentFailure(args: Record<string, unknown>, cwd: string, diagnostic: RegExp) {
  const tool = core.card_add_attachment;
  const saved = tool.executePayload;
  let originalError: unknown;
  let calls = 0;
  // The core execute uses this exact bridge and producer. Capture its original
  // error in one invocation under matching canonical cwd/profile context.
  const operation = (input: any, callback?: (error: unknown) => void) => {
    calls++;
    return (saved as any)(input, (error: unknown) => { originalError = error; callback?.(error); });
  };
  try {
    await assert.rejects(() => core.runWithAbortSignal(undefined, () => executeLegacyCardWrite(operation, args), cwd, undefined, "PERSONAL"), error => {
      assert.strictEqual(error, originalError);
      assert.match(String(error), diagnostic);
      return true;
    });
    assert.equal(calls, 1);
  } finally { tool.executePayload = saved; }
}
const CARD_ID = "11111111-1111-4111-8111-111111111111";
const DISPATCH_PATHS = [
  "cards/create", "cards/update", "cards/addFile", "decks/update", "milestones/update",
  "sprints/updateSprint", "resolvables/create", "resolvables/comment", "resolvables/updateComment",
  "resolvables/close", "resolvables/reopen",
] as const;

const payloadFor = (dispatchPath: string): Record<string, unknown> => {
  switch (dispatchPath) {
    case "cards/create": return { content: "Direct mutation fixture", deckId: "deck-1", assigneeId: null };
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

  const structured = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text.match(/```json\s*([\s\S]*?)```/)![1]);
  for (const responseKind of ["timeout", "retryable", "network"] as const) {
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      if (responseKind === "timeout") throw new Error("mock timeout after request started with cdxat_privatefixture");
      if (responseKind === "network") throw new Error("network failure with cdxat_privatefixture and private host");
      return new Response("retry later", { status: 503, statusText: "Unavailable" });
    }) as typeof fetch;
    const result = await invoke("cards/update", payloadFor("cards/update"));
    assert.equal(fetchCalls, 1, `${responseKind} mutation must make exactly one remote attempt`);
    const failure = structured(result).error;
    assert.equal(failure.mutationCertainty, "indeterminate");
    assert.equal(failure.dispatchAttempt, responseKind === "retryable" ? "http_response" : "outcome_unknown");
    assert.equal(failure.requestsAttempted, 1);
    assert.equal(failure.httpStatus, responseKind === "retryable" ? 503 : undefined);
    assert.doesNotMatch(JSON.stringify(failure), /privatefixture|private host/);
  }

  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; return new Response(JSON.stringify({ error: "unknown_field", message: "'card' has no field 'titel' to filter by", path: "_root.account.cards.titel" }), { status: 400 }); }) as typeof fetch;
  const validation = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.equal(fetchCalls, 1);
  assert.equal(validation.httpStatus, 400);
  assert.equal(validation.apiCode, "unknown_field");
  assert.equal(validation.path, "/dispatch/cards/update");
  assert.equal(validation.apiPath, "_root.account.cards.titel");
  assert.equal(validation.validationMessage, "'card' has no field 'titel' to filter by");
  assert.equal(validation.dispatchAttempt, "http_response");
  assert.equal(validation.mutationCertainty, "definitely_rejected");
  assert.equal(validation.requestsAttempted, 1);
  const liveValidation = JSON.parse(formatLiveErrorEvidence(validation));
  assert.equal(liveValidation.validationMessage, "'card' has no field 'titel' to filter by");
  assert.equal(liveValidation.httpStatus, 400);
  assert.equal(liveValidation.dispatchAttempt, "http_response");
  assert.ok(liveValidation.errorShape.some((item: { path: string }) => item.path === "$.message"));
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unknown_field", message: "Authorization: Bearer cdxat_privatefixture", path: "_root.account?secret=cdxat_privatefixture" }), { status: 400 })) as typeof fetch;
  const unsafe = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.equal(unsafe.validationMessage, undefined);
  assert.equal(unsafe.apiPath, undefined);
  assert.doesNotMatch(JSON.stringify(unsafe), /privatefixture|Authorization/);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "comment_payload_invalid", validation: [{ field: "userId", message: "Missing actor for org token cdxut_synthetic-test-token" }, { field: "cardId", message: "Bad UUID 12345678-1234-1234-1234-123456789abc" }], requestHeaders: { Authorization: "sensitive" } } }), { status: 400 })) as typeof fetch;
  const nested = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.equal(nested.apiCode, "comment_payload_invalid");
  assert.match(nested.validationDetails.join(" "), /userId: Missing actor for org token \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(nested), /synthetic-test-token|12345678-1234|sensitive|requestHeaders/);
  assert.ok(nested.errorShape.some((entry: { path: string; type: string }) => entry.path === "$.error.validation" && entry.type === "array"));
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "Missing userId for comment" }), { status: 400 })) as typeof fetch;
  assert.equal(structured(await invoke("cards/update", payloadFor("cards/update"))).error.validationMessage, "Missing userId for comment");
  globalThis.fetch = (async () => new Response("<html><body>Private cdxat_privatefixture</body></html>", { status: 400 })) as typeof fetch;
  const htmlError = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.equal(htmlError.validationMessage, "HTML error response (details withheld)");
  assert.doesNotMatch(JSON.stringify(htmlError), /privatefixture|<body>/);
  globalThis.fetch = (async () => new Response("Missing actor userId cdxat_privatefixture\u001b[31m", { status: 400 })) as typeof fetch;
  const textError = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.match(textError.validationMessage, /^Missing actor userId \[REDACTED\]/);
  assert.doesNotMatch(JSON.stringify(textError), /privatefixture|\\u001b/);
  const untrustedLiveError = formatLiveErrorEvidence({ category: "api_error", message: "private body", path: "/dispatch/cards/update", authorization: "Bearer cdxat_privatefixture", apiPath: "_root.account.cdxat_privatefixture", requiredScope: "cdxat_privatefixture", validationMessage: "token cdxat_privatefixture", httpStatus: 403, mutationCertainty: "indeterminate" });
  assert.deepEqual(JSON.parse(untrustedLiveError), { category: "api_error", httpStatus: 403, mutationCertainty: "indeterminate" });
  assert.match(formatLiveErrorEvidence(nested), /userId: Missing actor for org token \[REDACTED\]/);
  assert.doesNotMatch(untrustedLiveError, /privatefixture|Bearer|private body/);

  let commentRequests = 0;
  globalThis.fetch = (async (input, init) => {
    commentRequests++;
    const url = String(input);
    if (url.endsWith("/dispatch/resolvables/create")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.userId, "user-1", "PERSONAL comment retains explicit own human identity");
      return new Response(JSON.stringify({ error: "missing_scope", requiredScope: "comment:write", path: "_root.account.cards" }), { status: 403 });
    }
    if (commentRequests === 1) return new Response(JSON.stringify({ data: { [`card(${CARD_ID})`]: CARD_ID, card: { [CARD_ID]: { cardId: CARD_ID, title: "Synthetic" } } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { _root: { loggedInUser: "user-1" }, user: { "user-1": { id: "user-1", name: "Fixture" } } } }), { status: 200 });
  }) as typeof fetch;
  const commentError = structured(await tools.get("codecks_card_add_comment")!.execute("comment-evidence", { cardId: CARD_ID, content: "synthetic", format: "json" }, new AbortController().signal, undefined, directContext())).error;
  assert.equal(commentRequests, 3, "PERSONAL comment reads card and own identity, then dispatches exactly once");
  assert.equal(commentError.category, "missing_scope");
  assert.equal(commentError.httpStatus, 403);
  assert.equal(commentError.requiredScope, "comment:write");
  assert.equal(commentError.path, "/dispatch/resolvables/create");
  assert.equal(commentError.dispatchAttempt, "http_response");
  assert.equal(commentError.mutationCertainty, "definitely_rejected");

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
    const outsideResult = await attachment.execute("attachment-outside", { cardId: CARD_ID, filePath: outsideFile }, new AbortController().signal, undefined, directContext(temp));
    assertAttachmentFailure(outsideResult, /attachment_outside_workspace/, "not_attempted");
    await assertLegacyAttachmentFailure({ cardId: CARD_ID, filePath: outsideFile }, temp, /attachment_outside_workspace/);
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
      const escapeArgs = { cardId: CARD_ID, filePath: path.join(escapeDir, "proof.txt") };
      const escapeResult = await attachment.execute("attachment-escape", escapeArgs, new AbortController().signal, undefined, directContext(temp));
      assertAttachmentFailure(escapeResult, /attachment_symlink_escape/, "not_attempted");
      await assertLegacyAttachmentFailure(escapeArgs, temp, /attachment_symlink_escape/);
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
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: "user-1" }, user: { "user-1": { id: "user-1", name: "Fixture" } } } }), { status: 200 });
    }) as typeof fetch;
    const changeResult = await attachment.execute("attachment-change", { cardId: CARD_ID, filePath: inside }, new AbortController().signal, undefined, directContext(temp));
    assertAttachmentFailure(changeResult, /changed after inspection/, "returned");
    assert.equal(fetchCalls, 2, "TOCTOU fixture reads actor and may sign once but cannot upload changed bytes");
    assert.equal(uploadOrDispatchCalls, 0, "changed files cause no upload or card mutation");
    await writeFile(inside, "proof-a");
    fetchCalls = 0;
    await assertLegacyAttachmentFailure({ cardId: CARD_ID, filePath: inside }, temp, /changed after inspection/);
    assert.equal(fetchCalls, 2, "legacy TOCTOU also reads actor/signs once");
    assert.equal(uploadOrDispatchCalls, 0, "neither interface dispatches/uploads changed bytes");

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

  process.env.CODECKS_PROFILE_ORG_TOKEN = "cdxat_synthetic-test-token";
  const orgExecute = (action: { execute: (args: any) => Promise<unknown> }, args: Record<string, unknown>) =>
    core.runWithAbortSignal(undefined, () => action.execute(args), undefined, undefined, "ORG");
  const orgStructured = async (action: { execute: (args: any) => Promise<unknown> }, args: Record<string, unknown>) =>
    structured({ content: [{ text: String(await orgExecute(action, { ...args, format: "json" })) }] });
  const orgActorId = "api-token-actor-1";
  let orgRequests = 0;
  globalThis.fetch = (async (input, init) => {
    orgRequests++;
    const url = String(input);
    if (url.endsWith("/dispatch/resolvables/create")) {
      const payload = JSON.parse(String(init?.body));
      assert.equal(payload.userId, orgActorId);
      assert.notEqual(payload.userId, "human-assignee-1");
      assert.equal(payload.context, "comment");
      return new Response(JSON.stringify({ data: { id: "thread-1" } }), { status: 200 });
    }
    if (orgRequests === 1) return new Response(JSON.stringify({ data: { [`card(${CARD_ID})`]: CARD_ID, card: { [CARD_ID]: { cardId: CARD_ID, title: "Synthetic", assigneeId: "human-assignee-1" } } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
  }) as typeof fetch;
  const orgComment = await orgStructured(core.card_add_comment, { cardId: CARD_ID, content: "synthetic-org" });
  assert.equal(orgComment.ok, true);
  assert.equal(orgRequests, 3, "verified ORG actor makes two reads then exactly one comment write");
  orgRequests = 0;
  const directOrg = (await orgStructured(core.dispatch, { path: "resolvables/create", payload: { cardId: CARD_ID, context: "comment", sessionId: "11111111-1111-1111-1111-111111111111", content: "direct", userId: orgActorId } })).error;
  assert.equal(directOrg.category, "org_actor_unverified", "model-facing direct dispatch remains guarded");
  assert.equal(orgRequests, 0);
  let malformedCalls = 0;
  globalThis.fetch = (async () => {
    malformedCalls++;
    if (malformedCalls === 1) return new Response(JSON.stringify({ data: { [`card(${CARD_ID})`]: CARD_ID, card: { [CARD_ID]: { cardId: CARD_ID, title: "Synthetic" } } } }), { status: 200 });
    return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: false } } } }), { status: 200 });
  }) as typeof fetch;
  const badActor = (await orgStructured(core.card_add_comment, { cardId: CARD_ID, content: "synthetic-org-unverified" })).error;
  assert.equal(badActor.category, "org_actor_unverified");
  assert.equal(malformedCalls, 2, "unverified ORG identity never dispatches");

  const orgUploadRoot = await mkdtemp(path.join(os.tmpdir(), "pi-codecks-org-upload-"));
  try {
    const sourceFile = path.join(orgUploadRoot, "harmless.txt");
    await writeFile(sourceFile, "harmless test bytes");
    const stages: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/s3/sign")) {
        stages.push("sign");
        return new Response(JSON.stringify({ signedUrl: "https://upload.test/org", fields: { key: "fixture" }, publicUrl: "https://cdn.test/harmless.txt" }), { status: 200 });
      }
      if (url === "https://upload.test/org") {
        stages.push("upload");
        assert.equal(new Headers(init?.headers).has("Authorization"), false, "signed storage must never receive Codecks auth");
        return new Response("", { status: 200 });
      }
      if (url.includes("/dispatch/cards/addFile")) {
        stages.push("register");
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.userId, orgActorId);
        assert.equal(payload.cardId, CARD_ID);
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }
      stages.push("actor");
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
    }) as typeof fetch;
    const attachmentResult = structured({ content: [{ text: String(await core.runWithAbortSignal(undefined, () => core.card_add_attachment.execute({ cardId: CARD_ID, filePath: sourceFile, format: "json" }), orgUploadRoot, undefined, "ORG")) }] });
    assert.equal(attachmentResult.ok, true);
    assert.deepEqual(stages, ["actor", "sign", "upload", "register"]);
    stages.length = 0;
    globalThis.fetch = (async (input) => {
      if (String(input).includes("/s3/sign")) { stages.push("sign-rejected"); return new Response(JSON.stringify({ error: "missing_scope", requiredScope: "file:write" }), { status: 403 }); }
      stages.push("actor");
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
    }) as typeof fetch;
    const signFailure = structured({ content: [{ text: String(await core.runWithAbortSignal(undefined, () => core.card_add_attachment.execute({ cardId: CARD_ID, filePath: sourceFile, format: "json" }), orgUploadRoot, undefined, "ORG")) }] });
    assert.equal(signFailure.error.category, "missing_scope");
    assert.equal(signFailure.error.httpStatus, 403);
    assert.equal(signFailure.error.uploadStage, "sign");
    assert.deepEqual(stages, ["actor", "sign-rejected"], "denied sign must never upload or register");
    stages.length = 0;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/s3/sign")) { stages.push("sign"); return new Response(JSON.stringify({ signedUrl: "https://upload.test/org", fields: { key: "fixture" }, publicUrl: "https://cdn.test/harmless.txt" }), { status: 200 }); }
      if (url === "https://upload.test/org") { stages.push("upload-rejected"); return new Response("private storage error cdxat_synthetic-test-token", { status: 500 }); }
      stages.push("actor");
      return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
    }) as typeof fetch;
    const storageFailure = structured({ content: [{ text: String(await core.runWithAbortSignal(undefined, () => core.card_add_attachment.execute({ cardId: CARD_ID, filePath: sourceFile, format: "json" }), orgUploadRoot, undefined, "ORG")) }] });
    assert.equal(storageFailure.error.uploadStage, "storage");
    assert.equal(storageFailure.error.mutationCertainty, "indeterminate");
    assert.doesNotMatch(JSON.stringify(storageFailure), /private storage error|synthetic-test-token/);
    assert.deepEqual(stages, ["actor", "sign", "upload-rejected"], "storage rejection must never register or retry");
  } finally { await rm(orgUploadRoot, { recursive: true, force: true }); }

  const threadId = "resolvable-1";
  const entryId = "entry-1";
  const sharedDispatches: string[] = [];
  let threadClosed = false;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/")) {
      const operation = url.split("/dispatch/")[1];
      const payload = JSON.parse(String(init?.body));
      sharedDispatches.push(operation);
      if (operation === "resolvables/create") { assert.equal(payload.userId, orgActorId); assert.ok(["review", "block"].includes(payload.context)); }
      if (operation === "resolvables/comment" || operation === "resolvables/updateComment") assert.equal(payload.authorId, orgActorId);
      if (operation === "resolvables/close") { assert.equal(payload.closedBy, orgActorId); threadClosed = true; }
      if (operation === "resolvables/reopen") threadClosed = false;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    const query = JSON.parse(String(init?.body)).query;
    if (query._root) return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
    const key = Object.keys(query)[0];
    if (key.startsWith("resolvableEntry(")) return new Response(JSON.stringify({ data: { [key]: entryId, resolvableEntry: { [entryId]: { entryId, author: orgActorId, content: "old", version: 1, resolvable: threadId } }, resolvable: { [threadId]: { id: threadId, card: CARD_ID, context: "review" } }, card: { [CARD_ID]: { cardId: CARD_ID, title: "Synthetic" } }, user: { [orgActorId]: { id: orgActorId, name: "Token Actor" } } } }), { status: 200 });
    if (key.startsWith("resolvable(")) return new Response(JSON.stringify({ data: { [key]: threadId, resolvable: { [threadId]: { id: threadId, card: CARD_ID, context: "review", isClosed: threadClosed, entries: [] } }, card: { [CARD_ID]: { cardId: CARD_ID, title: "Synthetic" } } } }), { status: 200 });
    if (key.startsWith("card(")) return new Response(JSON.stringify({ data: { [key]: CARD_ID, card: { [CARD_ID]: { cardId: CARD_ID, title: "Synthetic", resolvables: [] } } } }), { status: 200 });
    throw new Error("unexpected synthetic query");
  }) as typeof fetch;
  for (const [action, args] of [
    [core.card_add_review, { cardId: CARD_ID, content: "review" }],
    [core.card_add_blocker, { cardId: CARD_ID, content: "blocker" }],
    [core.card_reply_resolvable, { resolvableId: threadId, content: "reply" }],
    [core.card_edit_resolvable_entry, { entryId, content: "edited" }],
    [core.card_close_resolvable, { resolvableId: threadId }],
    [core.card_reopen_resolvable, { resolvableId: threadId }],
  ] as const) {
    const result = await orgStructured(action, args);
    assert.equal(result.ok, true, `${result.action} must accept only the authenticated ORG actor`);
  }
  assert.deepEqual(sharedDispatches, ["resolvables/create", "resolvables/create", "resolvables/comment", "resolvables/updateComment", "resolvables/close", "resolvables/reopen"]);
  const guardedDirect = await orgStructured(core.dispatch, { path: "cards/addFile", payload: { cardId: CARD_ID, userId: orgActorId, fileData: { fileName: "bypass.txt", url: "https://example.invalid/bypass", size: 6, type: "text/plain" } } });
  assert.equal(guardedDirect.error?.category, "org_actor_unverified", "direct ORG attachment registration remains guarded");
  assert.equal(sharedDispatches.length, 6);

  const humanId = "22222222-2222-4222-8222-222222222222";
  const dispatchedCreates: Array<Record<string, unknown>> = [];
  let fixtureQueries = 0;
  globalThis.fetch = (async (input, init) => {
    if (String(input).includes("/dispatch/")) {
      if (String(input).includes("/dispatch/cards/create")) {
        const payload = JSON.parse(String(init?.body));
        dispatchedCreates.push(payload);
        return new Response(JSON.stringify({ data: { cardId: `created-${dispatchedCreates.length}` } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    fixtureQueries++;
    const query = JSON.parse(String(init?.body)).query;
    if (query._root?.[0]?.loggedInUser) return new Response(JSON.stringify({ data: { _root: { loggedInUser: humanId }, user: { [humanId]: { id: humanId, name: "Human" } } } }), { status: 200 });
    const key = Object.keys(query).find(item => item.startsWith("user("));
    if (key) return new Response(JSON.stringify({ data: { [key]: humanId, user: { [humanId]: { id: humanId, name: "Human", kind: "human", isIntegration: false } } } }), { status: 200 });
    throw new Error("unexpected synthetic query");
  }) as typeof fetch;
  const deckedUnassigned = await orgStructured(core.card_create, { title: "Decked unassigned", deck: 42 });
  assert.equal(deckedUnassigned.ok, true);
  assert.equal(dispatchedCreates.at(-1)?.assigneeId, null);
  assert.equal(dispatchedCreates.at(-1)?.deckId, "42");
  assert.equal(dispatchedCreates.at(-1)?.userId, undefined, "ORG actor is not the assignee");
  const decklessAssigned = await orgStructured(core.card_create, { title: "Deckless assigned", assigneeId: humanId });
  assert.equal(decklessAssigned.ok, true);
  assert.equal(dispatchedCreates.at(-1)?.deckId, null);
  assert.equal(dispatchedCreates.at(-1)?.assigneeId, humanId);
  assert.equal(dispatchedCreates.at(-1)?.userId, undefined);
  const countBeforeInvalid = dispatchedCreates.length;
  const invalidCreate = await orgStructured(core.card_create, { title: "Invalid no location or assignee" });
  assert.equal(invalidCreate.error?.category, "validation_error");
  assert.match(invalidCreate.error?.message, /unassigned and deckless/);
  const handCreate = await orgStructured(core.card_create, { title: "No inferred hand", deck: 42, assigneeId: humanId, putOnHand: true });
  assert.equal(handCreate.error?.category, "org_actor_unverified");
  assert.equal(dispatchedCreates.length, countBeforeInvalid);
  const bulkCards = [{ title: "Decked unassigned bulk", deck: 42 }, { title: "Deckless assigned bulk", assigneeId: humanId }];
  const bulkPreview = await orgStructured(core.card_bulk_create, { cards: bulkCards, dryRun: true });
  assert.equal(bulkPreview.ok, true);
  const previewRecords = JSON.parse(await readFile(bulkPreview.data.artifact.path, "utf8")).results;
  assert.equal(previewRecords[0].normalizedRequested.assignee, null);
  assert.equal(previewRecords[1].normalizedRequested.assignee.id, humanId);
  const bulkApply = await orgStructured(core.card_bulk_create, { cards: bulkCards, dryRun: false, expectedPreviewFingerprint: bulkPreview.data.previewFingerprint });
  assert.equal(bulkApply.ok, true);
  assert.equal(bulkApply.data.created, 2);
  assert.equal(dispatchedCreates.at(-2)?.assigneeId, null);
  assert.equal(dispatchedCreates.at(-1)?.deckId, null);
  const beforeBulkInvalid = dispatchedCreates.length;
  const invalidBulk = await orgStructured(core.card_bulk_create, { cards: [{ title: "Invalid both absent" }], dryRun: true });
  assert.equal(invalidBulk.error?.category, "validation_error");
  assert.match(invalidBulk.error?.message, /unassigned and deckless/);
  assert.equal(dispatchedCreates.length, beforeBulkInvalid);
  const guardedBulkHand = await orgStructured(core.card_bulk_create, { cards: [{ title: "No inferred hand bulk", deck: 42, assigneeId: humanId, putOnHand: true }], dryRun: true });
  assert.equal(guardedBulkHand.error?.category, "org_actor_unverified");
  assert.equal(dispatchedCreates.length, beforeBulkInvalid);
  const personalCreate = structured({ content: [{ text: String(await core.runWithAbortSignal(undefined, () => core.card_create.execute({ title: "Personal default", format: "json" }), undefined, undefined, "PERSONAL")) }] });
  assert.equal(personalCreate.ok, true, "PERSONAL default self-assignment remains supported");
  assert.equal(dispatchedCreates.at(-1)?.assigneeId, humanId);

  const producerWrites: string[] = [];
  globalThis.fetch = (async (input) => {
    producerWrites.push(String(input));
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }) as typeof fetch;
  for (const path of ["decks/update", "milestones/update", "sprints/updateSprint"]) {
    assert.equal((await orgStructured(core.dispatch, { path, payload: { id: "synthetic", description: "producer fixture" } })).ok, true);
  }
  assert.equal(producerWrites.length, 3, "existing producer-like update endpoints have no token-kind prohibition");

  let handReads = 0;
  globalThis.fetch = (async () => { handReads++; throw new Error("missing-target guard must precede remote read"); }) as typeof fetch;
  const ownOrgHand = await orgStructured(core.card_search, { location: "hand" });
  assert.equal(ownOrgHand.error?.category, "validation_error");
  assert.match(ownOrgHand.error?.message, /explicit human userId/);
  const ownOrgBookmarks = await orgStructured(core.card_search, { location: "bookmarks" });
  assert.equal(ownOrgBookmarks.error?.category, "validation_error");
  assert.equal(handReads, 0);
  const queueTargets: string[] = [];
  const handQueries: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query;
    const userKey = Object.keys(query).find(key => key.startsWith("user("));
    if (userKey) { queueTargets.push(userKey); return new Response(JSON.stringify({ data: { [userKey]: humanId, user: { [humanId]: { id: humanId, name: "Named Human", kind: "human", isIntegration: false } } } }), { status: 200 }); }
    if (query._root?.[0]?.loggedInUser) return new Response(JSON.stringify({ data: { _root: { loggedInUser: humanId }, user: { [humanId]: { id: humanId, name: "Named Human" } } } }), { status: 200 });
    handQueries.push(JSON.stringify(query));
    return new Response(JSON.stringify({ data: { _root: { account: "account-1" }, account: { "account-1": { id: "account-1", queueEntries: [] } } } }), { status: 200 });
  }) as typeof fetch;
  const namedHand = await orgStructured(core.card_search, { location: "hand", userId: humanId });
  assert.equal(namedHand.ok, true);
  assert.equal(queueTargets.length, 1, "ORG resolves the exact named human before querying a hand");
  assert.equal(handQueries.length, 1);
  assert.match(handQueries[0], new RegExp(humanId));
  const namedEffort = await orgStructured(core.card_list_missing_effort, { location: "hand", userId: humanId });
  assert.equal(namedEffort.ok, true);
  const personalHand = structured({ content: [{ text: String(await core.runWithAbortSignal(undefined, () => core.card_search.execute({ location: "hand", format: "json" }), undefined, undefined, "PERSONAL")) }] });
  assert.equal(personalHand.ok, true, "PERSONAL still reads its own hand without a target argument");
  const handReadCount = handQueries.length;
  globalThis.fetch = (async (_input, init) => {
    const query = JSON.parse(String(init?.body)).query;
    const key = Object.keys(query)[0];
    if (key.startsWith("user(")) return new Response(JSON.stringify({ data: { [key]: humanId, user: { [humanId]: { id: humanId, name: "Token", kind: "api_token", isIntegration: true } } } }), { status: 200 });
    throw new Error("invalid target must not query queueEntries");
  }) as typeof fetch;
  const invalidTarget = await orgStructured(core.card_search, { location: "hand", userId: humanId });
  assert.equal(invalidTarget.error?.category, "api_error");
  assert.equal(handQueries.length, handReadCount);

  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; return new Response(JSON.stringify({ error: "rate_limit" }), { status: 429 }); }) as typeof fetch;
  const limited = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.equal(fetchCalls, 1, "a rejected mutation is never retried");
  assert.equal(limited.httpStatus, 429);
  assert.equal(limited.requestsAttempted, 1);
  assert.equal(limited.dispatchAttempt, "http_response");
  assert.equal(limited.mutationCertainty, "definitely_rejected");

  const handCardId = "33333333-3333-4333-8333-333333333333";
  const oldHand = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
  let activeHand = [...oldHand];
  let handPageFull = false;
  let handDrift = false;
  let handReject = false;
  let handUncertain = false;
  let handReadsForAction = 0;
  const handWrites: Array<{ path: string; payload: Record<string, any> }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input), body = JSON.parse(String(init?.body));
    if (url.includes("/dispatch/")) {
      const path = url.split("/dispatch/")[1];
      handWrites.push({ path, payload: body });
      if (handUncertain) return new Response(JSON.stringify({ error: "private hand token value must not leak" }), { status: 503 });
      if (handReject) return new Response(JSON.stringify({ error: "missing_scope", requiredScope: "hand:write", path }), { status: 403 });
      if (path === "handQueue/setCardOrders") activeHand = [...body.cardIds];
      if (path === "handQueue/removeCards") activeHand = activeHand.filter(id => !body.cardIds.includes(id));
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    const q = body.query, key = Object.keys(q)[0];
    if (key.startsWith("user(")) return new Response(JSON.stringify({ data: { [key]: humanId, user: { [humanId]: { id: humanId, name: "Human", kind: "human", isIntegration: false } } } }), { status: 200 });
    if (key.startsWith("card(")) return new Response(JSON.stringify({ data: { [key]: handCardId, card: { [handCardId]: { cardId: handCardId, accountSeq: 99, title: "Synthetic" } } } }), { status: 200 });
    if (q._root?.[0]?.loggedInUser) return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
    const accountQuery = q._root?.[0]?.account?.[0];
    if (accountQuery && Object.keys(accountQuery)[0].startsWith("queueEntries(")) {
      handReadsForAction++;
      if (handDrift && handReadsForAction === 2) activeHand = [...activeHand].reverse();
      const ids = handPageFull ? Array.from({ length: 500 }, (_, i) => `page-${i}`) : activeHand;
      const queueEntry = Object.fromEntries(ids.map((id, i) => [`entry-${i}`, { id: `entry-${i}`, cardId: id, sortIndex: i, user: humanId }]));
      return new Response(JSON.stringify({ data: { queueEntry, user: { [humanId]: { id: humanId } } } }), { status: 200 });
    }
    throw new Error("unexpected hand mock query");
  }) as typeof fetch;
  for (const path of ["handQueue/setCardOrders", "handQueue/removeCards"]) {
    assert.equal((await orgStructured(core.dispatch, { path, payload: { sessionId: "00000000-0000-4000-8000-000000000000", userId: humanId, cardIds: [handCardId], draggedCardIds: [handCardId] } })).error?.category, "org_actor_unverified", "raw hand dispatch must not bypass validation");
  }
  assert.equal(handWrites.length, 0);
  assert.equal((await orgStructured(core.card_add_to_hand, { cardId: handCardId })).error?.category, "validation_error", "ORG has no implicit own hand");
  handPageFull = true;
  assert.match((await orgStructured(core.card_add_to_hand, { cardId: handCardId, userId: humanId })).error?.message ?? "", /incomplete/);
  assert.equal(handWrites.length, 0);
  handPageFull = false;
  handDrift = true;
  handReadsForAction = 0;
  assert.match((await orgStructured(core.card_add_to_hand, { cardId: handCardId, userId: humanId })).error?.message ?? "", /changed between reads/);
  assert.equal(handWrites.length, 0);
  handDrift = false;
  activeHand = [...oldHand];
  handReadsForAction = 0;
  const addedHand = await orgStructured(core.card_add_to_hand, { cardId: handCardId, userId: humanId });
  assert.equal(addedHand.ok, true);
  assert.equal(addedHand.data.readbackConfirmed, true);
  assert.equal(handWrites[0]?.path, "handQueue/setCardOrders");
  assert.deepEqual(handWrites[0]?.payload.cardIds, [...oldHand, handCardId], "full baseline is preserved with only fixture appended");
  assert.deepEqual(handWrites[0]?.payload.draggedCardIds, [handCardId]);
  assert.equal(handWrites[0]?.payload.userId, humanId, "named human is target, not ORG principal");
  assert.match(String(handWrites[0]?.payload.sessionId), /^[a-f0-9-]{36}$/i);
  const removedHand = await orgStructured(core.card_remove_from_hand, { cardId: handCardId, userId: humanId });
  assert.equal(removedHand.ok, true);
  assert.deepEqual(handWrites[1]?.payload.cardIds, [handCardId]);
  assert.equal(handWrites[1]?.payload.userId, humanId);
  assert.equal(handWrites[1]?.payload.draggedCardIds, undefined);
  assert.deepEqual(activeHand, oldHand);
  const beforeAbsentRemove = handWrites.length;
  assert.match((await orgStructured(core.card_remove_from_hand, { cardId: handCardId, userId: humanId })).error?.message ?? "", /not uniquely on the target hand/);
  assert.equal(handWrites.length, beforeAbsentRemove, "remove refuses an absent card without dispatch");
  handReject = true;
  const beforeRejection = handWrites.length;
  const denied = await orgStructured(core.card_add_to_hand, { cardId: handCardId, userId: humanId });
  assert.equal(denied.error?.category, "missing_scope");
  assert.equal(denied.error?.httpStatus, 403);
  assert.equal(denied.error?.mutationCertainty, "definitely_rejected");
  assert.equal(handWrites.length, beforeRejection + 1, "definite rejection is not replayed");
  assert.deepEqual(activeHand, oldHand);
  handReject = false;
  handUncertain = true;
  const beforeUncertain = handWrites.length;
  const uncertain = await orgStructured(core.card_add_to_hand, { cardId: handCardId, userId: humanId });
  assert.equal(uncertain.error?.mutationCertainty, "indeterminate");
  assert.equal(handWrites.length, beforeUncertain + 1, "uncertain hand writes must not be retried");
  assert.doesNotMatch(JSON.stringify(uncertain), /private hand token value must not leak/);
  handUncertain = false;
  let invalidOrderQueries = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/dispatch/")) throw new Error("bad sortIndex must prevent dispatch");
    const q = JSON.parse(String(init?.body)).query;
    const key = Object.keys(q)[0];
    if (key.startsWith("user(")) return new Response(JSON.stringify({ data: { [key]: humanId, user: { [humanId]: { id: humanId, name: "Human" } } } }), { status: 200 });
    if (key.startsWith("card(")) return new Response(JSON.stringify({ data: { [key]: handCardId, card: { [handCardId]: { cardId: handCardId, title: "Synthetic" } } } }), { status: 200 });
    if (q._root?.[0]?.loggedInUser) return new Response(JSON.stringify({ data: { _root: { loggedInUser: orgActorId }, user: { [orgActorId]: { id: orgActorId, kind: "api_token", isIntegration: true } } } }), { status: 200 });
    invalidOrderQueries++;
    return new Response(JSON.stringify({ data: { queueEntry: { first: { id: "first", card_id: oldHand[0], sortIndex: 2, user: humanId }, second: { id: "second", card_id: oldHand[1], sortIndex: 2, user: humanId } }, user: { [humanId]: { id: humanId } } } }), { status: 200 });
  }) as typeof fetch;
  assert.match((await orgStructured(core.card_add_to_hand, { cardId: handCardId, userId: humanId })).error?.message ?? "", /ordering or ownership cannot be verified/);
  assert.equal(invalidOrderQueries, 1, "ambiguous order stops before a second read or write");

  console.log("Codecks direct mutation dispatch tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
