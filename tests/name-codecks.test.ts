import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerNameCodecks } from "../src/pi/name-codecks";
import { getOperationContext, getActiveWorkspaceRoot } from "../src/runtime/operation-context";

test("command validates, reads with selected profile, and only renames the originating session", async () => {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let name = "Original", session = "one", calls = 0;
  let title: unknown = "Card title", fail = false, throws = false, switchSession = false;
  const notices: string[] = [];
  const pi = {
    registerCommand(command: string, options: { handler: typeof handler }) {
      assert.equal(command, "name-codecks"); handler = options.handler;
    },
    setSessionName(value: string) { name = value; },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(), sessionManager: { getSessionId: () => session },
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionCommandContext;
  registerNameCodecks(pi, () => "PERSONAL", async args => {
    calls++;
    assert.equal(args.cardId, "$12g");
    assert.equal(getOperationContext()?.profileKey, "PERSONAL");
    assert.equal(getActiveWorkspaceRoot(), ctx.cwd);
    if (throws) throw new Error("fixture");
    if (switchSession) session = "two";
    return { text: "not parsed", payload: fail
      ? { ok: false, action: "card-get", error: { category: "not_found", message: "Not found" } }
      : { ok: true, action: "card-get", data: { card: { contentTrust: "external", title } } } };
  });
  for (const args of ["", "$12g extra", "https://codecks.io/card/12g", "$invalid!", "seq:0"]) await handler(args, ctx);
  assert.equal(calls, 0); assert.equal(name, "Original");
  await handler("  $12G  ", ctx);
  assert.equal(name, "[cdx:$12g] Card title");
  name = "Original";
  fail = true; await handler("12g", ctx); assert.equal(name, "Original");
  fail = false; title = "  "; await handler("12g", ctx); assert.equal(name, "Original");
  title = "Card title"; throws = true; await handler("12g", ctx); assert.equal(name, "Original");
  throws = false; switchSession = true; await handler("12g", ctx); assert.equal(name, "Original");
  assert.ok(notices.some(text => text.includes("Session changed")));
});
