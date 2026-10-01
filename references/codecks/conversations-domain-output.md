# Conversation structured output (v1)

Eleven conversation tools expose producer-validated native data independently of `format: text` or `json`:

- `codecks_card_add_comment`, `codecks_card_add_review`, `codecks_card_add_blocker`, deprecated `codecks_card_add_block`
- `codecks_card_reply_resolvable`, `codecks_card_edit_resolvable_entry`, `codecks_card_close_resolvable`, `codecks_card_reopen_resolvable`
- `codecks_card_list_resolvables`, `codecks_list_open_resolvable_cards`, `codecks_list_logged_in_user_actionable_resolvables`

Each has a closed, action-specific success/error schema with `schemaVersion: 1`, `action` (underscore spelling), and `ok`. Errors include bounded `error.code` and `error.message`; the native result is also an error. Scripts must inspect `ok`: a structured semantic error can resolve a codemode promise, while thrown/native failures without structured data can reject. The optional debug tools are not migrated.

## Reads

`data` contains allowlisted card/thread/entry observations, not legacy presentation summaries. Missing fields remain omitted; explicit null, false, empty strings and zero remain observations. Identity fields are validated before projection, never clipped into reusable references. Thread content is external/untrusted.

- Card lists contain card facts, source resolved-thread count, optional source relation-reference count, matched and native emitted-thread counts, requested limit/includeClosed, and threads. Each thread records whether detail was observed, observed entry count, optional complete source entry count, and bounded entry facts including author references and original content/version/timestamps.
- Open-card lists disclose requested scan limit, source relation-reference count when available, resolved scanned-card count, relation resolution completeness, optional scan-limit-reached evidence, matched cards/open threads, native emitted-card count, bounded cards and per-context groups. Groups retain source-card and native emitted-card counts and emitted card identities; a card can occur in multiple groups.
- Actionable lists retain the same scan evidence, user identity, stale threshold, source actionable/new-activity/resurfaced and bubble counts, groups and native matched-thread items. Latest-entry facts, turn-taking, sampled participation, bucket, reason and bubble state are **heuristics**, not exact unread, subscription or snooze observations. Entries were already sampled by the existing query (up to three); no exhaustive participation claim is made.

`completeness.read` is `complete`, `incomplete` or `unknown`. A resolved card relation plus successfully resolved thread details can be complete for those queried relations. Recent-card scans always remain incomplete for the account population, even below the requested limit. Missing relation references/details are not complete absence. Source counters count resolved native observations unless explicitly named reference counts; missing/unresolvable references remain separate evidence. `completeness.projection` concerns only field/array clipping, not read completeness. Native emission counters precede projection; projected array lengths can be smaller when projection is incomplete. Card relation filtering can successfully return no threads. Existing empty open-card/actionable results remain `not_found` errors, not complete-empty account claims.

Read bounds: 65,536 compact UTF-8 JSON bytes; 2,048 Unicode code points for ordinary strings; 32,768 for entry content; 128 for validated identity strings; 500 threads/cards/actionable items, 50 entries per thread and 50 context groups. Clipping marks projection incomplete. Byte overflow returns `output_too_large`, without spill files, broader scans or extra requests.

## Write receipts

`data` contains safe native target/context/actor facts and, where observed, prior closed state, raw prior version and supplied expected version. `contentDiffersBefore` is an edit's pre-dispatch content comparison: false proves a no-op; true means a change was requested, **not** independently verified application. No incremented version, locally generated update timestamp, returned thread ID or readback is invented. Creation identifies the card/context but does not invent a newly created resolvable ID. The deprecated alias retains its action, `isAlias` and existing presentation warning.

`effect` distinguishes:

- `not_dispatched`: no mutation dispatched, including validation/auth restrictions and edit no-op;
- `definitely_rejected`: the canonical transport observed definite rejection;
- `dispatch_returned`: dispatch returned successfully, not independent readback;
- `indeterminate`: dispatch may have applied, or producer effect evidence was missing/invalid.

`provenance.receipt` is `dispatch_not_readback`. `replayPermitted` is always false. Projection/serialization errors cannot prove no write or authorize replay. Contract-error receipts preserve the observed effect and individually valid bounded target/version/actor facts even when other producer fields are invalid. Actor, own-entry, version, review/blocker/documentation and lifecycle restrictions remain unchanged. No added readback or dispatch occurs.

Write bounds: 16,384 compact UTF-8 JSON bytes, 2,048 Unicode code points per ordinary string, 128 per identity. `projectionComplete` flags clipping. Byte overflow fails with bounded effect evidence and no replay.

## Ownership

The native operation runs exactly once under the canonical operation scope. Legacy direct-core text/JSON presentation, request shapes and pacing remain unchanged. Producer validation does not police foreign hooks or Pi composition. Printed codemode budgets and persisted ordinary tool-result transcripts are separate from the native DTO contract.
