import assert from "node:assert/strict";

import { buildBiweeklyPeriods, buildWeeklyPeriods, summarizeVelocityPeriods } from "../src/velocity-report.ts";

const weekly = buildWeeklyPeriods([
  { accountSeq: 1, label: "One week", startDate: "2026-02-02", endDate: "2026-02-08", effort: 10 },
  { accountSeq: 2, label: "Two weeks", startDate: "2026-02-09", endDate: "2026-02-22", effort: 28 },
]);

assert.deepEqual(weekly.map(({ startDate, endDate, effort }) => ({ startDate, endDate, effort })), [
  { startDate: "2026-02-02", endDate: "2026-02-08", effort: 10 },
  { startDate: "2026-02-09", endDate: "2026-02-15", effort: 14 },
  { startDate: "2026-02-16", endDate: "2026-02-22", effort: 14 },
]);

const summary = summarizeVelocityPeriods(weekly);
assert.deepEqual(summary, {
  sampleWeeks: 3,
  totalEffort: 38,
  mean: 12.67,
  p25: 12,
  p50: 14,
  p75: 14,
  sampleStandardDeviation: 2.31,
  sampleVariance: 5.33,
  lowOutlierBound: 9,
  highOutlierBound: 17,
});

assert.deepEqual(buildBiweeklyPeriods(weekly).map(({ startDate, endDate, effort }) => ({ startDate, endDate, effort })), [
  { startDate: "2026-02-02", endDate: "2026-02-15", effort: 24 },
  { startDate: "2026-02-16", endDate: "2026-03-01", effort: 14 },
]);

console.log("velocity-report tests passed");
