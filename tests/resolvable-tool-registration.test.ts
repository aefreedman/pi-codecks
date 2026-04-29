import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadRegisteredTools, type RegisteredTool } from "./pi-tool-harness.ts";

type AnyRecord = Record<string, any>;

const tools = await loadRegisteredTools();

const getTool = (name: string): RegisteredTool => {
  const tool = tools.get(name);
  assert.ok(tool, `expected ${name} to be registered`);
  return tool;
};

const getProperties = (tool: RegisteredTool): AnyRecord => {
  const properties = tool.parameters?.properties;
  assert.ok(properties && typeof properties === "object", `expected ${tool.name} to expose parameter properties`);
  assert.ok(Object.keys(properties).length > 0, `expected ${tool.name} not to use the empty ANY_PARAMETERS fallback`);
  return properties;
};

const assertProperties = (toolName: string, expected: string[]): RegisteredTool => {
  const tool = getTool(toolName);
  const properties = getProperties(tool);
  for (const property of expected) {
    assert.ok(property in properties, `expected ${toolName} to expose parameter '${property}'`);
  }
  return tool;
};

const assertRequired = (toolName: string, expected: string[]): void => {
  const required = getTool(toolName).parameters?.required ?? [];
  for (const property of expected) {
    assert.ok(required.includes(property), `expected ${toolName}.${property} to be required`);
  }
};

const prepare = (toolName: string, args: AnyRecord): AnyRecord => {
  const tool = getTool(toolName);
  assert.equal(typeof tool.prepareArguments, "function", `expected ${toolName} to prepare arguments`);
  return tool.prepareArguments!(args) as AnyRecord;
};

assertProperties("codecks_card_get", ["cardId", "title", "location", "deck", "milestone", "includeArchived", "format"]);

assertProperties("codecks_card_reply_resolvable", ["resolvableId", "cardId", "context", "content", "format"]);
assertRequired("codecks_card_reply_resolvable", ["content"]);
assertProperties("codecks_card_list_resolvables", ["cardId", "contexts", "includeClosed", "limit", "format"]);
assertRequired("codecks_card_list_resolvables", ["cardId"]);
assertProperties("codecks_card_close_resolvable", ["resolvableId", "cardId", "context", "format"]);
assertProperties("codecks_card_reopen_resolvable", ["resolvableId", "format"]);
assertRequired("codecks_card_reopen_resolvable", ["resolvableId"]);
assertProperties("codecks_card_edit_resolvable_entry", ["entryId", "content", "expectedVersion", "format"]);
assertRequired("codecks_card_edit_resolvable_entry", ["entryId", "content"]);

for (const toolName of [
  "codecks_card_add_comment",
  "codecks_card_add_review",
  "codecks_card_add_blocker",
  "codecks_card_add_block",
]) {
  assertProperties(toolName, ["cardId", "content", "format"]);
  assertRequired(toolName, ["cardId", "content"]);
}

assert.deepEqual(
  prepare("codecks_card_reply_resolvable", {
    resolvable_id: "thread-1",
    card_id: "$3cv",
    reply: "reply body",
    format: "markdown",
  }),
  {
    resolvable_id: "thread-1",
    card_id: "$3cv",
    reply: "reply body",
    format: "text",
    resolvableId: "thread-1",
    cardId: "$3cv",
    content: "reply body",
  },
);

assert.deepEqual(
  prepare("codecks_card_reply_resolvable", {
    resolvableId: "canonical-thread",
    resolvable_id: "alias-thread",
    cardId: "$123",
    card_id: "$456",
    content: "canonical content",
    message: "alias content",
  }),
  {
    resolvableId: "canonical-thread",
    resolvable_id: "alias-thread",
    cardId: "$123",
    card_id: "$456",
    content: "canonical content",
    message: "alias content",
  },
);

assert.deepEqual(
  prepare("codecks_card_reply_resolvable", {
    id: "ambiguous-id",
    text: "from text alias",
  }),
  {
    id: "ambiguous-id",
    text: "from text alias",
    content: "from text alias",
  },
  "reply preparation should not map ambiguous id to cardId or resolvableId",
);

