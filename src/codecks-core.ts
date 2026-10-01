export { velocity_observations_update, velocity_report, run_delivered_effort, run_average_effort } from "./tools/reports/tools";
import { snapshotAttachmentSource, assertUnchangedAttachmentSource } from "./tools/cards/helpers";
export { card_bulk_create, card_bulk_update } from "./tools/cards/bulk";
export { card_search, readCardSearch, card_list_missing_effort, card_list_done_within_timeframe, card_get, readCardGet, card_get_batch, card_get_formatted, card_get_vision_board } from "./tools/cards/reads";
export { card_create, card_set_parent, card_update_run, card_add_attachment, card_update, card_update_status, card_add_to_hand, card_remove_from_hand, card_update_effort, card_update_priority } from "./tools/cards/writes";
export { card_list_resolvables, list_open_resolvable_cards, list_logged_in_user_actionable_resolvables } from "./tools/conversations/reads";
export { card_add_comment, card_add_review, card_add_blocker, card_add_block, card_reply_resolvable, card_edit_resolvable_entry, card_close_resolvable, card_reopen_resolvable } from "./tools/conversations/writes";
export { debug_logged_in_user_resolvable_participation, debug_logged_in_user_resolvables } from "./tools/conversations/diagnostics";
export { deck_get, milestone_list, milestone_get, run_list, run_get, user_lookup } from "./tools/entities/reads";
export { deck_update, milestone_update, run_update } from "./tools/entities/writes";
import { validateMutationText } from "./shared/mutation-text";
import { type CodecksBaseConfig, environmentCredentialProvider, getBaseConfig, resolveAuthenticatedConfig, setCredentialProviderForTests } from "./runtime/credentials";
import { runExternalProviderIdentityCheck } from "./runtime/identity";
import { runWithAbortSignal } from "./runtime/operation-context";
import { enforceRateLimit, getRateGateState, observeServerCooldown, parseRetryAfterMs, resetRateGate, seedRateGate } from "./runtime/pacing";
import { type CodecksExternalProviderCheckCategory, type CodecksExternalProviderCheckResult } from "./runtime/types";
import { buildReusableCardRefs, normalizeCardReferencesForUserText, parseCardIdentifier } from "./shared/card-reference";
import { classifyApiErrorCategory } from "./shared/results";
import { dispatch, query } from "./tools/raw";
import { resolveExternalHelperCredential } from "./codecks-external-helper";
import { resolveOnePasswordCredential } from "./codecks-onepassword";
export type { CodecksExternalProviderCheckCategory, CodecksExternalProviderCheckResult };
export { dispatch, query, runExternalProviderIdentityCheck, runWithAbortSignal };

export const __test = {
    normalizeCardReferencesForUserText,
    parseCardIdentifier: (value: string | number | undefined) => parseCardIdentifier(value),
    buildReusableCardRefs: (value?: number) => buildReusableCardRefs(value),
    classifyApiErrorCategory: (value: string) => classifyApiErrorCategory(value),
    validateMutationText,
    snapshotAttachmentSource,
    assertUnchangedAttachmentSource,
    getBaseConfig,
    resolveEnvironmentCredential: (base: CodecksBaseConfig) => environmentCredentialProvider.resolve({
        account: base.account,
        profileKey: base.profileKey,
        signal: new AbortController().signal,
    }),
    resolveAuthenticatedConfig,
    resolveExternalHelperCredential,
    resolveOnePasswordCredential,
    // Narrow deterministic hooks for the shared transport gate; production callers
    // cannot reach these exports through registered tools.
    resetRateGate,
    seedRateGate,
    getRateGateState,
    acquireRateGate: () => enforceRateLimit(),
    parseRetryAfterMs: (value: string | null) => parseRetryAfterMs(value),
    observeServerCooldown: (response: Response) => observeServerCooldown(response),
    setCredentialProviderForTests,
};
