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
    mean: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    sampleStandardDeviation: number | null;
    sampleVariance: number | null;
    lowOutlierBound: number | null;
    highOutlierBound: number | null;
    statisticsAvailable: boolean;
    varianceAvailable: boolean;
    percentileMethod: "inclusive_linear_interpolation";
};

export const DAY_MS = 24 * 60 * 60 * 1000;

export const toUtcDate = (value: string): Date => new Date(`${value}T00:00:00.000Z`);
export const toIsoDate = (value: Date): string => value.toISOString().slice(0, 10);
export const addDays = (value: Date, days: number): Date => new Date(value.getTime() + days * DAY_MS);

export const mondayOnOrBefore = (value: Date): Date => {
    const offset = (value.getUTCDay() + 6) % 7;
    return addDays(value, -offset);
};

export const roundForPresentation = (value: number, digits = 2): number => {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
};

const percentileInclusive = (values: number[], percentile: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 1) return sorted[0];
    const index = (sorted.length - 1) * percentile;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
};

/**
 * Model Run-level effort evenly over inclusive calendar days. Values remain at
 * full precision; callers round only when rendering artifacts.
 */
export const buildWeeklyPeriods = (runs: VelocityRun[]): VelocityPeriod[] => {
    const values = new Map<string, number>();
    for (const run of runs) {
        if (!run.startDate || !run.endDate) continue;
        const start = toUtcDate(run.startDate);
        const end = toUtcDate(run.endDate);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
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
            const endDate = toIsoDate(addDays(start, 6));
            return { startDate, endDate, label: `${startDate} to ${endDate}`, effort };
        });
};

export const buildBiweeklyPeriods = (weeks: VelocityPeriod[], anchorDate = "1970-01-05"): VelocityPeriod[] => {
    const parsedAnchor = toUtcDate(anchorDate);
    if (Number.isNaN(parsedAnchor.getTime()) || parsedAnchor.getUTCDay() !== 1) {
        throw new Error("Biweekly anchor must be a valid Monday in YYYY-MM-DD format.");
    }
    const values = new Map<string, number>();
    for (const week of weeks) {
        const start = toUtcDate(week.startDate);
        const offset = Math.floor((start.getTime() - parsedAnchor.getTime()) / DAY_MS);
        const normalizedOffset = ((offset % 14) + 14) % 14;
        const bucketStart = addDays(start, -normalizedOffset);
        const key = toIsoDate(bucketStart);
        values.set(key, (values.get(key) ?? 0) + week.effort);
    }

    return [...values.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([startDate, effort]) => {
            const start = toUtcDate(startDate);
            const endDate = toIsoDate(addDays(start, 13));
            return { startDate, endDate, label: `${startDate} to ${endDate}`, effort };
        });
};

export const summarizeVelocityPeriods = (periods: VelocityPeriod[]): VelocitySummary => {
    const values = periods.map((period) => period.effort).filter(Number.isFinite);
    const sampleWeeks = values.length;
    const totalEffortRaw = values.reduce((total, value) => total + value, 0);
    const meanRaw = sampleWeeks > 0 ? totalEffortRaw / sampleWeeks : null;
    const p25Raw = percentileInclusive(values, 0.25);
    const p50Raw = percentileInclusive(values, 0.5);
    const p75Raw = percentileInclusive(values, 0.75);
    const sampleVarianceRaw = sampleWeeks > 1 && meanRaw !== null
        ? values.reduce((total, value) => total + (value - meanRaw) ** 2, 0) / (sampleWeeks - 1)
        : null;
    const iqr = p25Raw !== null && p75Raw !== null ? p75Raw - p25Raw : null;
    return {
        sampleWeeks,
        totalEffort: roundForPresentation(totalEffortRaw),
        mean: meanRaw === null ? null : roundForPresentation(meanRaw),
        p25: p25Raw === null ? null : roundForPresentation(p25Raw),
        p50: p50Raw === null ? null : roundForPresentation(p50Raw),
        p75: p75Raw === null ? null : roundForPresentation(p75Raw),
        sampleStandardDeviation: sampleVarianceRaw === null ? null : roundForPresentation(Math.sqrt(sampleVarianceRaw)),
        sampleVariance: sampleVarianceRaw === null ? null : roundForPresentation(sampleVarianceRaw),
        lowOutlierBound: iqr === null || p25Raw === null ? null : roundForPresentation(p25Raw - 1.5 * iqr),
        highOutlierBound: iqr === null || p75Raw === null ? null : roundForPresentation(p75Raw + 1.5 * iqr),
        statisticsAvailable: sampleWeeks > 0,
        varianceAvailable: sampleWeeks > 1,
        percentileMethod: "inclusive_linear_interpolation",
    };
};

export const escapeCsv = (value: unknown): string => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
};
