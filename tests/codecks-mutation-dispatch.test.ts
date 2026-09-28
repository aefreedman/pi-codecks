import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerCodecks from "../index.ts";
import * as core from "../src/codecks-core.ts";
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
  "codecks_card_add_attachment", "codecks_card_update_status", "codecks_card_reply_resolvable",
];
for (const name of mutationToolNames) {
  assert.equal(tools.get(name)?.parameters?.properties?.authorizationToken, undefined, `${name} must not expose authorizationToken`);
}

await tools.get("codecks_profile_select")!.execute("fixture", { profile: "PERSONAL", scope: "session" });
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

  fetchCalls = 0;
  globalThis.fetch = (async () => { fetchCalls++; return new Response(JSON.stringify({ error: "rate_limit" }), { status: 429 }); }) as typeof fetch;
  const limited = structured(await invoke("cards/update", payloadFor("cards/update"))).error;
  assert.equal(fetchCalls, 1, "a rejected mutation is never retried");
  assert.equal(limited.httpStatus, 429);
  assert.equal(limited.requestsAttempted, 1);
  assert.equal(limited.dispatchAttempt, "http_response");
  assert.equal(limited.mutationCertainty, "definitely_rejected");

  console.log("Codecks direct mutation dispatch tests passed");
} finally {
  globalThis.fetch = originalFetch;
}
