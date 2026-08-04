import assert from "node:assert/strict";

import {
  buildBiweeklyPeriods,
  buildWeeklyPeriods,
  summarizeVelocityPeriods,
} from "../src/velocity-report.ts";
import {
  buildVelocityCsv,
  buildVelocityMarkdown,
  buildVelocityReport,
  createDeliveredCardObservation,
  createRunObservation,
  mergeObservationCache,
  parseVelocityRosterText,
  validateObservationCache,
} from "../src/velocity-observations.ts";
import { cardObservation, observationCache, runObservation } from "./velocity-fixtures.ts";

const weekly = buildWeeklyPeriods([
  { accountSeq: 1, label: "One week", startDate: "2026-02-02", endDate: "2026-02-08", effort: 10 },
  { accountSeq: 2, label: "Two weeks", startDate: "2026-02-09", endDate: "2026-02-22", effort: 28 },
]);
assert.deepEqual(weekly.map(({ startDate, endDate, effort }) => ({ startDate, endDate, effort })), [
  { startDate: "2026-02-02", endDate: "2026-02-08", effort: 10 },
  { startDate: "2026-02-09", endDate: "2026-02-15", effort: 14 },
  { startDate: "2026-02-16", endDate: "2026-02-22", effort: 14 },
]);
assert.equal(buildWeeklyPeriods([{ accountSeq: 3, label: "precision", startDate: "2026-02-02", endDate: "2026-02-04", effort: 1 }])[0].effort, 1);

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
  statisticsAvailable: true,
  varianceAvailable: true,
  percentileMethod: "inclusive_linear_interpolation",
});
assert.deepEqual(summarizeVelocityPeriods([]), {
  sampleWeeks: 0, totalEffort: 0, mean: null, p25: null, p50: null, p75: null,
  sampleStandardDeviation: null, sampleVariance: null, lowOutlierBound: null, highOutlierBound: null,
  statisticsAvailable: false, varianceAvailable: false, percentileMethod: "inclusive_linear_interpolation",
});
assert.equal(summarizeVelocityPeriods([{ startDate: "2026-02-02", endDate: "2026-02-08", label: "one", effort: 4 }]).sampleVariance, null);
assert.deepEqual(buildBiweeklyPeriods(weekly).map(({ startDate, endDate, effort }) => ({ startDate, endDate, effort })), [
  { startDate: "2026-02-02", endDate: "2026-02-15", effort: 24 },
  { startDate: "2026-02-16", endDate: "2026-03-01", effort: 14 },
]);
assert.throws(() => buildBiweeklyPeriods(weekly, "2026-02-03"), /Monday/);

const missingRun = createRunObservation({ id: "run-missing", accountSeq: 9, completedAt: "2026-02-09T00:00:00Z" });
assert.equal(missingRun.runWide.effort, null);
assert.equal(missingRun.runWide.effortStatus, "missing_finish_stats");
const zeroRun = createRunObservation({ id: "run-zero", accountSeq: 10, completedAt: "2026-02-09T00:00:00Z", stats: { finishStats: { progress: { done: [1, 0, 0] } } } });
assert.equal(zeroRun.runWide.effort, 0);
assert.equal(zeroRun.runWide.effortStatus, "observed");
const missingCard = createDeliveredCardObservation({ cardId: "card-missing", doneAt: "2026-02-03T00:00:00Z" });
assert.equal(missingCard.effort, null);
assert.equal(missingCard.effortStatus, "missing_estimate");

const cache = observationCache();
const calendar = buildVelocityReport(cache);
assert.equal(calendar.measure, "calendar_delivered");
assert.equal(calendar.subjects[0].periods.length, 4);
assert.deepEqual(calendar.subjects[0].periods.map((period) => period.knownEffort), [3, 0, 5, 0]);
assert.equal(calendar.subjects[0].periods[1].missingEffortCount, 1);
assert.equal(calendar.subjects[0].summary.sampleWeeks, 4);
assert(calendar.transformations.every((entry) => entry.contractVersion === 1));
assert(calendar.transformations.some((entry) => entry.name === "bucket_calendar_weeks"));
assert(calendar.subjects[0].periods[2].contributingCards.includes("$free"), "unassigned delivered cards must be included organization-wide");

