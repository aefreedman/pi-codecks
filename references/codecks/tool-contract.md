# pi-codecks tool contract

Use `codecks_tool_search` to activate the smallest sufficient specialized capability. Use `codecks_deck_get` to read a Deck description and `codecks_deck_update` only for an explicit description mutation; `codecks_query` is a read-only fallback for unsupported gaps.

Bulk create and update calls should begin with `dryRun: true`. Apply is sequential. Each result echoes an optional caller `correlationKey` and a deterministic `actionKey`; neither is an idempotency key. `indeterminate` means a request may have reached Codecks and must not be retried automatically. `definitely_unsent` means no request was made for that record.

Mutation result sources are explicit: `normalizedRequested` is local normalized data, `dispatchReturned` is only dispatch response data, and `persistedVerified` is `null` unless independently read back. The package does not claim that locally echoed values are persisted verification.

Mutation titles, content, tags, and Deck descriptions reject U+FFFD and unpaired UTF-16 surrogates at the tool boundary. This prevents known-corrupt input from being written; it does not diagnose upstream encoding conversion.
