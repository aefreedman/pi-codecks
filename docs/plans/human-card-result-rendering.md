# Human-Facing Card Result Rendering Plan

## Goal

Replace the expanded `codecks_card_get` TUI result's raw structured JSON envelope with a readable, properly aligned card presentation. Keep the agent-facing tool result and all network behavior unchanged.

## Scope

### In scope

- Add an internal, pure presentation path for the partial card data already present in a successful `codecks_card_get` result.
- Use it only from the TUI `renderResult` path for `codecks_card_get`.
- Make the TUI presentation independent of the requested agent-facing output format: `format: "text"` retains its legacy text content while the TUI receives the same structured card presentation data from the single retrieval.
- Preserve the existing collapsed summary.
- Render expanded success results as aligned human-readable text.
- Render expanded errors as concise human-readable errors.
- Fall back safely to the existing raw result when the structured payload cannot be parsed or does not have the expected shape.
- Add focused rendering tests and an Unreleased changelog entry.

### Out of scope

- Changes to `card_get.execute`, `toStructuredResult`, or the agent-visible tool content.
- API calls, enrichment, retries, or fetching missing presentation fields.
- Changes to `codecks_card_get_formatted` or other Codecks tools.
- A new agent-facing formatting tool or public formatting API.
- Broad renderer refactoring unrelated to card-get presentation.

## Approved presentation

A full expanded card should resemble:

```text
$5o9  Improve card retrieval output

Status      In progress
Type        Regular card
Priority    B
Effort      3
Deck        Development
Milestone   Next Release
Assignee    Aaron
Tags        tooling, codecks
Due         May 15, 2026
Updated     Apr 29, 2026

Review and improve the structured card output.

Parent
  $5n8   Improve Codecks presentation

Children
  $5oa   Add compact renderer   Not started
  $5ob   Add renderer tests     In progress
```

### Formatting contract

1. **Heading**
   - Render `<shortCode>  <title>` when both exist.
   - Render whichever value exists when only one is available.
   - Use `(untitled)` only when no usable title exists.

2. **Metadata table**
   - Candidate rows, in order: Status, Type, Priority, Effort, Deck, Milestone, Assignee, Tags, Due, Updated.
   - Omit unavailable or empty values rather than printing placeholders.
   - Align every value at one shared column based on the longest included label.
   - Build alignment before applying ANSI theme styling so styling cannot alter column widths.
   - Keep a consistent gap between label and value.
   - Prefer `derivedStatus`, falling back to `status`.
   - Present enum-like values for people: words rather than raw snake_case where practical; preserve unknown values safely.
   - Render effort as the available value without inventing units beyond the `Effort` label.
   - Read nested deck, milestone, and assignee display values defensively.
   - Join available tags with `, `.
   - Render valid dates in a concise human-readable form; preserve an unparseable non-empty date rather than dropping it.

3. **Content**
   - Preserve the card content as supplied.
   - Separate it from metadata with one blank line.
   - Do not add a redundant `Content` heading.
   - Omit empty content.

4. **Relations**
   - Show Parent and Children sections only when corresponding data exists.
   - Indent relation rows by two spaces.
   - Align short-code, title, and optional status columns within each relation section using the available rows.
   - Use only relation fields already present; do not enrich.

5. **Terminal width**
   - Never allow rendered lines to exceed the width supplied by Pi.
   - Preserve metadata alignment at ordinary widths.
   - At constrained widths, degrade predictably through the existing truncation behavior rather than producing malformed columns or throwing.
   - Alignment calculations must use unstyled source text; apply color/bold styling afterward.

6. **Styling**
   - Use Pi theme styling sparingly for the heading, labels, and error state.
   - Keep the unstyled output readable in tests and fallback themes.
   - Do not emit Markdown headings, tables, JSON fences, or transport fields such as `ok`, `action`, and `data`.

7. **Errors and fallback**
   - For a parsed failed payload, show `Couldn’t retrieve card` followed by the error message and useful recovery hint if available.
   - Do not expose the raw JSON envelope in the normal expanded error view.
   - If parsing fails, retain the current raw-text fallback so information is not lost.

## Implementation seams

Primary files:

- `index.ts`
  - Keep `parseStructuredPayload` as the transport parser.
  - Add small defensive helpers that adapt `payload.data.card` into presentation rows.
  - Add a dedicated expanded `card_get` renderer.
  - When callers request `format: "text"`, execute the single card-get retrieval in internal JSON mode, derive the exact existing text response from that structured payload, and retain the payload in result details for TUI rendering. No additional request or enrichment is permitted.
  - Route only `exportName === "card_get"` through it; preserve generic behavior for every other tool.
- `tests/tool-rendering.test.ts`
  - Replace the expanded JSON expectation for card-get with human-readable assertions.
  - Cover full, partial, error, malformed-fallback, relation alignment, and constrained-width behavior.
- `CHANGELOG.md`
  - Add a concise entry under `## Unreleased`.

Keep the formatter internal unless implementation reveals a clear existing internal module boundary. Do not create a public API merely for hypothetical reuse.

## Validation contract

Run from the `pi-codecks` manifest root:

```bash
npx tsx tests/tool-rendering.test.ts
npm run typecheck
npm test
```

Acceptance evidence:

- `codecks_card_get` collapsed rendering remains concise and unchanged in meaning.
- Expanded successful card-get output contains aligned labels and readable card content, not a JSON fence or transport envelope.
- Full and partial cards render without placeholders or exceptions.
- Parent/children render only from available data and align consistently.
- Expanded structured errors are readable; malformed/unrecognized results retain a raw fallback.
- Every rendered line respects the requested terminal width in focused tests.
- Other Codecks tools retain their existing generic expanded rendering.
- Typecheck and package tests pass.

## Subagent implementation workflow

1. **Single writer:** one `worker` implements this plan on branch `feat/human-card-result-rendering` in the existing `pi-codecks` checkout. No other agent writes concurrently.
2. **Independent review:** after implementation, fresh-context reviewers inspect the actual diff with distinct lanes:
   - rendering correctness, partial payload safety, and regression risk;
   - test coverage, width/alignment assertions, and scope discipline.
3. **Fix pass:** the parent synthesizes findings and delegates one writer fix pass only for accepted in-scope issues.
4. **Final verification:** rerun focused rendering tests, typecheck, and the package unit suite; parent inspects the final diff.

## Stop and escalation rules

Stop and ask the parent rather than expanding scope if implementation appears to require:

- changing agent-facing tool content;
- adding API requests or card enrichment;
- modifying multiple other tools;
- introducing a public formatter/tool;
- selecting a materially different presentation design.
