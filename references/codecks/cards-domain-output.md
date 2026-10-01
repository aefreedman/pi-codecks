# Remaining cards: structured output v1

These contracts cover `codecks_card_list_missing_effort`, `codecks_card_list_done_within_timeframe`, `codecks_card_get_vision_board`, `codecks_card_create`, `codecks_card_set_parent`, `codecks_card_update_run`, `codecks_card_add_attachment`, `codecks_card_update`, `codecks_card_update_status`, `codecks_card_add_to_hand`, `codecks_card_remove_from_hand`, `codecks_card_update_effort`, `codecks_card_update_priority`, `codecks_card_bulk_create` and `codecks_card_bulk_update`.

The adapter invokes one native operation and projects its local observations. Text/JSON formatting, inputs, aliases and legacy core tools remain available. Legacy single-write calls still reject with the original error for formerly escaping lookup/filesystem failures; the native seam records those as bounded error receipts without another invocation. No extra query, write, readback, scan, retry or overflow file is introduced. The existing single-card/search/batch contracts are separate and unchanged; formatted-card retrieval remains a presentation-only exclusion.

All envelopes have `schemaVersion: 1`, an underscore-form `action`, and `ok`. Failure envelopes have a bounded `error.code` and `error.message` and native `isError: true`. A structured semantic error can resolve a codemode promise: inspect `ok`, and separately handle native rejection. Codecks validates only its producer output, not foreign hooks or Pi composition.

## Read contracts

Read envelopes have Codecks/external-content provenance and `completeness.read` (`complete`, `incomplete`, `unknown`), `completeness.emission` and `completeness.projection`. These are independent: a successful partial scan is not authoritative absence, and bounded projection is not scan completeness. Visibility is limited to the token-visible projects, not verified global project permissions.

- **Missing effort:** native card facts and exclusion reasons, separate candidate/eligible/excluded totals and returned counts. Missing effort is not observed zero. Missing, null, false, zero and empty scalar observations remain distinct. Reusable sequence references are generated only for safe nonnegative integers. Emission is false when eligible/excluded rows are withheld by the output limit or exclusion selection.
- **Done timeframe:** source accepted-event count, archive-filtered event count, deduplicated matches and emitted rows remain distinct. Normalized transition/timestamp evidence is separate from pre-default activity/card/actor/assignee/deck observations and raw transition status values. Relation states distinguish missing, null, resolved and unresolved. Event occurrences are paired to their own observations; current status is not proof of a historical transition. No new scan is made.
- **Vision board:** factual presence/reference, capability, source and bounded board/query metadata only. `relationState` distinguishes missing/null/reference/invalid, with scalar `referenceObservation` when observed. Missing or malformed presence is `status: unknown`, not authoritative absence. Best-effort capability/query failures keep completeness unknown and warnings. Missing metadata stays missing rather than acquiring renderer defaults. `includePayload` still controls legacy presentation/request selections; raw query/payload fields are never part of this DTO.

Read limits: 65,536 compact UTF-8 JSON bytes inclusive; 2,048 Unicode code points per string; 3,000 missing-effort/done rows per array; 500 vision query metadata rows; 16 warnings/exclusion reasons. Source/emitted operation counts precede projection clipping; consumers can compare projected array lengths separately. Clipping sets projection false; byte overflow returns `output_too_large` without persistence or additional requests.

## Single mutation receipts

Receipts identify actual dispatch observations, not independently verified persistence. `effects` contains:

- `certainty`: `definitely_unsent`, `definitely_rejected`, `dispatch_returned` or `possibly_applied`;
- `dispatchInvoked`, `readback` (`not_performed`, `confirmed`, `unconfirmed`) and `replay: not_authorized`;
- bounded allowlisted **requested dispatch fields**, including explicit clears/null, false, empty arrays and zero; valid observed target/created identity and existing action key where available;
- upload phases (signing, storage, registration) and observed filename/type/size, but no signed URLs, storage URLs, auth data or raw responses;
- Hand target/actor/card and complete before/immediate/after orders, baseline drift and exact readback evidence.

Transport counters distinguish a invoked-but-unsent dispatch from physical send; explicit transport rejection/unknown-effect evidence is retained. A returned dispatch is not independent readback. Hand readback failure retains the returned dispatch and unconfirmed reconciliation state. A storage attempt can be uncertain even when no card registration was sent. Projection/serialization failure after effects never proves nothing changed or authorizes replay. Contract failures retain bounded certainty, upload stages and Hand counts/drift/readback even if detailed evidence cannot project.

Single-write limits: 65,536 compact UTF-8 JSON bytes inclusive; 2,048 code points for ordinary strings, 32,768 for requested content, 100 tags, 500 Hand/requested-order entries. Identifiers/action keys are limited to 128 code points and are never clipped into usable references. The same no-clipped-reference rule applies to read and bulk contracts.

## Bulk receipts

Preview/apply retain the existing fingerprint authorization, action-key algorithm, pacing, stop/continuation and artifact workflows. The DTO includes **every indexed working record**, not only the exceptional records in legacy compact output. Correlation keys, normalized fingerprints when produced, allowlisted requested dispatch fields, target/returned identity, statuses, certainty, error and verification state remain per-record. `replay: not_authorized` does not authorize even definitely-unsent records without a new approved operation.

Statuses include preview/ready/created/updated/invalid/failed/indeterminate/definitely_unsent. Certainty separately distinguishes not_dispatched/dispatch_returned/possibly_applied/definitely_rejected/definitely_unsent. Explicit transport `mutationCertainty: indeterminate` takes precedence over a legacy failure classification in the DTO. Legacy aggregate totals retain their source meanings; they are not an independent persistence claim. Inspect every indexed outcome. A failed/invalid/indeterminate/unsent child makes the structured envelope a native error even when the legacy bulk renderer uses a successful wrapper.

The receipt retains source metrics (physical/normalization/dispatch requests, unique records attempted, waits, retry/rate-limit evidence, safe continuation range). Preflight errors also retain one indexed outcome per input and actual operation request accounting: lookup reads are not mutation dispatches, even when the legacy renderer reports zero requests. The receipt retains only the genuine existing artifact result. Artifacts are temporary, sanitized legacy detailed-result files, not hidden DTO spills; unavailable artifacts have an explicit reason and a native `file_error`, preserving the indexed tracker effects. Preview fingerprints are required for apply; mismatches dispatch zero mutations. No new persistence/readback or ambiguous-write replay is added.

Bulk limits: 2,097,152 compact UTF-8 JSON bytes inclusive; 100 records, 200 code points per correlation key, 500 retry/rate-limit events; the requested-field limits above apply independently. Fingerprints retain their full 64 hexadecimal characters. Artifact paths are bounded to 2,048 code points and never clipped into a new reference. Contract/byte failures retain bounded indexed status/certainty and genuine artifact evidence where valid, not a claim of zero effects. If malformed native input exceeds the 100-record limit, fallback `recordCount` retains the observed source array length; emitted fallback rows remain bounded.

External card text and metadata remain untrusted data. These are operation receipts and observations, not permission grants, exact global completeness guarantees, or automatic-retry instructions.
