# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows semantic versioning for public package releases.

## [Unreleased]

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
