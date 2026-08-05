# Bulk Create and Update Operations

Read this reference before CSV/import-style creates, broad tracker edits, or bulk effort updates.

## Preview and approval

- Do not run high-risk bulk updates without first showing the intended filter or selection criteria.
- Use `codecks_card_bulk_create` or `codecks_card_bulk_update` in dry-run mode first. Show the complete normalized per-card preview and duplicate/current-proposed evidence, then apply only after explicit approval.
- Bulk records are strict. Use `assigneeId` from `codecks_user_lookup`; never send display-name fields such as `assignee` expecting them to be ignored.
- Records may carry an opaque `correlationKey`, echoed with a deterministic `actionKey`; neither is an idempotency key.

## Pacing and partial outcomes

- Submit one approved bulk operation. It is sequential, may be partially applied, and internally paces or stops on operational limits. Do not manually chunk records or count requests to manage rate limits.
- Non-idempotent dispatches make one remote attempt and do not retry ambiguous timeout or retryable-response failures.
- An `indeterminate` record may have reached Codecks. Reconcile using its `correlationKey`/`actionKey` and do not retry it.
- Later `definitely_unsent` records received no request. After a server-directed cooldown, continue only from the returned continuation-safe records; never replay successful writes.
- Apply results distinguish `normalizedRequested`, `dispatchReturned`, and `persistedVerified` (normally `null` without an independent verification path).

## Duplicate discovery

- Bulk-create dry-runs default to detailed schema-v1 review output; apply defaults to compact schema-v2 results with returned `$references` for continuation.
- `duplicatePolicy=required` blocks incomplete duplicate evidence. Apply defaults to `best_effort` only for a scan-limit hit and prominently reports that limitation.
- The four-title budget counts logical title probes, not paginated HTTP requests.
- Account fallback is allowed only after semantic title-filter rejection, exceeded probe budget, or an incomplete probe. Transport, authentication, rate-limit, cancellation, timeout, and queue failures remain blocking.
- Accessible archived cards returned by Codecks count as candidates. Deleted and inaccessible Private cards are excluded and cannot be claimed absent.
- `duplicateLimit=0` suppresses candidate rows but does not skip discovery.
- Parent-local required apply is unavailable. Default or explicit-required dry-runs still return a no-create detailed preview with the parent-local-required-unavailable outcome.
- Treat `complete=false`, cancellation, timeout, or queue rejection as incomplete evidence, never definitive absence. Follow the structured recovery hint.

## Verification

- Dispatch identities provide immediate `$reference`/card-ID facts but do not prove every persisted field.
- Default `verification=none` performs no read-backs.
- Request `verification=identity` only when identity reconciliation is meaningful. It performs one non-retrying exact read per identifiable create, reports only compared identity fields, and leaves dispatch certainty unchanged.

## Bulk update scope

- `codecks_card_bulk_update` supports effort, priority, tags, Run assignment/removal, and parent assignment/removal.
- For bulk effort workflows, start with `codecks_card_list_missing_effort`; it previews eligibility and exclusions without mutating.
