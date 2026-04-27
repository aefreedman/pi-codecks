# Pi Codecks

Pi tools, skills, and prompts for Codecks workflows.

This package provides a Pi-native registration layer around Codecks card, comment, review, blocker, resolvable, priority, effort, attachment, and inbox-style workflows. It is intended for users who already have a Codecks account and want Pi agents to interact with Codecks through explicit tools rather than ad hoc shell scripts.

## Features

Default tools:

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

Optional debug tools are not registered by default:

- `codecks_debug_logged_in_user_resolvable_participation`
- `codecks_debug_logged_in_user_resolvables`

Set `CODECKS_ENABLE_DEBUG_TOOLS=1` or `PI_CODECKS_ENABLE_DEBUG_TOOLS=1` before launching Pi to register the debug tools.

## Install

From GitHub:

```bash
pi install git:git@github.com:aefreedman/pi-codecks.git
```

Local development install:

```bash
pi install <path-to-pi-codecks>
```

Project-local install:

```bash
pi install -l <path-to-pi-codecks>
```

## Configuration

Provide credentials through environment variables before launching Pi:

```bash
export CODECKS_ACCOUNT=<your-codecks-subdomain>
export CODECKS_TOKEN=<your-codecks-api-token>
```

Alternative variable names are also supported:

- `CODECKS_SUBDOMAIN`
- `CODECKS_API_TOKEN`
- `CODECKS_API_BASE`

Profiles may be configured with `CODECKS_PROFILE` and `CODECKS_PROFILE_<PROFILE>_*` variables. 1Password token references are supported, but vault access is allow-listed: set `OPENCODE_OP_ALLOWED_VAULTS` to a comma-separated list of vault names before using `op://...` profile token references.

## Vision Board Tool

`codecks_card_get_vision_board` is designed around the user-facing workflow of a vision board attached to a card.

It accepts the same card reference styles as the other card-focused tools:

- short code without `$`, for example `31A`
- short code with `$`, for example `$31a`
- UUID card ids

Result `status` values:

- `available` — the card returned a vision-board reference
- `absent` — the card resolved, but no vision board was attached
- `unsupported` — the account/API path did not support useful retrieval for that card/feature state
- `error` — the request failed before a stable result could be produced

Warnings are surfaced when richer schema-advertised paths such as `visionBoard(id)` or `account.visionBoardQueries(...)` fail in the live API, even if the tool can still confirm board presence via `card.visionBoard`. Those richer paths should be treated as internal/schema-level API surfaces, not as clearly shipped user-facing entry points.

This tool inspects Codecks-side card-attached vision-board metadata/query data. It does not render external whiteboards or guarantee access to content referenced only through attachments/links.

Example:

```json
{
  "cardId": "$31a",
  "format": "text"
}
```

## Included prompt and skill

- prompt: `/codecks-inbox` - summarize the logged-in user's attention-worthy resolvables
- skill: `using-codecks` - Codecks workflow guidance for Pi agents

## Testing

```bash
npm test
```

The default test command runs unit tests and then the integration validation script. Integration validation skips safely when Codecks credentials are absent.

Optional integration settings:

- `CODECKS_TEST_DECK` - enables create/update/delete-style mutation validation against a safe deck
- `CODECKS_TEST_VISION_BOARD_CARD` - enables live vision-board reference checks for a known card
- `CODECKS_TEST_ATTACHMENT_PATH` - enables attachment validation
- `CODECKS_TEST_PROFILE` - selects a test profile
- `OPENCODE_OP_ALLOWED_VAULTS` - allow-list for 1Password refs used by test profiles

The validation script enforces a conservative shared request budget so combined direct API calls and tool calls stay below Codecks API rate limits.

## Implementation notes

- The core implementation lives in `src/opencode-codecks.ts`.
- `index.ts` is the Pi registration layer.
- Text and JSON outputs are intentionally stable because workflow prompts and tests depend on those shapes.
- Debug tools are opt-in so Pi's normal tool list stays compact.

## License

MIT. See `LICENSE`.
