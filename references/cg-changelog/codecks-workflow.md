# Codecks Workflow (Cards Instead of PRs)

Use this workflow when source selection includes Codecks.

## Default Inclusion Rule

- Include cards that moved to done/completed in the selected time window.
- Prefer transition-based evidence over current-status snapshots. A card should be included because it moved to done inside the window, not just because it is done now.

## Data to Collect

- Card id/code
- Card short id (may include leading `$`)
- Title
- Status transition context (moved to done)
- Last relevant timestamp
- Priority/tags (if available)
- Contributor context from card history/comments when useful
- Codecks account/domain context for URL construction
- Usage/access hints from card content/comments (menu path, command, setting location)
- Source status (`available`, `empty`, `partial`, or `failed`)

## Query Strategy

1. Preferred: use `codecks_card_list_done_within_timeframe` to fetch cards with done transitions between `WINDOW_START` and `WINDOW_END`.
2. For each returned card, enrich details (title/tags/priority/content hints) with `codecks_card_get_formatted` as needed.
3. If the dedicated timeframe tool is unavailable in the current runtime, use only supported Codecks query objects or supported shorthand documented by the active tool; do not send free-text prompts or GraphQL strings to `codecks_query`.
4. If transition history is still unavailable, fallback to card search/list operations only as metadata enrichment and clearly mark Codecks source status as `partial` or `failed`.
5. Extract concise usage details from card body/comments/checklists when available.

Preferred tool payload:

```text
codecks_card_list_done_within_timeframe({
  since: "2026-04-19T00:00:00-04:00",
  until: "2026-04-27T00:00:00-04:00",
  mode: "cards",
  limit: 200,
  scanLimit: 3000,
  format: "json"
})
```

Use ISO 8601 datetimes with an explicit timezone offset or `Z`. Treat `since` as inclusive. Treat `until` as the upper window bound supplied to the tool; for weekly windows, prefer the next local midnight so the requested end date is unambiguous.

Do not call `codecks_card_search` with `location: "done"` unless the current tool schema explicitly supports that location. Search results are not done-transition evidence by themselves.

## Source Status Labels

- `available`: Codecks transition query succeeded and produced in-window records, or a confirmed quiet window.
- `empty`: Codecks transition query succeeded and found no in-window records.
- `partial`: Codecks card metadata was available, but done-transition timeframe evidence was unavailable or incomplete.
- `failed`: Codecks could not be queried or the timeframe query failed.
- `not requested`: Codecks was not requested or selected.

If Codecks is only used to enrich card codes found in another source, label it `partial` and state that done-transition evidence was not independently collected.

## URL Construction Rules

When including Codecks card references in changelog output, use full short URLs.

1. Resolve account/domain `tld` from current Codecks workspace context.
2. Normalize short id by removing leading `$` if present.
3. Construct URL as:

```text
https://<tld>.codecks.io/<short-id-no-$>
```

Examples:
- Raw short id: `$ABC-7` -> `https://<tld>.codecks.io/ABC-7`
- Raw short id: `ABC-7` -> `https://<tld>.codecks.io/ABC-7`

Output context guidance:
- Markdown-friendly output: `[ABC-7](https://<tld>.codecks.io/ABC-7)`
- Non-markdown output: place URL links in a nested bullet list under the parent change item
- Do not wrap markdown links in additional grouping parentheses

Non-markdown example:

```text
- Added account merge safety checks
  - https://<tld>.codecks.io/ABC-7
```

If `tld` cannot be resolved, do not emit a guessed URL. Return actionable guidance.

## Classification Hints

- Feature: tags/title include feature or enhancement language
- Bug fix: tags/title include bug, fix, hotfix
- Other improvements: docs, chores, refactors, maintenance
- Breaking change: explicit mention in card content/comments or strong migration warning

## Traceability Format

- Prefer full short URL references for cards
- Use markdown links when output context supports markdown
- If short id is unavailable, fall back to card ID text only

## Usage Detail Extraction

When cards describe user-facing changes, capture one practical line for adoption:
- `How to access: Window > Missions > Skip Intro`
- `How to access: Settings > Gameplay > Intro Sequence`

Prefer explicit card wording. If cards do not include usable access details, omit the line.
Check resolvables, comments, and other information on the card when available.
