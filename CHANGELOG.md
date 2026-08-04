# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning for public package releases.

## [0.9.0] - 2026-08-04

### Added

- Added `codecks_velocity_observations_update` for atomic caller-owned caches of factual completed-Run snapshots and delivered-card observations, with organization validation, incremental overlap, explicit-window/full refresh modes, and completeness provenance.
- Added cache-consuming velocity reports with calendar-delivered and Run-attributed measures, expanded transformation manifests, explicit gap/partial/exclusion policies (including exact deck exclusions for test/non-production cards), exact configuration resolution, provenance-rich CSV/Markdown artifacts, and sample-sufficiency metadata.
- Added package typechecking and registered-tool coverage for workspace-contained cache, roster, and independent report paths.
- Added `codecks_deck_update` for resolving decks by UUID, account sequence, or visible title and editing or clearing their descriptions through `decks/update`.
- Added credential-free direct mutation-dispatch coverage for operation validation, no-prompt execution, one-attempt mutation behavior, read retry behavior, and attachment path/content controls.
- Added bounded bulk updates for effort, priority, tags, Run assignment/removal, and parent assignment/removal with indexed current/proposed and partial-apply results.
- Added reusable `cardRef` and `accountSeqRef` fields to structured card results plus explicit `seq:` recovery guidance for numeric not-found lookups.
- Added `codecks_deck_get` for structured Deck-description reads, read-versus-update capability routing, and a registered public Codecks tool-contract reference.
- Added fail-closed mutation-text validation for Unicode replacement characters and unpaired surrogates.

### Fixed

- Release publication now resumes safely when npm already contains the exact release `gitHead`, while mismatched immutable package identities still block.
- Velocity reporting now preserves observed zero separately from missing Run statistics or card estimates, retains full allocation precision until presentation, includes delivered cards outside Runs, and rejects unsafe or aliased workspace paths.
- Bulk-create identity verification now makes one non-retrying exact read, reports only compared identity components plus neutral observations, retains compatibility persistence only for verified identities, and exposes bounded outcomes in compact and text results.
- Bulk-create discovery now preserves aggregate title-probe and fallback accounting, distinguishes logical title probes from paginated requests, and returns no-create detailed parent-scoped required previews while keeping required apply blocked.
- Bulk creates preserve dispatch-returned card identifiers from `payload.id` / `payload.accountSeq` responses without treating a generic outer dispatch action ID as a card ID.
- Keep the optional package-reference integration disabled when Pi's CommonJS-compatible TypeScript loader reports `MODULE_NOT_FOUND` for the absent reader runtime, without hiding missing dependencies inside an installed runtime.

### Changed

- Live Codecks integration now runs automatically after protected `main` updates with a dedicated limited CI identity and disposable deck; release publication retains GitHub Release creation as its single human intent gate while environment branch/tag policies replace redundant reviewer prompts.
- Refactored velocity reporting so Codecks retrieval updates a reusable team-neutral observation cache while report generation performs no network requests; `standard_velocity` now uses calendar-delivered effort and discloses every expanded transformation.
- Removed the `tracker.codecks` workflow provider, inline workflow guidance, UUID-only workflow target parsing, and workflow credential/preflight integration. Codecks skills and direct tool metadata continue to handle public short references, untrusted external data, explicit mutation intent, and operation validation without a workflow dependency.
- Removed mutation approval tokens, authorization provenance, sink authorization state, and UI confirmation prompts. Directly invoked writes now proceed from existing operation/target/payload validation to dispatch without a separate approval step.
- Non-idempotent mutations no longer transparently retry ambiguous failures; read-only retries remain. Attachment sources are physically canonicalized, strictly workspace-contained, tracked by canonical identity/content hash/size, revalidated immediately before upload, and guarded against external and symlink/junction escapes.
- Bulk create/update records are now strict and reject unsupported fields before requests; bulk preview and apply share normalized payloads that expose all mutable fields and visible target names.
- Bulk create now deduplicates normalized titles and uses a bounded title-first duplicate probe with conservative accessible-account fallback. Dry-run defaults to `duplicatePolicy=required`; apply defaults to `best_effort` for scan-limit incompleteness, while `required` remains available and `skip` is explicit. Parent-local required matching remains unavailable.
- Bulk-create identity verification is now opt-in (`verification=identity`); the default performs zero post-create reads. Identity read outcomes label checked fields and do not change dispatch certainty or retry a create.
- Bulk-create dry-runs retain detailed response schema v1 by default. Apply now defaults to compact schema v2 results with correlation/status/certainty, returned references/card IDs, aggregate discovery metadata, and bounded warnings; explicit `outputMode=detailed` retains normalized and dispatch diagnostics.
- Broad account scans now have bounded concurrency and queue depth, with stable caller-cancel, rate-queue cancel, timeout, rate-limit, and queue-full diagnostics plus request/queue/elapsed metadata.
- Sequential bulk mutations now distinguish failed, indeterminate, and definitely-unsent records, stop after ambiguous writes, expose correlation/action keys, and label normalized request data separately from dispatch-returned and persisted-verification data.

