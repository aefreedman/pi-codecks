# Pi Codecks

Pi extension package that ports the proven OpenCode Codecks workflows into Pi with minimal behavioral drift.

Default tool set:
- `codecks_query`
- `codecks_dispatch`
- `codecks_card_search`
- `codecks_card_list_done_within_timeframe`
- `codecks_card_get_formatted`
- `codecks_card_get_vision_board`
- `codecks_card_create`
- `codecks_card_set_parent`
- `codecks_card_add_attachment`
- `codecks_card_update`
- `codecks_card_update_status`
- `codecks_card_add_comment`
- `codecks_card_add_review`
- `codecks_card_add_blocker`
- `codecks_card_add_block`
- `codecks_card_reply_resolvable`
- `codecks_card_edit_resolvable_entry`
- `codecks_card_close_resolvable`
- `codecks_card_reopen_resolvable`
- `codecks_card_list_resolvables`
- `codecks_list_open_resolvable_cards`
- `codecks_list_logged_in_user_actionable_resolvables`
- `codecks_card_update_effort`
- `codecks_card_update_priority`
- `codecks_user_lookup`

Optional debug tools (not registered by default):
- `codecks_debug_logged_in_user_resolvable_participation`
- `codecks_debug_logged_in_user_resolvables`

Notes:
- The package uses a copy-first port of the OpenCode implementation so the existing Codecks workflows and guardrails are preserved in Pi.
- Text and JSON outputs intentionally track the OpenCode behavior closely because the validation tests depend on those shapes.
- Profile, 1Password, retry, timeout, redaction, and dispatch-scope behavior are preserved.
- The core implementation lives in `src/opencode-codecks.ts`; `index.ts` is the thin Pi registration layer.
- `codecks_card_get_vision_board` is intentionally **card-centric**: it reliably detects whether a specific card has a Codecks vision board attached and reports the board reference/capability state. The live API still returns server errors for some schema-advertised `visionBoard` / `visionBoardQueries` paths, so richer payload retrieval is treated as best-effort only and may surface as warnings rather than data.
- `codecks_list_open_resolvable_cards` is intentionally **account-card-centric**: it scans recent cards in a single account-level query and groups cards with open resolvables by context, which is much closer to the web UI's "have open resolvables" list and avoids the per-card/per-thread query pattern that can hit the 40 requests / 5 seconds API limit.
- `codecks_list_logged_in_user_actionable_resolvables` is intentionally **heuristic and practical**: it approximates the logged-in user's attention-worthy resolvable list by combining turn-taking signals (latest reply by someone else in a relevant thread) with stale self-authored still-open thread resurfacing after a configurable age threshold. It also emits a simple `bubbleHeuristic` classification using `unread`, `read`, and `stale_review`.
- Debug tools are intentionally **opt-in** so they do not bloat Pi's normal tool list/context. Set `CODECKS_ENABLE_DEBUG_TOOLS=1` (or `PI_CODECKS_ENABLE_DEBUG_TOOLS=1`) before launching Pi to register them.
- `codecks_debug_logged_in_user_resolvable_participation` is intentionally **diagnostic and participation-oriented**: it focuses on attention-worthy resolvables, estimates bubble states, and runs best-effort probes against likely participant/subscriber/follower/watcher/leave-thread style relation and field surfaces on a sample resolvable.
- `codecks_debug_logged_in_user_resolvables` is intentionally **diagnostic and user-state-oriented**: it scans recent open resolvables once, samples thread metadata, and then runs a small set of best-effort probes against likely logged-in-user inbox/read/snooze API surfaces so you can reverse-engineer which signals the web UI is using.
- See `docs/resolvable-inbox-heuristics.md` for the current actionable/bubble heuristic model and debug-tool enablement notes.
- See `prompts/codecks-inbox.md` for a reusable Pi prompt that formats the logged-in user's attention-worthy resolvables as a sectioned summary.

## Vision Board Tool

`codecks_card_get_vision_board` is designed around the shipped user-facing workflow: a vision board attached to a card.

It accepts the same card reference styles as the other card-focused tools:
- short code without `$`, e.g. `31A`
- short code with `$`, e.g. `$31a`
- UUID card ids

Result `status` values:
- `available` — the card returned a vision-board reference
- `absent` — the card resolved, but no vision board was attached
- `unsupported` — the account/API path did not support useful retrieval for that card/feature state
- `error` — the request failed before a stable result could be produced

Warnings are surfaced when richer schema-advertised paths such as `visionBoard(id)` or `account.visionBoardQueries(...)` fail in the live API, even if the tool can still confirm board presence via `card.visionBoard`. Those richer paths should be treated as internal/schema-level API surfaces, not as clearly shipped user-facing entry points.

This tool inspects **Codecks-side card-attached vision board metadata/query data**. It does not render external whiteboards or guarantee access to content referenced only through attachments/links (for example, a Miro URL attached to a card).

Examples:

```json
{
  "cardId": "3c5",
  "format": "text"
}
```

```json
{
  "cardId": "$3c5",
  "format": "json",
  "includePayload": true
}
```

Testing:
- `npm test` runs unit coverage for the vision-board tool and the ported Codecks validation flow.
- Use `CODECKS_TEST_DECK=Test` (or another safe deck) for mutation validation.
- The validation script now enforces a conservative shared request budget so combined direct API calls and tool calls stay below the hard 40 requests / 5 seconds limit.

## License

MIT. See `LICENSE`.
