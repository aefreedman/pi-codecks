import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import { Value } from "typebox/value";

import { loadRegisteredTools, type RegisteredTool } from "./pi-tool-harness.ts";

const tools = await loadRegisteredTools();

const getTool = (name: string): RegisteredTool => {
  const registered = tools.get(name);
  assert.ok(registered, `expected ${name} to be registered`);
  assert.ok(registered.parameters, `expected ${name} to expose parameters`);
  return registered;
};

const prepareAndValidate = (tool: RegisteredTool, raw: unknown): Record<string, unknown> => {
  const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
  const converted = Value.Convert(tool.parameters as any, prepared) as Record<string, unknown>;
  const validator = Compile(tool.parameters as any);
  assert.equal(validator.Check(converted), true, JSON.stringify([...validator.Errors(converted)]));
  return converted;
};

const assertInvalid = (toolName: string, raw: unknown): void => {
  const tool = getTool(toolName);
  const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
  const converted = Value.Convert(tool.parameters as any, prepared);
  assert.equal(Compile(tool.parameters as any).Check(converted), false, `${toolName} unexpectedly accepted ${JSON.stringify(raw)}`);
};

assertInvalid("codecks_dispatch", { payload: {} });
assertInvalid("codecks_dispatch", { path: { invalid: true }, payload: {} });
assertInvalid("codecks_dispatch", { path: "cards/create", payload: {}, format: "yaml" });
assertInvalid("codecks_card_search", { searchIn: "workspace" });
assertInvalid("codecks_card_search", { limit: 0 });
assertInvalid("codecks_card_search", { pageSize: 501 });

const dispatch = getTool("codecks_dispatch");
const validated = prepareAndValidate(dispatch, {
  path: "journey/apply",
  payload: {},
  format: "json",
});
assert.equal(validated.format, "json");

const result = await dispatch.execute("schema-lifecycle", validated, undefined, undefined, { cwd: process.cwd() });
assert.equal(result?.content?.[0]?.type, "text");
assert.match(String(result?.content?.[0]?.text), /out.of.scope|UI-only/i);
assert.equal(result?.details?.exportName, "dispatch");

console.log("Pi-compatible schema lifecycle tests passed");
