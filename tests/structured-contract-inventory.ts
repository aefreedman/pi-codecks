import assert from "node:assert/strict";
import * as cardsRead from "../src/tools/cards/cards-read-output.ts";
import * as cardsWrite from "../src/tools/cards/cards-write-output.ts";
import * as cardsBulk from "../src/tools/cards/cards-bulk-output.ts";
import * as entityRead from "../src/tools/entities/entities-read-output.ts";
import * as entityWrite from "../src/tools/entities/entities-write-output.ts";
import * as entityReads from "../src/tools/entities/reads.ts";
import * as entityWrites from "../src/tools/entities/writes.ts";
import * as conversationRead from "../src/tools/conversations/conversations-read-output.ts";
import * as conversationWrite from "../src/tools/conversations/conversations-write-output.ts";
import * as conversationReads from "../src/tools/conversations/reads.ts";
import * as conversationWrites from "../src/tools/conversations/writes.ts";
import * as reportRead from "../src/tools/reports/reports-read-output.ts";
import * as reportFile from "../src/tools/reports/reports-file-output.ts";
import * as reports from "../src/tools/reports/tools.ts";
import { CARD_GET_OUTPUT_SCHEMA, projectCardGetOutput } from "../src/card-get-output.ts";
import { CARD_SEARCH_OUTPUT_SCHEMA, projectCardSearchOutput } from "../src/card-search-output.ts";
import { CARD_GET_BATCH_OUTPUT_SCHEMA, projectCardGetBatchOutput } from "../src/tools/cards/card-get-batch-output.ts";
import type { CodecksToolDefinition } from "../src/pi/tool-definition.ts";

