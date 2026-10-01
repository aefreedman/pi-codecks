# Reports domain structured output (v1)

The four report tools provide producer-validated structured data independently of text/JSON presentation. Legacy direct `execute` interfaces and input aliases are unchanged. Each native operation executes once. Errors retain native error status; scripts must inspect `ok` because a structured semantic error can resolve a codemode promise.

## Contracts

- `codecks_run_delivered_effort`: token-visible completed Run selection; requested, candidate, matched and returned source counts, calculated totals and selected Run observations.
- `codecks_run_average_effort`: the same selection, threshold, considered/included/filtered counts, included rows and optional filtered rows, and unchanged legacy averages (including zero for an empty included sample).
- `codecks_velocity_observations_update`: factual full-refresh receipt, requested versus effective mode, date window, Run/card observation counts, activity scan bounds, coverage and visibility restriction. Cached incremental reuse remains refused when project visibility cannot be verified. A complete scan is not proof of organization-wide visibility.
- `codecks_velocity_report`: cache-only report, with zero Codecks requests. Includes native measure, preset, date window, configuration selection, transformation arguments/counts/exclusions, subjects, period coverage/value kinds, statistics and source array counts. This is an allowlisted report projection, not a cache/raw-transport wrapper.

Run observations distinguish missing/null/present finishStats, nullable factual `observedDone`/`runWide`, and native allowlisted `rawDone` scalars (including missing/null/false/zero). `calculatedDelivered`, totals, averages and optional `current` retain the existing normalized calculation semantics; they are not evidence that a missing bucket contained zero. `source` identifies the finishStats scope. Current statistics are separate from completed-Run finishStats. Missing source identity/date/label facts are omitted, not renderer fallback values. User resolution remains sampled from recent cards; it is not a directory search.

Every envelope is closed and carries `schemaVersion: 1`, `action`, `ok`, `warnings`, and `completeness.projection`. Success requires `data`; failure requires bounded `error.code`/`message` (and optional bounded ambiguity candidates). Error messages intentionally disclose category rather than filesystem/provider internals. Native legacy text retains its original diagnostic detail.

## Bounds and completeness

Run DTOs: 65,536 compact UTF-8 JSON bytes, 500 rows per array, 500 warnings and five ambiguity candidates. File/report DTOs: 262,144 bytes, 100 subjects, 500 periods per subject per period array, 500 transformations, coverage intervals, warnings and contributing/excluded references per array. Strings are limited to 2,048 Unicode code points. Byte ceilings are inclusive and separate from Pi printed-output budgets.

Schema-directed field/array clipping sets `completeness.projection: false`; source counts and calculation summaries are not recalculated from clipped rows. Emitted counts are the corresponding DTO array lengths. Report `sourceSubjects`, `sourceTransformations` and ordered `subjectPeriodCounts` record pre-projection subject/period cardinalities. Read/coverage completeness is independent of projection completeness. Reusable identities and artifact references are never clipped into different usable references; invalid/oversized identities fail closed. Malformed outputs yield `output_contract_error`; byte overflow yields `output_too_large`. No spill file, retry, extra scan or implicit splitting is performed.

## File effects and replay

Both file tools include `effects` on success and error:

- `certainty: not_written`: no artifact write attempted.
- `certainty: written`: the observed writes returned successfully.
- `certainty: indeterminate`: a write was attempted but did not return successfully; an earlier successful sibling artifact may remain.
- `artifacts`: only successfully written artifacts, identified by `observations`, `csv` or `markdown` and a workspace-relative reference. No requested-but-unwritten path is reported as an artifact.
- Optional `attempted` identifies an unsuccessful write phase without inventing its artifact.
- `replayAllowed: false`: output failure never authorizes replay.

Containment, distinct-path/symlink checks and atomic file replacement remain canonical. Atomicity is per file, not across CSV and Markdown: Markdown failure can leave a genuine CSV. Projection failure after successful writes retains safely bounded observed effect evidence; an unrepresentable artifact reference can be omitted without changing written certainty. There is no additional persistence/readback/cache rewrite.

Producer validation ends at the execute adapter. Foreign result hooks and Pi composition are not enforced by Codecks. Actual host/consumer integration is validated separately from deterministic domain tests.
