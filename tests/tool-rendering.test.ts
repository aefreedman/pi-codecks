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

const ansiPattern = /\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

const visibleLength = (value: string): number => value.replace(ansiPattern, "").length;

const renderLines = (component: any, width = 120): string[] => {
  assert.equal(typeof component?.render, "function", "expected renderable component");
  return component.render(width) as string[];
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
assert.match(collapsed, /ctrl\+o to expand/i);
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
            category: "api_error",
            message: "Codecks API error 400 Bad Request: {\"error\":\"field 'deckId' in body must be string or null\",\"message\":\"field 'deckId' in body must be string or null\",\"statusCode\":400}",
          },
        }, null, 2),
        "```",
      ].join("\n"),
    },
  ],
  details: { exportName: "card_create" },
};

const errorCollapsedLines = renderLines(cardGet.renderResult!(errorResult, { expanded: false }, fakeTheme, {}), 94);
const errorCollapsed = errorCollapsedLines.join("\n");
assert.match(errorCollapsed, /Codecks API error/);
assert.doesNotMatch(errorCollapsed, /```json/);
for (const line of errorCollapsedLines) {
  assert.ok(visibleLength(line) <= 94, `rendered line exceeded width: ${visibleLength(line)} > 94: ${line}`);
}

console.log("Codecks tool rendering test passed");
