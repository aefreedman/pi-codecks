import {
  mergeObservationCache,
  type DeliveredCardObservation,
  type ObservationCache,
  type RunObservation,
} from "../src/velocity-observations.ts";

const done = (effort: number | null, status: "observed" | "missing_finish_stats" | "missing_done_bucket" = effort === null ? "missing_finish_stats" : "observed") => ({
  count: effort === null ? null : 1,
  effort,
  noEffort: 0,
  effortStatus: status,
});

export const runObservation = (overrides: Partial<RunObservation> = {}): RunObservation => ({
  key: "run-1",
  runId: "run-1",
  accountSeq: 1,
  label: "Run 1",
  startDate: "2026-02-02",
  endDate: "2026-02-08",
  completedAt: "2026-02-09T00:00:00.000Z",
  configuration: { id: "config-a", name: "Delivery", color: "blue" },
  runWide: done(10),
  assignees: { "user-a": done(6) },
  source: "stats.finishStats",
  warnings: [],
  ...overrides,
});

export const cardObservation = (overrides: Partial<DeliveredCardObservation> = {}): DeliveredCardObservation => ({
  key: "card-1",
  cardId: "card-1",
  accountSeq: 101,
  shortCode: "$abc",
  title: "Delivered card",
  deliveredAt: "2026-02-03T12:00:00.000Z",
  effort: 3,
  effortStatus: "observed",
  assignee: { id: "user-a", name: "Alex" },
  runId: "run-1",
  deck: { id: "deck-main", title: "Main", accountSeq: 1 },
  currentStatus: "done",
  currentDerivedStatus: "done",
  currentVisibility: "default",
  activityId: "activity-1",
  warnings: [],
  ...overrides,
});

export const observationCache = (overrides: Partial<ObservationCache> = {}): ObservationCache => {
  const runs = [
    runObservation(),
    runObservation({ key: "run-2", runId: "run-2", accountSeq: 2, label: "Two-week Run", startDate: "2026-02-09", endDate: "2026-02-22", completedAt: "2026-02-23T00:00:00.000Z", runWide: done(28), assignees: { "user-a": done(14) } }),
    runObservation({ key: "run-zero", runId: "run-zero", accountSeq: 3, label: "Observed zero", startDate: "2026-02-23", endDate: "2026-03-01", completedAt: "2026-03-02T00:00:00.000Z", runWide: done(0), assignees: {} }),
  ];
  const cards = [
    cardObservation(),
    cardObservation({ key: "card-zero", cardId: "card-zero", shortCode: "$zero", deliveredAt: "2026-02-10T12:00:00.000Z", effort: 0, effortStatus: "observed", runId: "run-other" }),
    cardObservation({ key: "card-missing", cardId: "card-missing", shortCode: "$miss", deliveredAt: "2026-02-11T12:00:00.000Z", effort: null, effortStatus: "missing_estimate", runId: null, warnings: ["missing estimate"] }),
    cardObservation({ key: "card-unassigned", cardId: "card-unassigned", shortCode: "$free", deliveredAt: "2026-02-18T12:00:00.000Z", effort: 5, assignee: { id: null, name: null }, runId: null }),
  ];
  return {
    ...mergeObservationCache({
      account: "example", baseUrl: "https://api.codecks.io", now: "2026-03-02T12:00:00.000Z",
      mode: "full", overlapDays: 10, from: "2026-02-02", to: "2026-03-01", runs, cards,
      scannedActivities: 100, scanLimit: 10000, scanLimitReached: false,
    }),
    ...overrides,
  };
};
