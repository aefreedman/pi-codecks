# Decks, Milestones, and Runs

Read the matching section when inspecting or updating these Codecks entities.

## Deck descriptions

- Use `codecks_deck_get` to read an exact Deck description. Use `codecks_deck_update` instead of raw dispatch only when explicitly asked to edit or clear it.
- Both tools resolve supported UUID, account-sequence, or visible-title forms; updates require an unambiguous target. Numeric `deckId` values are Deck account sequences, not card short codes.
- Deck descriptions map to `decks/update.description`.
- Clear with `clearDescription=true` or `description: ""`; do not send `description: null`.
- These tools edit descriptions only. Deck creation, deletion, archiving, renaming, recoloring, and bulk administration remain out of scope.

## Milestones

- Prefer `codecks_milestone_list` and `codecks_milestone_get` over raw milestone queries.
- Use `codecks_milestone_list(search="Alpha")` when the visible name needs disambiguation.
- Use `codecks_milestone_get` when one exact description or URL is needed.
- Use `codecks_milestone_update` only to edit a milestone description. It maps to `milestones/update.description`.
- Clear with `clearDescription=true` or `description: ""`; do not send `description: null`.
- Other milestone management remains limited; card milestone assignment belongs in `codecks_card_update`.

## Runs

- Use Run-facing language with users. Codecks API fields and dispatch paths use `sprint`/`sprints` internally.
- Use `codecks_run_list` and `codecks_run_get` for lookup.
- Use `codecks_run_delivered_effort` for cached `stats.finishStats` delivery reporting without card-by-card recalculation.
- Use `codecks_run_average_effort` to average cached delivered effort across completed Runs. `minDeliveredEffort` defaults to `1`, excluding zero-effort vacation/break Runs.
- Use `codecks_run_update` for a Run custom label (`sprints/updateSprint.name`) or description (`sprints/updateSprint.description`).
- Use `codecks_card_update_run` for one card. For bounded multi-card assignment/removal, use `codecks_card_bulk_update` with `runId` or `clearRun` after reviewing a dry-run preview and [bulk-operations.md](bulk-operations.md).
- Numeric Run identifiers are Run/Sprint account sequences, not card short codes.

For provenance-rich velocity analysis rather than ordinary Run operations, use the separate `codecks-velocity-reporting` skill.