assert.equal(prepare("codecks_card_reply_resolvable", { threadId: "thread-2", body: "body" }).resolvableId, "thread-2");
assert.equal(prepare("codecks_card_reply_resolvable", { thread_id: "thread-3", message: "message" }).resolvableId, "thread-3");
assert.equal(prepare("codecks_card_reply_resolvable", { card: "$1a", text: "text" }).cardId, "$1a");
assert.equal(prepare("codecks_card_reply_resolvable", { shortCode: "$1b", text: "text" }).cardId, "$1b");
assert.equal(prepare("codecks_card_reply_resolvable", { short_code: "$1c", text: "text" }).cardId, "$1c");
assert.equal(prepare("codecks_card_edit_resolvable_entry", { entry_id: "entry-1", body: "updated", expected_version: 2 }).entryId, "entry-1");
assert.equal(prepare("codecks_card_edit_resolvable_entry", { entry_id: "entry-1", body: "updated", expected_version: 2 }).expectedVersion, 2);
assert.equal(prepare("codecks_card_list_resolvables", { card_id: "$3cv", include_closed: true }).cardId, "$3cv");
assert.equal(prepare("codecks_card_list_resolvables", { card_id: "$3cv", include_closed: true }).includeClosed, true);
assert.equal(prepare("codecks_card_get", { card_id: "$3cv", include_archived: true }).cardId, "$3cv");
assert.equal(prepare("codecks_card_get", { card_id: "$3cv", include_archived: true }).includeArchived, true);
assert.equal(prepare("codecks_card_get", { id: "$111", cardId: "$222" }).cardId, "$222");
assert.equal(prepare("codecks_card_get", { card_id_or_code: "$333" }).cardId, "$333");
assert.equal(prepare("codecks_card_get", { short_code: "$444" }).cardId, "$444");
assert.equal(prepare("codecks_card_add_comment", { card_id: "$3cv", message: "new thread" }).cardId, "$3cv");
assert.equal(prepare("codecks_card_add_comment", { card_id: "$3cv", message: "new thread" }).content, "new thread");

const original = { card_id: "$3cv", message: "hello", format: "markdown" };
const prepared = prepare("codecks_card_add_review", original);
assert.equal(prepared.cardId, "$3cv");
assert.equal(prepared.content, "hello");
assert.equal(prepared.format, "text");
assert.deepEqual(original, { card_id: "$3cv", message: "hello", format: "markdown" }, "prepareArguments should not mutate caller input");

const cardGetTool = getTool("codecks_card_get");
const cardGetGuidance = [cardGetTool.promptSnippet, ...(cardGetTool.promptGuidelines ?? [])].join("\n");
assert.match(cardGetGuidance, /structured data/i);
assert.match(cardGetGuidance, /agent/i);
assert.match(cardGetGuidance, /codecks_card_get_formatted/i);

const formattedGetTool = getTool("codecks_card_get_formatted");
const formattedGetGuidance = [formattedGetTool.promptSnippet, ...(formattedGetTool.promptGuidelines ?? [])].join("\n");
assert.match(formattedGetGuidance, /human-readable/i);
assert.match(formattedGetGuidance, /codecks_card_get/i);

const replyTool = getTool("codecks_card_reply_resolvable");
const replyGuidance = [replyTool.promptSnippet, ...(replyTool.promptGuidelines ?? [])].join("\n");
assert.match(replyGuidance, /existing Codecks comment, review, or blocker thread/i);
assert.match(replyGuidance, /resolvableId \+ content/i);
assert.match(replyGuidance, /cardId \+ context \+ content/i);
assert.match(replyGuidance, /codecks_card_list_resolvables/i);
assert.match(replyGuidance, /codecks_card_add_comment/i);

const listTool = getTool("codecks_card_list_resolvables");
const listGuidance = [listTool.promptSnippet, ...(listTool.promptGuidelines ?? [])].join("\n");
assert.match(listGuidance, /comments, reviews, blockers/i);
assert.match(listGuidance, /includeClosed=true/i);

const decisionFixture = replyGuidance.toLowerCase();
assert.ok(decisionFixture.includes("codecks_card_list_resolvables"), "reply guidance should direct ambiguous card/comment requests to list resolvables first");
assert.ok(decisionFixture.includes("codecks_card_reply_resolvable"), "reply guidance should direct existing-thread replies to the reply tool");
assert.ok(decisionFixture.includes("codecks_card_add_comment only when explicitly opening a new comment thread"), "reply guidance should not steer existing-thread replies to add_comment");

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const skill = readFileSync(new URL("../skills/using-codecks/SKILL.md", import.meta.url), "utf8");
const docs = `${readme}\n${skill}`;
for (const phrase of [
  "resolvableId",
  "cardId",
  "context",
  "codecks_card_get",
  "codecks_card_get_formatted",
  "codecks_card_list_resolvables",
  "codecks_card_reply_resolvable",
  "codecks_card_reopen_resolvable",
]) {
  assert.ok(docs.includes(phrase), `expected docs/skill quick-path coverage for ${phrase}`);
}
assert.match(docs, /Do not open new Comment threads|should not open new Comment threads/i);
assert.match(docs, /Do not use `codecks_card_add_comment` to reply to an existing thread/i);

console.log("resolvable tool registration test passed");
