---
name: codecks-velocity-reporting
description: Build statistically grounded per-person or roster-based velocity reports from completed Codecks Runs. Use for effort history, capacity projections, Mean/P25/P50/P75/variance analysis, weekly or biweekly trends, and CSV or Markdown report outputs.
allowed-tools:
  - codecks_velocity_report
  - codecks_user_lookup
---

# Codecks Velocity Reporting

Use this skill for repeatable velocity and workload reporting. It is separate from general Codecks operations because report methodology, exclusions, normalization, and interpretation require dedicated guidance.

## Report workflow

1. Keep each Run configuration separate unless the user explicitly requests otherwise.
2. Use `codecks_velocity_report`; it queries completed Runs only, so the current Run is excluded.
3. Set `fromDate` and `toDate` using Run start dates when the requested historical range is known.
4. Request `csvPath`, `summaryMarkdownPath`, or both. They are independent outputs.
5. State the selected date range, exclusions, configuration, and whether a roster was used.

## Exclusions and normalization

- Default exclusion label patterns are `vacation`, `holiday`, `break`, and `leave`.
- Add or replace `excludeLabels` only when the user specifies a different policy. Report the final exclusion policy.
- Multi-week Runs are allocated evenly across their calendar days into Monday-aligned weeks. Do not describe those normalized weekly values as directly observed per-week completion data.
- Fixed biweekly totals use Monday-aligned 14-day periods. Do not extrapolate partial-capacity leave/break periods.

## Roster reports

Use `rosterPath` for an explicit team roster rather than inferring membership from recent assignees. JSON is supported, as is simple YAML with a `members` list.

```yaml
members:
  - name: Aaron
    userId: <Codecks user UUID>
    fromDate: 2026-02-02
  - name: Angela
    userId: <Codecks user UUID>
```

Each member requires `name` and `userId`. `fromDate` and `toDate` are optional membership bounds and are intersected with the report-wide date range. Use `codecks_user_lookup` to resolve an unknown user ID before writing the roster.

## Interpretation

- **Mean:** arithmetic average of eligible normalized weekly effort; useful as an expected-value reference but sensitive to unusually high or low weeks.
- **P25:** conservative historical capacity.
- **P50:** typical historical capacity (median).
- **P75:** demonstrated stretch capacity, not a commitment target.
- **Sample standard deviation and variance:** volatility diagnostics. Standard deviation is in effort points; variance is in squared effort points.
- **Sample weeks:** report this with every statistic. Small samples should not be over-interpreted.

Treat percentiles as empirical historical observations, not guarantees. Keep effort points distinct from hours and do not compare separate configurations as though their point scales or work patterns were interchangeable.