## [0.8.0] - 2026-07-25

### Added

- Added provenance-safe dynamic Codecks tool loading with balanced, loader-only, and all-active modes, deterministic bounded search, additive activation, and active-branch restoration.
- Added Dependabot coverage and a pull-request template for dependency, GitHub Actions, validation, and release-hygiene updates.
- Added package-local Codecks tool-loading unit coverage and GPT-5.6 behavioral evaluation fixtures with a mutation-blocking guard.
- Added credential-free public CI, protected manual integration validation, and provenance-enabled npm trusted publishing workflows.
- Added executable package-manifest validation and neutral temporary-project smoke coverage for generated tarballs.
- Added public contribution, security, testing, and release guidance.

### Changed

- Require Pi 0.82.0 or newer and initially expose only `codecks_tool_search`, `codecks_card_get`, and `codecks_card_search` in balanced mode while retaining the legacy 39-tool all-active compatibility mode.
- Pinned third-party Actions to reviewed commits, bounded workflow runtimes, serialized npm publication, and restricted secret-bearing integration dispatches to `main`.
- Normalized the `using-codecks` experimental `allowed-tools` field to Pi's space-delimited format and included the loader and velocity report.
- Added evidence-scoped corrective Review follow-up guidance that records the earlier basis, new limiting evidence, and remaining validation gap without prematurely claiming a fix or root cause.
- Prepared public npm metadata and an explicit package-content allow-list while keeping live Codecks tests outside shared validation.

## [0.7.0] - 2026-07-25

### Added

- Added bounded, offset-based card pagination with independent `scanLimit`, `pageSize`, and output limits plus explicit completeness metadata for search and missing-effort previews.
- Added Pi-compatible prepare/convert/validate/execute lifecycle coverage for registered TypeBox schemas.

### Changed

- Made `npm test` deterministic and credential-free with declared, locked test dependencies; live account validation now runs only through `npm run test:integration`.
- Made live integration fixture scope explicit through `CODECKS_TEST_DECK` and report skipped, read-only, mutation-disabled, and mutation-enabled outcomes.

### Fixed

- Centralized rejection of HTTP-2xx responses containing a nonempty root `errors` array so queries, searches, previews, dispatches, and concrete mutations cannot misreport semantic failures as success or empty data.
- Recursively sanitized structured semantic-error messages and metadata to redact token-, header-, cookie-, credential-, password-, and secret-like values.

## [0.6.0] - 2026-07-24

### Added

- Added `codecks_velocity_report` for reproducible completed-Run velocity reporting with mean, P25/P50/P75, sample standard deviation, sample variance, weekly-normalized multi-week Runs, and fixed biweekly totals.
- Added independent `csvPath` and `summaryMarkdownPath` output options, configurable label exclusions, date filtering, and JSON/simple-YAML roster support for explicit team membership.
- Added the separately loadable `codecks-velocity-reporting` skill so report methodology can be evaluated independently from general Codecks operations.
- Added unit coverage for weekly normalization, biweekly aggregation, and report statistics.

## [0.5.6] - 2026-07-24

### Changed

- Marked Pi-bundled core dependencies as optional peers so Pi git installs do not create redundant per-package `node_modules` directories.

## [0.5.5] - 2026-07-10

### Changed

- Migrated Pi extension imports and peer dependencies to the `@earendil-works` package scope, and removed the unused `pi-ai` peer dependency.

### Fixed

- Let integration validation exit naturally after setting its status code, avoiding a Windows Node.js teardown assertion.

## [0.5.4] - 2026-06-29

### Changed

- Allow `codecks_card_search` deck and milestone filters to be combined for intersection searches such as Alpha-milestone cards in the Dev deck.

## [0.5.3] - 2026-06-28

### Changed

- Made `codecks_card_search` default to compact output with capped card rows to protect session context during broad/bulk searches.
- Added `outputMode: "counts"` for aggregate card-search analysis and `outputMode: "detailed"` for explicit full-row output.

## [0.5.2] - 2026-06-28

### Fixed

- Reinterpret invalid `location` strings on card lookup/search tools as deck names when no explicit deck or milestone was provided, matching common agent intent for visible deck names like `Design Docs` or `Vertical Slice`.

## [0.5.1] - 2026-06-28

### Added

- Added `codecks_milestone_list` and `codecks_milestone_get` for milestone context lookup without raw milestone queries.
- Expanded README and `using-codecks` guidance to prefer first-class milestone lookup helpers before milestone edits or planning.

## [0.5.0] - 2026-06-27

### Added

