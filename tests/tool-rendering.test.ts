import assert from "node:assert/strict";

import { loadRegisteredTools, type RegisteredTool } from "./pi-tool-harness.ts";

const tools = await loadRegisteredTools();

const fakeTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

const renderLines = (component: any): string[] => {
  assert.equal(typeof component?.render, "function", "expected renderable component");
  return component.render(120) as string[];
};

const getTool = (name: string): RegisteredTool => {
  const tool = tools.get(name);
  assert.ok(tool, `expected ${name} to be registered`);
  assert.equal(typeof tool.renderCall, "function", `expected ${name} to provide renderCall`);
  assert.equal(typeof tool.renderResult, "function", `expected ${name} to provide renderResult`);
  return tool;
};

const cardGet = getTool("codecks_card_get");
const callLines = renderLines(cardGet.renderCall!({ cardId: "$abc" }, fakeTheme, {}));
assert.match(callLines.join("\n"), /codecks_card_get/);
assert.match(callLines.join("\n"), /\$abc/);

const structuredResult = {
  content: [
    {
      type: "text",
      text: [
        "## card-get",
        "",
        "```json",
        JSON.stringify({
          ok: true,
          action: "card-get",
          data: {
            card: {
              shortCode: "$abc",
              title: "Agent Card",
            },
          },
        }, null, 2),
        "```",
      ].join("\n"),
    },
  ],
  details: { exportName: "card_get" },
};

const collapsedLines = renderLines(cardGet.renderResult!(structuredResult, { expanded: false }, fakeTheme, {}));
const collapsed = collapsedLines.join("\n");
assert.match(collapsed, /card_get/);
assert.match(collapsed, /\$abc Agent Card/);
assert.match(collapsed, /expand/i);
assert.doesNotMatch(collapsed, /```json/);

const expandedLines = renderLines(cardGet.renderResult!(structuredResult, { expanded: true }, fakeTheme, {}));
const expanded = expandedLines.join("\n");
assert.match(expanded, /```json/);
assert.match(expanded, /Agent Card/);

const errorResult = {
  content: [
    {
      type: "text",
      text: [
        "## card-get",
        "",
        "```json",
        JSON.stringify({
          ok: false,
          action: "card-get",
          error: {
            category: "not_found",
            message: "Card not found.",
          },
        }, null, 2),
        "```",
      ].join("\n"),
    },
  ],
  details: { exportName: "card_get" },
};

const errorCollapsed = renderLines(cardGet.renderResult!(errorResult, { expanded: false }, fakeTheme, {})).join("\n");
assert.match(errorCollapsed, /Card not found/);
assert.doesNotMatch(errorCollapsed, /```json/);

console.log("Codecks tool rendering test passed");