const deckCache = observationCache({ deliveredCards: {
  real: cardObservation({ key: "real", cardId: "real", effort: 5, deck: { id: "deck-main", title: "Main", accountSeq: 1 } }),
  test: cardObservation({ key: "test", cardId: "test", shortCode: "$test", effort: 8, deck: { id: "deck-test", title: "Test", accountSeq: 2 } }),
} });
const withoutTestDeck = buildVelocityReport(deckCache, { excludeDecks: ["Test"] });
assert.equal(withoutTestDeck.subjects[0].periods[0].knownEffort, 5);
assert(withoutTestDeck.transformations.some((entry) => entry.name === "exclude_decks" && entry.excludedReferences[0]?.reference === "$test"));
assert.throws(() => buildVelocityReport(deckCache, { measure: "run_attributed", excludeDecks: ["Test"] }), /only for calendar_delivered/);
assert.throws(() => buildVelocityReport(deckCache, { excludeDecks: ["missing"] }), /was not found/);

const person = buildVelocityReport(cache, { user: "Alex", userId: "user-a" });
assert.deepEqual(person.subjects[0].periods.map((period) => period.knownEffort), [3, 0, 0, 0]);
const noGapStats = buildVelocityReport(cache, { gapPolicy: "show_exclude_from_statistics" });
assert.equal(noGapStats.subjects[0].summary.sampleWeeks, 3, "one complete empty week should be shown but excluded from statistics");
const partial = buildVelocityReport(cache, { fromDate: "2026-02-04", toDate: "2026-02-25" });
assert.equal(partial.subjects[0].periods[0].completeness, "partial_boundary");
assert.equal(partial.subjects[0].periods[0].includedInStatistics, false);

const runReport = buildVelocityReport(cache, { measure: "run_attributed", excludeLabels: [] });
assert.deepEqual(runReport.subjects[0].periods.map((period) => period.knownEffort), [10, 14, 14, 0]);
assert.equal(runReport.subjects[0].periods[3].valueKind, "modeled", "an observed zero Run is not a gap");
const missingRunCache = observationCache({ runs: { missing: runObservation({ key: "missing", runId: "missing", runWide: { count: null, effort: null, noEffort: null, effortStatus: "missing_finish_stats" } }) } });
assert.equal(buildVelocityReport(missingRunCache, { measure: "run_attributed", excludeLabels: [] }).subjects[0].periods[0].knownEffort, null);

const ambiguous = observationCache({ runs: {
  a: runObservation({ key: "a", runId: "a", configuration: { id: "one", name: "Delivery", color: "blue" } }),
  b: runObservation({ key: "b", runId: "b", configuration: { id: "two", name: "Delivery", color: "blue" } }),
} });
assert.throws(() => buildVelocityReport(ambiguous, { sprintConfig: "Delivery" }), /ambiguous/);
assert.equal(buildVelocityReport(ambiguous, { sprintConfig: "one", measure: "run_attributed", excludeLabels: [] }).configurationSelection[0].id, "one");
const calendarFiltered = buildVelocityReport(observationCache({ deliveredCards: {
  selected: cardObservation({ key: "selected", cardId: "selected", runId: "a", effort: 2 }),
  other: cardObservation({ key: "other", cardId: "other", runId: "b", effort: 9 }),
  free: cardObservation({ key: "free", cardId: "free", runId: null, effort: 7 }),
}, runs: {
  a: runObservation({ key: "a", runId: "a", configuration: { id: "one", name: "One", color: null } }),
  b: runObservation({ key: "b", runId: "b", configuration: { id: "two", name: "Two", color: null } }),
} }), { sprintConfig: "one" });
assert.equal(calendarFiltered.subjects[0].periods[0].knownEffort, 2);
assert.equal(calendarFiltered.transformations.find((entry) => entry.name === "select_calendar_configuration")?.excludedReferences.length, 2);
assert.throws(() => buildVelocityReport(cache, { roster: { members: [{ name: "Alex", userId: "user-a", team: "A", exclusions: [] }], exclusions: [] }, team: "Typo" }), /refusing to broaden/);
assert.throws(() => buildVelocityReport(cache, { fromDate: "2026-02-30" }), /real date/);
assert.throws(() => buildVelocityReport(cache, { fromDate: "2026-03-01", toDate: "2026-02-01" }), /must not be after/);

const roster = parseVelocityRosterText("members:\n  - name: Alex\n    userId: user-a\n    fromDate: 2026-02-02\n");
assert.equal(roster.members[0].name, "Alex");
assert.throws(() => parseVelocityRosterText('{"members":[{"name":"Bad","userId":"x","fromDate":"2026-02-30"}]}'), /real date/);
const excluded = buildVelocityReport(cache, { dateExclusions: [{ fromDate: "2026-02-09", toDate: "2026-02-15", scope: "organization", reason: "leave" }] });
assert(!excluded.subjects[0].periods.some((period) => period.startDate === "2026-02-09"));

