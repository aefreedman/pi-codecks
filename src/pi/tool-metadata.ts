import { Type } from "typebox";
import type { ToolConfig } from "./tool-definition";
import { outputFormatEnum } from "./input-primitives";

export const DEFAULT_CODECKS_EXPORTS = [
  "query",
  "dispatch",
  "card_search",
  "card_list_missing_effort",
  "card_list_done_within_timeframe",
  "card_get",
  "card_get_batch",
  "card_get_formatted",
  "card_get_vision_board",
  "card_create",
  "card_bulk_create",
  "card_bulk_update",
  "card_set_parent",
  "deck_get",
  "deck_update",
  "milestone_list",
  "milestone_get",
  "milestone_update",
  "run_list",
  "run_get",
  "run_delivered_effort",
  "run_average_effort",
  "velocity_observations_update",
  "velocity_report",
  "run_update",
  "card_update_run",
  "card_add_attachment",
  "card_update",
  "card_update_status",
  "card_add_to_hand",
  "card_remove_from_hand",
  "card_add_comment",
  "card_add_review",
  "card_add_blocker",
  "card_add_block",
  "card_reply_resolvable",
  "card_edit_resolvable_entry",
  "card_close_resolvable",
  "card_reopen_resolvable",
  "card_list_resolvables",
  "list_open_resolvable_cards",
  "list_logged_in_user_actionable_resolvables",
  "card_update_effort",
  "card_update_priority",
  "user_lookup",
] as const;

export const DEBUG_CODECKS_EXPORTS = [
  "debug_logged_in_user_resolvable_participation",
  "debug_logged_in_user_resolvables",
] as const;

export const CODECKS_EXPORTS = [...DEFAULT_CODECKS_EXPORTS, ...DEBUG_CODECKS_EXPORTS] as const;
export type CodecksExportName = (typeof CODECKS_EXPORTS)[number];
export const ENABLE_DEBUG_TOOLS = /^(1|true|yes)$/i.test(
  process.env.CODECKS_ENABLE_DEBUG_TOOLS ?? process.env.PI_CODECKS_ENABLE_DEBUG_TOOLS ?? "",
);

export const TOOL_CONFIG: Partial<Record<CodecksExportName, ToolConfig>> = {
  query: {
    parameters: Type.Object({
      query: Type.Any({ description: "Query object or JSON string." }),
    }),
  },
  dispatch: {
    parameters: Type.Object({
      path: Type.String({ description: "Dispatch path without /dispatch/, e.g. cards/create." }),
      payload: Type.Any({ description: "Payload object or JSON string." }),
      format: Type.Optional(outputFormatEnum),
    }),
  },

};
