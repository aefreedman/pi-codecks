import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Eval-only network safety boundary. These are every package-exposed operation
 * that can mutate Codecks state. Blocking occurs at tool_call, before the
 * registered tool's execute function can construct or send its API request.
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
    if (!CODECKS_MUTATION_TOOL_NAMES.has(event.toolName)) return;
    return {
      block: true,
      reason: `Eval mutation guard blocked ${event.toolName} before execution. No live Codecks mutation is authorized by this eval.`,
    };
  });
}
