import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as core from "../src/codecks-core.ts";

type Row = Record<string, unknown>;
const object = (value: unknown): Row => {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected an object");
  return value as Row;
};
let credentialFailure = false;
async function call(tool: { execute: (args: Row) => Promise<unknown> }, args: Row): Promise<Row> {
  let raw: unknown;
  try {
    raw = await core.runWithAbortSignal(undefined, () => tool.execute({ ...args, format: "json" }), process.cwd());
  } catch (error) {
    const category = error && typeof error === "object" && "category" in error ? String(error.category) : "unknown";
    credentialFailure ||= /credential|auth/.test(category);
    console.error(`Transport failure category: ${category}`);
    throw error;
  }
  const match = String(raw).match(/```json\s*([\s\S]*?)\s*```/);
  assert.ok(match, "missing structured tool result");
  const result = object(JSON.parse(match[1]));
  if (result.ok === false) {
    const error = object(result.error);
    const category = String(error.category ?? error.code ?? "unknown");
    credentialFailure = /credential|auth/.test(category);
    throw new Error(`Tool failed (${category}); no write is retried.`);
  }
  const data = result.ok === true ? object(result.data) : result;
  if (Array.isArray(data.results)) {
    credentialFailure ||= data.results.some(entry => {
      const row = object(entry);
      return row.error !== undefined && /credential|auth/.test(String(object(row.error).category ?? ""));
    });
  }
  return data;
}

async function run(): Promise<void> {
  assert.equal(process.env.CODECKS_TEST_DECK, "Test", "explicit CODECKS_TEST_DECK=Test is required");
  assert.ok(process.env.CODECKS_TEST_MILESTONE, "select an existing milestone for temporary fixture membership");
  const deck = await call(core.deck_get, { deckId: "Test" });
  assert.equal(deck.title, "Test");
  const milestone = await call(core.milestone_get, { milestoneId: process.env.CODECKS_TEST_MILESTONE });
  const identity = await call(core.query, { query: { _root: [{ loggedInUser: ["id"] }] } });
  const root = object(Array.isArray(identity._root) ? identity._root[0] : identity._root);
  const userId = typeof root.loggedInUser === "string" ? root.loggedInUser : object(root.loggedInUser).id;
  assert.equal(typeof userId, "string");
  assert.equal(typeof deck.deckId, "string");
  const milestoneId = object(milestone.milestone).id;
  assert.equal(typeof milestoneId, "string");
  console.log("PASS: exact Test deck, milestone, and creator identity resolved");
  const title = `[tool-test] bulk clear ${randomUUID()}`;
  let cardId: string | undefined;
  let cardRef: string | undefined;
  async function update(fields: Row): Promise<void> {
    assert.ok(cardId);
    console.log(`UPDATE INTENT: ${Object.keys(fields).join(", ")}`);
    const updates = [{ cardId, ...fields }];
    const preview = await call(core.card_bulk_update, { updates, dryRun: true });
    assert.equal(preview.failed, 0, "preview must normalize the fixture update");
    assert.equal(typeof preview.previewFingerprint, "string");
    const applied = await call(core.card_bulk_update, { updates, dryRun: false, expectedPreviewFingerprint: preview.previewFingerprint });
    if (applied.updated !== 1) {
      console.error(JSON.stringify({ updated: applied.updated, failed: applied.failed, indeterminate: applied.indeterminate, artifact: applied.artifact }));
    }
    assert.equal(applied.updated, 1, "one fixture update must succeed");
  }
  async function read(): Promise<Row> {
    const data = await call(core.card_get, { cardId });
    const card = object(data.card);
    assert.equal(card.title, title, "only the newly created fixture may be changed");
    return card;
  }
  try {
    const created = await call(core.card_create, { title, content: "Disposable bulk clear validation fixture.", deck: deck.deckId, assigneeId: userId, milestone: milestoneId, effort: 3, priority: "high", tags: ["tool-test"], putOnHand: false });
    assert.equal(typeof created.cardId, "string", "create identity missing; inspect the unique fixture title before any retry");
    cardId = String(created.cardId);
    cardRef = String(created.cardRef ?? created.shortCode ?? cardId);
    console.log(`FIXTURE: ${cardRef}`);
    let card = await read();
    assert.equal(object(card.deck).id, deck.deckId);
    assert.equal(object(card.milestone).id, milestoneId);
    assert.equal(object(card.assignee).id, userId);
    assert.equal(card.effort, 3);
    await update({ clearMilestone: true, clearEffort: true, priority: "none", tags: [] });
    card = await read();
    assert.equal(card.milestone, null);
    assert.equal(card.effort, null);
    assert.equal(card.priority, null);
    assert.deepEqual(card.tags, []);
    assert.equal(object(card.deck).id, deck.deckId);
    assert.equal(object(card.assignee).id, userId);
    console.log("PASS: milestone, effort, priority, and tags cleared and read back; other assignments preserved");
    await update({ clearAssignee: true });
    card = await read();
    assert.equal(card.assignee, null);
    assert.equal(object(card.deck).id, deck.deckId);
    console.log("PASS: assignee cleared while Test deck preserved");
    console.log("SKIP: deck and combined deck/assignee removal are unavailable; rejection is covered by credential-free tests");
  } catch (error) {
    console.error(`Fixture validation stopped: ${error instanceof Error ? error.name : "UnknownError"}; cleanup follows`);
    throw error;
  } finally {
    if (cardId && !credentialFailure) {
      await update({ deck: deck.deckId, assigneeId: userId, clearMilestone: true });
      const restored = await read();
      assert.equal(object(restored.deck).id, deck.deckId);
      assert.equal(object(restored.assignee).id, userId);
      await call(core.card_update_status, { cardId, status: "done" });
      const completed = await read();
      assert.equal(completed.status, "done");
      console.log(`CLEANUP: ${cardRef} restored to Test, assigned to creator, milestone empty, marked done (not deleted)`);
    } else if (cardId) {
      console.log(`CLEANUP BLOCKED: credential failure; fixture ${cardRef} needs inspection`);
    } else {
      console.log(`No resolved fixture identity. If creation was attempted, inspect title: ${title}`);
    }
  }
}

run().then(() => console.log("PASS: live bulk clear validation completed")).catch((error: unknown) => {
  // Do not dump API responses, card content, credentials, or assertion values.
  console.error(`FAIL: ${error instanceof Error ? error.name : "UnknownError"}; live bulk clear validation incomplete. No automatic retry.`);
  process.exitCode = 1;
});