type Contract = { schema: unknown; project: (payload: unknown) => unknown; seam?: unknown; method?: "read" | "executePayload" };
export const CONTRACTS: Record<string, Contract> = {
  card_get: { schema: CARD_GET_OUTPUT_SCHEMA, project: projectCardGetOutput, method: "read" },
  card_search: { schema: CARD_SEARCH_OUTPUT_SCHEMA, project: projectCardSearchOutput, method: "read" },
  card_get_batch: { schema: CARD_GET_BATCH_OUTPUT_SCHEMA, project: projectCardGetBatchOutput, method: "executePayload" },
  card_list_missing_effort: { schema: cardsRead.CARD_MISSING_EFFORT_OUTPUT_SCHEMA, project: p => cardsRead.projectCardsReadOutput(p, "card_list_missing_effort"), method: "executePayload" },
  card_list_done_within_timeframe: { schema: cardsRead.CARD_DONE_TIMEFRAME_OUTPUT_SCHEMA, project: p => cardsRead.projectCardsReadOutput(p, "card_list_done_within_timeframe"), method: "executePayload" },
  card_get_vision_board: { schema: cardsRead.CARD_VISION_BOARD_OUTPUT_SCHEMA, project: p => cardsRead.projectCardsReadOutput(p, "card_get_vision_board"), method: "executePayload" },
  card_create: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_create, project: p => cardsWrite.projectCardsWriteOutput(p, "card_create"), method: "executePayload" },
  card_set_parent: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_set_parent, project: p => cardsWrite.projectCardsWriteOutput(p, "card_set_parent"), method: "executePayload" },
  card_update_run: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_update_run, project: p => cardsWrite.projectCardsWriteOutput(p, "card_update_run"), method: "executePayload" },
  card_add_attachment: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_add_attachment, project: p => cardsWrite.projectCardsWriteOutput(p, "card_add_attachment"), method: "executePayload" },
  card_update: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_update, project: p => cardsWrite.projectCardsWriteOutput(p, "card_update"), method: "executePayload" },
  card_update_status: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_update_status, project: p => cardsWrite.projectCardsWriteOutput(p, "card_update_status"), method: "executePayload" },
  card_add_to_hand: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_add_to_hand, project: p => cardsWrite.projectCardsWriteOutput(p, "card_add_to_hand"), method: "executePayload" },
  card_remove_from_hand: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_remove_from_hand, project: p => cardsWrite.projectCardsWriteOutput(p, "card_remove_from_hand"), method: "executePayload" },
  card_update_effort: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_update_effort, project: p => cardsWrite.projectCardsWriteOutput(p, "card_update_effort"), method: "executePayload" },
  card_update_priority: { schema: cardsWrite.CARD_WRITE_OUTPUT_SCHEMAS.card_update_priority, project: p => cardsWrite.projectCardsWriteOutput(p, "card_update_priority"), method: "executePayload" },
  card_bulk_create: { schema: cardsBulk.CARD_BULK_CREATE_OUTPUT_SCHEMA, project: p => cardsBulk.projectCardsBulkOutput(p, "card_bulk_create"), method: "executePayload" },
  card_bulk_update: { schema: cardsBulk.CARD_BULK_UPDATE_OUTPUT_SCHEMA, project: p => cardsBulk.projectCardsBulkOutput(p, "card_bulk_update"), method: "executePayload" },
  deck_get: { schema: entityRead.ENTITY_READ_SCHEMAS["deck-get"], project: p => entityRead.projectEntityReadOutput("deck-get", p), seam: entityReads.executeDeckGetPayload },
  deck_update: { schema: entityWrite.ENTITY_WRITE_SCHEMAS["deck-update"], project: p => entityWrite.projectEntityWriteOutput("deck-update", p), seam: entityWrites.executeDeckUpdatePayload },
  milestone_list: { schema: entityRead.ENTITY_READ_SCHEMAS["milestone-list"], project: p => entityRead.projectEntityReadOutput("milestone-list", p), seam: entityReads.executeMilestoneListPayload },
  milestone_get: { schema: entityRead.ENTITY_READ_SCHEMAS["milestone-get"], project: p => entityRead.projectEntityReadOutput("milestone-get", p), seam: entityReads.executeMilestoneGetPayload },
  milestone_update: { schema: entityWrite.ENTITY_WRITE_SCHEMAS["milestone-update"], project: p => entityWrite.projectEntityWriteOutput("milestone-update", p), seam: entityWrites.executeMilestoneUpdatePayload },
  run_list: { schema: entityRead.ENTITY_READ_SCHEMAS["run-list"], project: p => entityRead.projectEntityReadOutput("run-list", p), seam: entityReads.executeRunListPayload },
  run_get: { schema: entityRead.ENTITY_READ_SCHEMAS["run-get"], project: p => entityRead.projectEntityReadOutput("run-get", p), seam: entityReads.executeRunGetPayload },
  run_update: { schema: entityWrite.ENTITY_WRITE_SCHEMAS["run-update"], project: p => entityWrite.projectEntityWriteOutput("run-update", p), seam: entityWrites.executeRunUpdatePayload },
  user_lookup: { schema: entityRead.ENTITY_READ_SCHEMAS["user-lookup"], project: p => entityRead.projectEntityReadOutput("user-lookup", p), seam: entityReads.executeUserLookupPayload },
  card_add_comment: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_add_comment, project: p => conversationWrite.projectConversationWriteOutput("card_add_comment", p), seam: conversationWrites.executeCardAddCommentPayload },
  card_add_review: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_add_review, project: p => conversationWrite.projectConversationWriteOutput("card_add_review", p), seam: conversationWrites.executeCardAddReviewPayload },
  card_add_blocker: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_add_blocker, project: p => conversationWrite.projectConversationWriteOutput("card_add_blocker", p), seam: conversationWrites.executeCardAddBlockerPayload },
  card_add_block: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_add_block, project: p => conversationWrite.projectConversationWriteOutput("card_add_block", p), seam: conversationWrites.executeCardAddBlockPayload },
  card_reply_resolvable: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_reply_resolvable, project: p => conversationWrite.projectConversationWriteOutput("card_reply_resolvable", p), seam: conversationWrites.executeCardReplyResolvablePayload },
  card_edit_resolvable_entry: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_edit_resolvable_entry, project: p => conversationWrite.projectConversationWriteOutput("card_edit_resolvable_entry", p), seam: conversationWrites.executeCardEditResolvableEntryPayload },
  card_close_resolvable: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_close_resolvable, project: p => conversationWrite.projectConversationWriteOutput("card_close_resolvable", p), seam: conversationWrites.executeCardCloseResolvablePayload },
  card_reopen_resolvable: { schema: conversationWrite.CONVERSATION_WRITE_SCHEMAS.card_reopen_resolvable, project: p => conversationWrite.projectConversationWriteOutput("card_reopen_resolvable", p), seam: conversationWrites.executeCardReopenResolvablePayload },
  card_list_resolvables: { schema: conversationRead.CONVERSATION_READ_SCHEMAS.card_list_resolvables, project: p => conversationRead.projectConversationReadOutput("card_list_resolvables", p), seam: conversationReads.executeCardListResolvablesPayload },
  list_open_resolvable_cards: { schema: conversationRead.CONVERSATION_READ_SCHEMAS.list_open_resolvable_cards, project: p => conversationRead.projectConversationReadOutput("list_open_resolvable_cards", p), seam: conversationReads.executeListOpenResolvableCardsPayload },
  list_logged_in_user_actionable_resolvables: { schema: conversationRead.CONVERSATION_READ_SCHEMAS.list_logged_in_user_actionable_resolvables, project: p => conversationRead.projectConversationReadOutput("list_logged_in_user_actionable_resolvables", p), seam: conversationReads.executeListLoggedInUserActionableResolvablesPayload },
  velocity_observations_update: { schema: reportFile.VELOCITY_UPDATE_OUTPUT_SCHEMA, project: reportFile.projectVelocityUpdateOutput, seam: reports.executeVelocityObservationsUpdatePayload },
  velocity_report: { schema: reportFile.VELOCITY_REPORT_OUTPUT_SCHEMA, project: reportFile.projectVelocityReportOutput, seam: reports.executeVelocityReportPayload },
  run_delivered_effort: { schema: reportRead.RUN_DELIVERED_OUTPUT_SCHEMA, project: reportRead.projectRunDeliveredOutput, seam: reports.executeRunDeliveredEffortPayload },
  run_average_effort: { schema: reportRead.RUN_AVERAGE_OUTPUT_SCHEMA, project: reportRead.projectRunAverageOutput, seam: reports.executeRunAverageEffortPayload },
};
export const EXCLUSIONS = {
  card_get_formatted: "presentation wrapper",
  query: "arbitrary raw query",
  dispatch: "arbitrary raw dispatch",
  debug_logged_in_user_resolvable_participation: "optional private-schema diagnostic",
  debug_logged_in_user_resolvables: "optional private-schema diagnostic",
  profile_select: "profile/auth selection",
  tool_search: "discovery/activation",
};
export async function assertContractIdentity(definition: CodecksToolDefinition) {
  const expected = CONTRACTS[definition.exportName];
  if (!expected) {
    assert.ok(Object.hasOwn(EXCLUSIONS, definition.exportName), `${definition.exportName}: classified`);
    for (const key of ["read", "executePayload", "outputSchema", "projectOutput"] as const) assert.equal(definition[key], undefined);
    return;
  }
  assert.strictEqual(definition.outputSchema, expected.schema, `${definition.exportName}: schema owner`);
  assert.equal(typeof definition.projectOutput, "function");
  assert.deepEqual(definition.projectOutput!(undefined), expected.project(undefined), `${definition.exportName}: bound projector`);
  if (expected.seam) {
    assert.strictEqual(definition.executePayload, expected.seam, `${definition.exportName}: producer owner`);
    assert.equal(definition.read, undefined);
  } else {
    const method = expected.method!;
    assert.equal(definition[method === "read" ? "executePayload" : "read"], undefined);
    const tool = definition.tool as any;
    const saved = tool[method];
    const args = { inventorySentinel: true };
    const sentinel = { text: "inventory", payload: {} };
    let calls = 0;
    tool[method] = async (received: unknown) => { assert.strictEqual(received, args); calls++; return sentinel; };
    try { assert.strictEqual(await definition[method]!(args), sentinel); assert.equal(calls, 1); }
    finally { tool[method] = saved; }
  }
}