- Added `codecks_card_bulk_create` for dry-run-first bulk card creation with duplicate-candidate detection and per-card apply results.
- Added `codecks_card_bulk_update` for dry-run-first bulk tracker updates with per-card apply results.

### Changed

- Made `codecks_card_search` return successful empty results for no-match searches and include search tips for wildcard/deck/milestone friction.

## [0.4.1] - 2026-06-27

### Fixed

- Made `codecks_card_list_resolvables` return a successful empty result when a card has no matching threads instead of reporting a `not_found` tool error.
- Coerced numeric deck and milestone references to string IDs in `codecks_card_create` dispatch payloads to match Codecks API expectations.

## [0.4.0] - 2026-06-25

### Added

- Added `codecks_milestone_update` for editing Codecks milestone descriptions via `milestones/update`, including empty-string clearing behavior.
- Added `codecks_run_delivered_effort` for cached Run/Sprint `stats.finishStats` delivered-effort reporting without card-by-card recalculation.
- Added `codecks_run_average_effort` for averaging cached delivered effort across completed Runs with default low-effort filtering for vacation/break Runs.
- Added glob-style `*` / `?` wildcard support to `codecks_card_search.title`.
- Added `codecks_card_search.text` and `searchIn` for title/body text searches, including body-only and title-or-body modes.
- Added `includeDone=false` support to `codecks_card_search` for open/undone-only searches.

### Changed

- Made Codecks card search matching accent- and punctuation-insensitive so searches like `ile de france` can match titles such as `Île-de-France`.
- Included `matchedFields` in structured card search results when the tool can identify whether a match came from title and/or content.
- Expanded README and `using-codecks` skill guidance for wildcard, body, and open-card search workflows.

## [0.3.0] - 2026-05-15

### Added

- Added Run-facing tools backed by Codecks Sprint API data: `codecks_run_list`, `codecks_run_get`, `codecks_run_update`, and `codecks_card_update_run`.
- Added Run/Sprint support for listing and lookup, card Run assignment/removal via `sprintId`, and Run description/custom-label updates via `sprints/updateSprint`.
- Added unit coverage for open-Review status blocking, Private card creation, and Run/Sprint tool registration and argument normalization.
- Added live integration validation for read-only Run listing against Codecks and kept card-operation validation scoped to the configured `Test` deck.

### Changed

- Allowed no-deck card creation as Codecks Private cards when an owner/assignee can be resolved, defaulting to the logged-in user and reporting the Private-card outcome.
- Expanded README and `using-codecks` skill guidance for Run-facing workflows and the underlying Sprint API mapping.
- Reduced the live integration test request budget to avoid combined direct/tool request bursts against Codecks rate limits.

### Fixed

- Prevented `codecks_card_update_status` from changing lifecycle status while a target card has an open Review resolvable.
- Preserved existing status guards for documentation cards and Hero-card start attempts while adding the open-Review guard.
- Avoided live Codecks API 500s in card search and missing-effort previews by removing the unsupported `milestone.title` card-list field and filtering deck/milestone scopes client-side instead of using unsupported `cards({ deckId })` / `cards({ milestoneId })` filters.
- Added live integration checks for broad card search, deck-scoped search, and deck-scoped missing-effort previews so future query-shape changes are verified against a real Codecks account.

## [0.2.0] - 2026-04-29

### Added

- Added `codecks_card_get` for efficient structured card retrieval by agents, while keeping `codecks_card_get_formatted` for human-readable presentation.
- Added compact TUI rendering for Codecks tools so collapsed rows show summaries and expanded rows show full Codecks output.
- Added Pi-visible schemas for Codecks conversation and resolvable tools, including reply, list, close, reopen, edit, comment, review, and blocker workflows.
- Added argument alias normalization for common agent inputs such as `resolvable_id`, `card_id`, `entry_id`, `expected_version`, `include_closed`, `message`, `body`, `reply`, and `text`.
- Added prompt snippets and guidelines that direct agents to reply to existing resolvables with `codecks_card_reply_resolvable` instead of opening new comment threads.
- Added unit coverage for resolvable tool registration metadata, alias normalization, prompt guidance, and docs/skill quick-path wording.
- Added live integration coverage for replying by `cardId + context`, closed-thread reply rejection, and ambiguous multiple-comment targeting in the Codecks `Test` deck.
- Added package ignore rules to keep planning artifacts and generated tarballs out of published packages.

### Changed

- Expanded README and `using-codecks` skill guidance to distinguish structured agent card retrieval from formatted user-facing card presentation.
- Expanded README and `using-codecks` skill guidance for comment/review/blocker reply quick paths and closed-thread handling.

## [0.1.0] - 2026-04-28

### Added

- Initial Pi Codecks package with card, comment, review, blocker, resolvable, attachment, priority, effort, vision-board, and inbox-style tools.
