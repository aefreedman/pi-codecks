---
name: codecks-velocity-reporting
description: Build provenance-rich velocity reports from reusable factual Codecks Run and delivered-card observations, with explicit measures, transformations, gaps, partial periods, rosters, statistics, and artifacts.
allowed-tools: codecks_velocity_observations_update codecks_velocity_report codecks_user_lookup
---

# Codecks Velocity Reporting

Use this skill for repeatable capacity and delivery reporting. Keep factual retrieval separate from analytical policy.

## Workflow

1. Call `codecks_velocity_observations_update` with a caller-owned `observationsPath` inside the active workspace. Incremental refresh uses a 10-day overlap by default; use an explicit date window or full refresh to repair older history.
2. Reuse that cache for one or more `codecks_velocity_report` calls. Report generation does not query Codecks.
3. Choose the factual measure:
   - `calendar_delivered` buckets cards by delivery date and includes cards outside Runs. This is the `standard_velocity` capacity default.
   - `run_attributed` uses completed-Run `stats.finishStats` snapshots and models multi-week effort evenly across calendar days.
4. State the date range, configuration selection, roster/team scope, exclusions, gap and partial-period policy, completeness, missing-effort coverage, and sample count.
5. Request `csvPath`, `summaryMarkdownPath`, or both only when artifacts are wanted. They are independent workspace-contained outputs.

## Transformations and presets

`standard_velocity` expands every applied transformation in the returned manifest. It uses calendar-delivered effort, counts complete empty weeks as zero, shows but excludes partial boundary weeks from statistics, and keeps incomplete retrieval unknown. Use `gapPolicy: show_exclude_from_statistics` to display complete zero weeks without including them in statistics.

Use `excludeDecks` with stable deck IDs or unambiguous exact titles to remove non-production cards such as those in a `Test` deck from `calendar_delivered` reports. Deck exclusions appear as a separate manifest transformation with card references and known excluded effort. They are rejected for `run_attributed` reports because Run snapshots cannot safely subtract per-deck cards.

Run-label exclusions apply only to `run_attributed` reports. Defaults are `vacation`, `holiday`, `break`, and `leave`; `excludeLabels` replaces them, `[]` disables them, and `additionalExcludeLabels` extends them. Calendar-delivered exclusions must be explicit organization/team/person date ranges in report or roster input; the tool does not infer leave from Run labels.

Configuration filtering is optional because effort is treated as universal within one Codecks organization. Use an exact stable configuration ID where possible. An exact visible name is accepted only when unambiguous. Mixed configurations and Run lengths retain provenance and may be normalized together.

## Rosters and participation

A roster maps stable Codecks user IDs to report names and optional teams, membership dates, and explicit date exclusions. JSON and simple YAML `members` lists are supported. Use `codecks_user_lookup` when an ID is unknown.

```yaml
members:
  - name: Alex
    userId: <Codecks user UUID>
    team: Delivery
    fromDate: 2026-02-02
  - name: Sam
    userId: <Codecks user UUID>
    team: Delivery
```

Roster dates are user-supplied interpretation metadata. Missing Codecks assignee entries do not prove zero effort or non-participation, and the report does not proportionally clip Run effort.

## Data integrity and interpretation

- An explicit effort of zero is an observation. Missing Run `finishStats`, a missing done bucket, and a missing card estimate remain distinct missing states.
- Reports continue summing known card effort while disclosing missing-estimate counts. Incomplete retrieval periods remain unavailable rather than becoming zero.
- Weekly Run normalization is modeled allocation, not observed day-by-day completion. Calendar-delivered cards are bucketed directly by delivery date.
- Fixed biweekly periods use a stable Monday anchor (`1970-01-05` by default) or a caller-supplied Monday.
- Mean and P25/P50/P75 are unavailable for an empty sample. Sample variance and standard deviation require at least two periods. Percentiles use inclusive linear interpolation and need not be observed values.
- Treat P25 as conservative history, P50 as typical history, and P75 as demonstrated stretch—not commitments. Always report sample weeks and composition.
- Effort points are not hours. Comparisons across teams or organizations require user-supplied context even though configurations inside one organization share the package's universal-effort assumption.
