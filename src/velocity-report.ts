export type VelocityRun = {
    accountSeq: number | null;
    label: string;
    startDate: string | null;
    endDate: string | null;
    effort: number;
};

export type VelocityPeriod = {
    startDate: string;
    endDate: string;
    label: string;
    effort: number;
};

export type VelocitySummary = {
    sampleWeeks: number;
    totalEffort: number;
    mean: number;
    p25: number;
    p50: number;
    p75: number;
    sampleStandardDeviation: number;
    sampleVariance: number;
    lowOutlierBound: number;
    highOutlierBound: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const toUtcDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);
const addDays = (value: Date, days: number): Date => new Date(value.getTime() + days * DAY_MS);

const mondayOnOrBefore = (value: Date): Date => {
    const offset = (value.getUTCDay() + 6) % 7;
    return addDays(value, -offset);
};

const round = (value: number, digits = 2): number => {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
};

const percentileInclusive = (values: number[], percentile: number): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 1) return sorted[0];
    const index = (sorted.length - 1) * percentile;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

export const buildWeeklyPeriods = (runs: VelocityRun[]): VelocityPeriod[] => {
    const values = new Map<string, number>();
    for (const run of runs) {
        if (!run.startDate || !run.endDate) continue;
        const start = toUtcDate(run.startDate);
        const end = toUtcDate(run.endDate);
        const dayCount = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;
        if (dayCount <= 0) continue;

        for (let day = start; day <= end; day = addDays(day, 1)) {
            const bucketStart = mondayOnOrBefore(day);
            const key = toIsoDate(bucketStart);
            values.set(key, (values.get(key) ?? 0) + run.effort / dayCount);
        }
    }

    return [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([startDate, effort]) => {
            const start = toUtcDate(startDate);
            return {
                startDate,
                endDate: toIsoDate(addDays(start, 6)),
                label: `${startDate} to ${toIsoDate(addDays(start, 6))}`,
                effort: round(effort),
            };
        });
};

export const buildBiweeklyPeriods = (weeks: VelocityPeriod[]): VelocityPeriod[] => {
    const values = new Map<string, number>();
    for (const week of weeks) {
        const start = toUtcDate(week.startDate);
        const anchor = new Date(start);
        const epoch = toUtcDate("1970-01-05").getTime();
        const offset = Math.floor((start.getTime() - epoch) / DAY_MS);
        anchor.setTime(start.getTime() - (offset % 14) * DAY_MS);
        const key = toIsoDate(anchor);
        values.set(key, (values.get(key) ?? 0) + week.effort);
    }

    return [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([startDate, effort]) => {
            const start = toUtcDate(startDate);
            return {
                startDate,
                endDate: toIsoDate(addDays(start, 13)),
                label: `${startDate} to ${toIsoDate(addDays(start, 13))}`,
                effort: round(effort),
            };
        });
};

export const summarizeVelocityPeriods = (periods: VelocityPeriod[]): VelocitySummary => {
    const values = periods.map((period) => period.effort);
    const sampleWeeks = values.length;
    const totalEffort = round(values.reduce((total, value) => total + value, 0));
    const mean = sampleWeeks > 0 ? totalEffort / sampleWeeks : 0;
    const p25 = percentileInclusive(values, 0.25);
    const p50 = percentileInclusive(values, 0.5);
    const p75 = percentileInclusive(values, 0.75);
    const sampleVariance = sampleWeeks > 1
        ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (sampleWeeks - 1)
        : 0;
    const iqr = p75 - p25;
    return {
        sampleWeeks,
        totalEffort,
        mean: round(mean),
        p25: round(p25),
        p50: round(p50),
        p75: round(p75),
        sampleStandardDeviation: round(Math.sqrt(sampleVariance)),
        sampleVariance: round(sampleVariance),
        lowOutlierBound: round(p25 - 1.5 * iqr),
        highOutlierBound: round(p75 + 1.5 * iqr),
    };
};

export const escapeCsv = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};