const corrected = mergeObservationCache({
  existing: cache, account: "example", baseUrl: "https://api.codecks.io", now: "2026-03-03T00:00:00Z",
  mode: "incremental", overlapDays: 10, from: "2026-02-20", to: "2026-03-03",
  runs: [runObservation({ key: "run-zero", runId: "run-zero", accountSeq: 3, startDate: "2026-02-23", endDate: "2026-03-01", completedAt: "2026-03-02T00:00:00Z", runWide: { count: 1, effort: 2, noEffort: 0, effortStatus: "observed" } })],
  cards: [cardObservation({ key: "card-new", cardId: "card-new", deliveredAt: "2026-02-24T00:00:00Z" })],
  scannedActivities: 2, scanLimit: 10, scanLimitReached: false,
});
assert.equal(Object.values(corrected.runs).filter((run) => run.key === "run-zero").length, 1);
assert.equal(corrected.runs["run-zero"].runWide.effort, 2);
assert.equal(corrected.refresh.overlapDays, 10);
assert.equal(corrected.refresh.replacedRuns, 1);
const truncated = mergeObservationCache({
  existing: cache, account: "example", baseUrl: "https://api.codecks.io", now: "2026-03-03T00:00:00Z", mode: "full", overlapDays: 10,
  from: "2026-02-02", to: "2026-03-01", runs: [], cards: [], scannedActivities: 10, scanLimit: 10, scanLimitReached: true,
});
assert.equal(Object.keys(truncated.deliveredCards).length, Object.keys(cache.deliveredCards).length, "incomplete full refresh must preserve prior cards");
assert.equal(truncated.refresh.removedCards, 0);
assert.equal(truncated.coverage.deliveredCards[0].status, "incomplete");
assert(truncated.coverage.runs.some((entry) => entry.status === "complete"));
const repaired = mergeObservationCache({
  existing: truncated, account: "example", baseUrl: "https://api.codecks.io", now: "2026-03-04T00:00:00Z", mode: "incremental", overlapDays: 10,
  from: "2026-02-20", to: "2026-03-08", runs: [], cards: [], scannedActivities: 0, scanLimit: 10, scanLimitReached: false,
});
assert.equal(buildVelocityReport(repaired).subjects[0].periods[0].completeness, "missing_data", "a later complete overlap must not certify older incomplete coverage");
const malformedNested = structuredClone(cache) as any;
malformedNested.deliveredCards["card-1"].effortStatus = "observed";
malformedNested.deliveredCards["card-1"].effort = null;
assert.throws(() => validateObservationCache(malformedNested), /inconsistent effort state/);
const malformedRunCache = observationCache({ runs: { bad: runObservation({ key: "bad", runId: "bad", startDate: "2026-02-20", endDate: "2026-02-10" }) } });
const malformedRunReport = buildVelocityReport(malformedRunCache, { measure: "run_attributed", excludeLabels: [] });
assert(malformedRunReport.transformations.find((entry) => entry.name === "normalize_run_effort_to_weeks")?.excludedReferences.some((entry) => entry.reference === "bad"));
assert.throws(() => mergeObservationCache({ existing: cache, account: "other", baseUrl: "x", now: "x", mode: "full", overlapDays: 10, from: "2026-01-01", to: "2026-01-02", runs: [], cards: [], scannedActivities: 0, scanLimit: 1, scanLimitReached: false }), /belongs to/);

const csv = buildVelocityCsv(calendar, cache);
assert.match(csv, /raw_run/);
assert.match(csv, /raw_delivered_card/);
assert.match(csv, /transformation/);
const escapedCache = observationCache({ deliveredCards: { escaped: cardObservation({ key: "escaped", cardId: "escaped", title: "comma, quote \" and newline\nvalue" }) } });
assert.match(buildVelocityCsv(buildVelocityReport(escapedCache), escapedCache), /"comma, quote "" and newline/);
const markdown = buildVelocityMarkdown(buildVelocityReport(observationCache({ deliveredCards: { escaped: cardObservation({ key: "escaped", cardId: "escaped", title: "unsafe | <tag>" }) } })));
assert(!markdown.includes("unsafe | <tag>"));

console.log("velocity-report tests passed");
