# Bulk Create and Update Operations

Read this reference before CSV/import-style creates, broad tracker edits, or bulk effort updates.

- Use `codecks_card_bulk_create` or `codecks_card_bulk_update` in dry-run mode first. For creation, exact authorization in the user's request covers a matching apply; ask again only if the preview differs or exceeds that scope.
- Bulk records are strict. Use `assigneeId` from `codecks_user_lookup`; never send display-name fields such as `assignee`.
- Submit one approved bulk operation. The package paces every physical request at 40 requests per five seconds; do not manually chunk records or count requests.

## Bulk create

- Bulk create validates and normalizes every record before dispatch. Dry-run returns each normalized requested record.
- It never searches for duplicates and never reads a card after a successful create. Use `codecks_card_search` before approval when likely-match review matters.
- Apply is sequential and stops at the first dispatch failure. Earlier successes remain created, ambiguous attempts remain indeterminate, and untouched records are definitely unsent.
- Results echo optional `correlationKey` unchanged for caller-owned CSV, spreadsheet, or import row mapping. It is not an idempotency key.
- A successful dispatch returns the identity Codecks supplied. If no reusable identity is supplied, it is unavailable; inspect explicitly with `codecks_card_get` when needed.
- While pacing waits, the TUI immediately reports request pacing and refreshes once per second. A genuine 429 may retry the same definitely rejected bulk-create record after a valid Codecks numeric-millisecond or HTTP-date Retry-After. Recovery is capped at two retries / three consecutive 429 responses and a fifteen-second total server-wait budget; other mutation failures are never retried. Transient progress and final results report retry, wait, request, and continuation-safe metrics.
- Bulk-create responses keep aggregate metrics and exceptional records inline. Complete sanitized per-record results are written to the returned temporary JSON artifact; ordinary later work should use existing card lookup and bulk-update tools.

## Bulk update scope

- `codecks_card_bulk_update` supports effort, priority, tags, Run assignment/removal, and parent assignment/removal.
- For bulk effort workflows, start with `codecks_card_list_missing_effort`; it previews eligibility and exclusions without mutating.
