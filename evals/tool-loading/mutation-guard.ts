import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Eval-only no-persistent-side-effects boundary. Tracker writes (including bulk
 * previews, which publish detail artifacts), cache updates, and requested report
 * outputs are blocked at tool_call before execute. In-memory reports remain safe.
 */
export const CODECKS_MUTATION_TOOL_NAMES = new Set([
  "codecks_dispatch",
  "codecks_card_create",
  "codecks_card_set_parent",
  "codecks_card_add_attachment",
  "codecks_card_update",
  "codecks_card_bulk_create",
  "codecks_card_bulk_update",
  "codecks_card_update_effort",
  "codecks_card_update_status",
  "codecks_card_update_priority",
  "codecks_deck_update",
  "codecks_card_add_to_hand",
  "codecks_card_remove_from_hand",
  "codecks_milestone_update",
  "codecks_run_update",
  "codecks_card_update_run",
  "codecks_card_add_comment",
  "codecks_card_add_review",
  "codecks_card_add_blocker",
  "codecks_card_add_block",
  "codecks_card_reply_resolvable",
  "codecks_card_edit_resolvable_entry",
  "codecks_card_close_resolvable",
  "codecks_card_reopen_resolvable",
]);

export default function codecksEvalMutationGuard(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    const writesLocally = event.toolName === "codecks_velocity_observations_update"
      || (event.toolName === "codecks_velocity_report" && ["csvPath", "summaryMarkdownPath", "csv_path", "summary_markdown_path"].some((key) => event.input[key] !== undefined));
    if (!CODECKS_MUTATION_TOOL_NAMES.has(event.toolName) && !writesLocally) return;
    return {
      block: true,
      reason: `Eval mutation guard blocked ${event.toolName} before execution. No tracker or persistent local write is authorized by this eval.`,
    };
  });
}
