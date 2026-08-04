import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
    DAY_MS,
    addDays,
    buildBiweeklyPeriods,
    buildWeeklyPeriods,
    escapeCsv,
    mondayOnOrBefore,
    roundForPresentation,
    summarizeVelocityPeriods,
    toIsoDate,
    toUtcDate,
    type VelocityPeriod,
    type VelocityRun,
    type VelocitySummary,
} from "./velocity-report";

export const VELOCITY_CACHE_SCHEMA_VERSION = 1;
export const VELOCITY_REPORT_SCHEMA_VERSION = 2;
export const DEFAULT_OVERLAP_DAYS = 10;
export const DEFAULT_RUN_EXCLUSION_LABELS = ["vacation", "holiday", "break", "leave"];

export type EffortStatus = "observed" | "missing_finish_stats" | "missing_done_bucket" | "missing_estimate";
export type RunDoneObservation = { count: number | null; effort: number | null; noEffort: number | null; effortStatus: EffortStatus };
export type ConfigurationIdentity = { id: string | null; name: string | null; color: string | null };

export type RunObservation = {
    key: string;
    runId: string | null;
    accountSeq: number | null;
    label: string;
    startDate: string | null;
    endDate: string | null;
    completedAt: string | null;
    configuration: ConfigurationIdentity;
    runWide: RunDoneObservation;
    assignees: Record<string, RunDoneObservation>;
    source: "stats.finishStats";
    warnings: string[];
};

export type DeliveredCardObservation = {
    key: string;
    cardId: string;
    accountSeq: number | null;
    shortCode: string | null;
    title: string;
    deliveredAt: string;
    effort: number | null;
    effortStatus: "observed" | "missing_estimate";
    assignee: { id: string | null; name: string | null };
    runId: string | null;
    deck: { id: string | null; title: string | null; accountSeq: number | null };
    currentStatus: string | null;
    currentDerivedStatus: string | null;
    currentVisibility: string | null;
    activityId: string | null;
    warnings: string[];
};

export type CoverageInterval = { from: string; to: string; status: "complete" | "incomplete" };

export type ObservationCache = {
    schemaVersion: 1;
    organization: { account: string; baseUrl: string };
    createdAt: string;
    lastRefreshAt: string;
    requestedWindow: { from: string; to: string };
    coverage: { runs: CoverageInterval[]; deliveredCards: CoverageInterval[] };
    refresh: {
        mode: "incremental" | "date_window" | "full";
        overlapDays: number;
        complete: boolean;
        runCount: number;
        cardCount: number;
        replacedRuns: number;
        replacedCards: number;
        removedRuns: number;
        removedCards: number;
        scannedActivities: number;
        scanLimit: number;
        scanLimitReached: boolean;
        warnings: string[];
    };
    runs: Record<string, RunObservation>;
    deliveredCards: Record<string, DeliveredCardObservation>;
};

export type DateExclusion = {
    fromDate: string;
    toDate: string;
    reason: string;
    scope: "organization" | "team" | "person";
    team?: string;
    userId?: string;
    source?: string;
};

export type RosterMember = { name: string; userId: string; team?: string; fromDate?: string; toDate?: string; exclusions: DateExclusion[] };
export type VelocityRoster = { members: RosterMember[]; exclusions: DateExclusion[] };

export type TransformationRecord = {
    name: string;
    contractVersion: 1;
    arguments: Record<string, unknown>;
    inputCount: number;
    outputCount: number;
    excludedReferences: Array<{ reference: string; reason: string }>;
    excludedEffort: number | null;
    warnings: string[];
};

export type ReportPeriod = {
    startDate: string;
    endDate: string;
    label: string;
    alignment: "monday_week" | "fixed_biweekly";
    anchor: string;
    measure: "calendar_delivered" | "run_attributed";
    knownEffort: number | null;
    presentationEffort: number | null;
    deliveredCardCount: number;
    missingEffortCount: number;
    completeness: "complete" | "partial_boundary" | "gap" | "missing_data";
    valueKind: "observed" | "modeled" | "filled" | "unavailable";
    includedInStatistics: boolean;
    contributingCards: string[];
    contributingRuns: string[];
    configurationIds: string[];
};

export type VelocitySubjectReport = {
    name: string;
    userId: string | null;
    team: string | null;
    periods: ReportPeriod[];
    biweekly: ReportPeriod[];
    summary: VelocitySummary;
    composition: { complete: number; partial: number; gapFilled: number; excludedFromStatistics: number; missingData: number };
};

export type VelocityReport = {
    schemaVersion: 2;
    cacheSchemaVersion: 1;
    organization: ObservationCache["organization"];
    preset: string;
    measure: "calendar_delivered" | "run_attributed";
    dateWindow: { from: string; to: string };
    configurationSelection: ConfigurationIdentity[];
    transformations: TransformationRecord[];
    subjects: VelocitySubjectReport[];
    warnings: string[];
    outputs: { csvPath?: string; summaryMarkdownPath?: string };
};

type ReportOptions = {
    preset?: unknown;
    measure?: unknown;
    fromDate?: unknown;
    toDate?: unknown;
    sprintConfig?: unknown;
    excludeDecks?: unknown;
    user?: unknown;
    userId?: unknown;
    roster?: VelocityRoster;
    team?: unknown;
    excludeLabels?: unknown;
    additionalExcludeLabels?: unknown;
    dateExclusions?: unknown;
    gapPolicy?: unknown;
    partialPeriodPolicy?: unknown;
    biweekly?: unknown;
    biweeklyAnchor?: unknown;
};

export const isIsoDate = (value: unknown): value is string => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = toUtcDate(value);
    return !Number.isNaN(parsed.getTime()) && toIsoDate(parsed) === value;
};

const requireIsoDate = (value: unknown, label: string): string => {
    if (!isIsoDate(value)) throw new Error(`${label} must be a real date in YYYY-MM-DD format.`);
    return value;
};

const ensureRange = (from: string, to: string, label: string): void => {
    if (from > to) throw new Error(`${label} fromDate must not be after toDate.`);
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;

const isWithin = (root: string, candidate: string): boolean => {
    const rel = relative(root, candidate);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

const nearestExistingParent = async (candidate: string): Promise<string> => {
    let current = candidate;
    while (true) {
        try {
            await fs.lstat(current);
            return current;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            const parent = dirname(current);
            if (parent === current) throw error;
            current = parent;
        }
    }
};

export const resolveWorkspacePath = async (workspaceRoot: string, requestedPath: string, mode: "input" | "output"): Promise<string> => {
    if (!requestedPath.trim()) throw new Error("File path must not be empty.");
    const root = await fs.realpath(resolve(workspaceRoot));
    const lexical = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(root, requestedPath);
    if (!isWithin(root, lexical)) throw new Error(`Path '${requestedPath}' is outside the active workspace.`);
    if (mode === "input") {
        const canonical = await fs.realpath(lexical);
        if (!isWithin(root, canonical)) throw new Error(`Path '${requestedPath}' resolves outside the active workspace.`);
        return canonical;
    }
    try {
        const existingCanonical = await fs.realpath(lexical);
        if (!isWithin(root, existingCanonical)) throw new Error(`Output path '${requestedPath}' resolves outside the active workspace.`);
        return existingCanonical;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const existingParent = await nearestExistingParent(dirname(lexical));
    const canonicalParent = await fs.realpath(existingParent);
    if (!isWithin(root, canonicalParent)) throw new Error(`Output path '${requestedPath}' resolves outside the active workspace.`);
    const canonical = resolve(canonicalParent, relative(existingParent, lexical));
    if (!isWithin(root, canonical)) throw new Error(`Output path '${requestedPath}' resolves outside the active workspace.`);
    return canonical;
};

export const atomicWriteFile = async (path: string, contents: string, workspaceRoot?: string): Promise<void> => {
    await fs.mkdir(dirname(path), { recursive: true });
    if (workspaceRoot) {
        const root = await fs.realpath(resolve(workspaceRoot));
        const currentParent = await fs.realpath(dirname(path));
        if (!isWithin(root, currentParent) || currentParent !== dirname(path)) throw new Error(`Output path '${path}' changed identity or escaped the active workspace before write.`);
    }
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
        await fs.writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
        await fs.rename(temporary, path);
    } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
    }
};

export const assertDistinctPaths = (paths: Array<{ label: string; path?: string }>): void => {
    const seen = new Map<string, string>();
    for (const entry of paths) {
        if (!entry.path) continue;
        const normalized = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
        const previous = seen.get(normalized);
        if (previous) throw new Error(`${entry.label} and ${previous} resolve to the same file.`);
        seen.set(normalized, entry.label);
    }
};

const normalizeDone = (value: unknown, missingStatus: EffortStatus): RunDoneObservation => {
    if (!isRecord(value)) return { count: null, effort: null, noEffort: null, effortStatus: missingStatus };
    const effort = finiteOrNull(value.effort);
    return {
        count: finiteOrNull(value.count),
        effort,
        noEffort: finiteOrNull(value.noEffort),
        effortStatus: effort === null ? "missing_done_bucket" : "observed",
    };
};

const progressDone = (finishStats: Record<string, unknown>): unknown => {
    if (!isRecord(finishStats.progress)) return undefined;
    const done = finishStats.progress.done;
    if (Array.isArray(done)) return { count: finiteOrNull(done[0]), effort: finiteOrNull(done[1]), noEffort: finiteOrNull(done[2]) };
    return done;
};

export const createRunObservation = (run: Record<string, unknown>): RunObservation => {
    const config = isRecord(run.sprintConfig) ? run.sprintConfig : {};
    const stats = isRecord(run.stats) ? run.stats : undefined;
    const finishStats = stats && isRecord(stats.finishStats) ? stats.finishStats : undefined;
    const runId = textOrNull(run.id);
    const accountSeq = finiteOrNull(run.accountSeq);
    const key = runId ?? (accountSeq === null ? "" : `seq:${accountSeq}`);
    if (!key) throw new Error("Completed Run observation is missing a stable id and account sequence.");
    const assignees: Record<string, RunDoneObservation> = {};
    if (finishStats && isRecord(finishStats.assignee)) {
        for (const [userId, value] of Object.entries(finishStats.assignee)) {
            assignees[userId] = normalizeDone(isRecord(value) ? value.done : undefined, "missing_done_bucket");
        }
    }
    const warnings: string[] = [];
    const startDate = textOrNull(run.startDate);
    const endDate = textOrNull(run.endDate);
    if (!startDate || !endDate || !isIsoDate(startDate) || !isIsoDate(endDate) || startDate > endDate) warnings.push("Run dates are missing, malformed, or reversed; normalization is unavailable until corrected.");
    if (!finishStats) warnings.push("stats.finishStats is missing; Run-attributed effort is unavailable.");
    const runWide = finishStats
        ? normalizeDone(progressDone(finishStats), "missing_done_bucket")
        : normalizeDone(undefined, "missing_finish_stats");
    if (finishStats && runWide.effort === null) warnings.push("stats.finishStats.progress.done is missing; Run-attributed effort is unavailable.");
    return {
        key,
        runId,
        accountSeq,
        label: textOrNull(run.name) ?? (accountSeq === null ? "Run" : `Run ${accountSeq}`),
        startDate,
        endDate,
        completedAt: textOrNull(run.completedAt),
        configuration: { id: textOrNull(config.id), name: textOrNull(config.name), color: textOrNull(config.color) },
        runWide,
        assignees,
        source: "stats.finishStats",
        warnings,
    };
};

export const createDeliveredCardObservation = (event: Record<string, unknown>): DeliveredCardObservation => {
    const cardId = textOrNull(event.cardId);
    if (!cardId) throw new Error("Delivered-card observation is missing a stable card id.");
    const effort = finiteOrNull(event.effort);
    return {
        key: cardId,
        cardId,
        accountSeq: finiteOrNull(event.accountSeq),
        shortCode: textOrNull(event.shortCode),
        title: textOrNull(event.title) ?? "(untitled)",
        deliveredAt: String(event.doneAt ?? ""),
        effort,
        effortStatus: effort === null ? "missing_estimate" : "observed",
        assignee: { id: textOrNull(event.assigneeId), name: textOrNull(event.assigneeName) },
        runId: textOrNull(event.runId),
        deck: { id: textOrNull(event.deckId), title: textOrNull(event.deckTitle), accountSeq: finiteOrNull(event.deckAccountSeq) },
        currentStatus: textOrNull(event.currentStatus),
        currentDerivedStatus: textOrNull(event.currentDerivedStatus),
        currentVisibility: textOrNull(event.currentVisibility),
        activityId: textOrNull(event.activityId),
        warnings: effort === null ? ["Card has no observed effort estimate; known-effort reporting continues without treating it as zero."] : [],
    };
};

const validateDoneObservation = (value: unknown, label: string): void => {
    if (!isRecord(value) || !["observed", "missing_finish_stats", "missing_done_bucket"].includes(String(value.effortStatus))) throw new Error(`${label} has an invalid effort status.`);
    if (value.effortStatus === "observed" && finiteOrNull(value.effort) === null) throw new Error(`${label} marks effort observed without a finite numeric value.`);
    if (value.effortStatus !== "observed" && value.effort !== null) throw new Error(`${label} must keep missing effort null.`);
};

const validateCoverage = (value: unknown, label: string): void => {
    if (!Array.isArray(value)) throw new Error(`Observation cache ${label} coverage must be an array.`);
    value.forEach((entry, index) => {
        if (!isRecord(entry) || !isIsoDate(entry.from) || !isIsoDate(entry.to) || entry.from > entry.to || !["complete", "incomplete"].includes(String(entry.status))) throw new Error(`Observation cache ${label} coverage interval ${index + 1} is invalid.`);
    });
};

export const validateObservationCache = (value: unknown, expectedAccount?: string): ObservationCache => {
    if (!isRecord(value) || value.schemaVersion !== VELOCITY_CACHE_SCHEMA_VERSION || !isRecord(value.organization)) throw new Error(`Observation cache must use schemaVersion ${VELOCITY_CACHE_SCHEMA_VERSION}.`);
    const account = textOrNull(value.organization.account);
    const baseUrl = textOrNull(value.organization.baseUrl);
    if (!account || !baseUrl || !isRecord(value.runs) || !isRecord(value.deliveredCards) || !isRecord(value.refresh) || !isRecord(value.requestedWindow) || !isRecord(value.coverage)) throw new Error("Observation cache is missing organization, refresh, requestedWindow, coverage, runs, or deliveredCards fields.");
    if (!isIsoDate(value.requestedWindow.from) || !isIsoDate(value.requestedWindow.to) || value.requestedWindow.from > value.requestedWindow.to) throw new Error("Observation cache requestedWindow is invalid.");
    validateCoverage(value.coverage.runs, "Run");
    validateCoverage(value.coverage.deliveredCards, "delivered-card");
    for (const [key, run] of Object.entries(value.runs)) {
        if (!isRecord(run) || run.key !== key || (!textOrNull(run.runId) && finiteOrNull(run.accountSeq) === null) || !isRecord(run.configuration) || !isRecord(run.assignees) || !Array.isArray(run.warnings)) throw new Error(`Observation cache Run '${key}' is invalid.`);
        validateDoneObservation(run.runWide, `Run '${key}'`);
        for (const [userId, done] of Object.entries(run.assignees)) validateDoneObservation(done, `Run '${key}' assignee '${userId}'`);
    }
    for (const [key, card] of Object.entries(value.deliveredCards)) {
        if (!isRecord(card) || card.key !== key || card.cardId !== key || typeof card.deliveredAt !== "string" || Number.isNaN(Date.parse(card.deliveredAt)) || !isRecord(card.assignee) || !isRecord(card.deck) || !Array.isArray(card.warnings)) throw new Error(`Observation cache delivered card '${key}' is invalid.`);
        if (card.effortStatus === "observed" ? finiteOrNull(card.effort) === null : card.effortStatus !== "missing_estimate" || card.effort !== null) throw new Error(`Observation cache delivered card '${key}' has inconsistent effort state.`);
    }
    if (expectedAccount && account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error(`Observation cache belongs to Codecks organization '${account}', not '${expectedAccount}'.`);
    return value as ObservationCache;
};

const replaceCoverage = (existing: CoverageInterval[], from: string, to: string, status: CoverageInterval["status"]): CoverageInterval[] => {
    const next: CoverageInterval[] = [];
    for (const interval of existing) {
        if (interval.to < from || interval.from > to) { next.push(interval); continue; }
        if (interval.from < from) next.push({ ...interval, to: toIsoDate(addDays(toUtcDate(from), -1)) });
        if (interval.to > to) next.push({ ...interval, from: toIsoDate(addDays(toUtcDate(to), 1)) });
    }
    next.push({ from, to, status });
    return next.sort((left, right) => left.from.localeCompare(right.from)).reduce<CoverageInterval[]>((merged, interval) => {
        const previous = merged.at(-1);
        if (previous && previous.status === interval.status && toIsoDate(addDays(toUtcDate(previous.to), 1)) >= interval.from) previous.to = previous.to > interval.to ? previous.to : interval.to;
        else merged.push({ ...interval });
        return merged;
    }, []);
};

export const isCoverageComplete = (intervals: CoverageInterval[], from: string, to: string): boolean => intervals.some((entry) => entry.status === "complete" && entry.from <= from && entry.to >= to);

export const mergeObservationCache = (args: {
    existing?: ObservationCache; account: string; baseUrl: string; now: string; mode: "incremental" | "date_window" | "full"; overlapDays: number;
    from: string; to: string; runs: RunObservation[]; cards: DeliveredCardObservation[]; scannedActivities: number; scanLimit: number; scanLimitReached: boolean; warnings?: string[];
}): ObservationCache => {
    if (args.existing && args.existing.organization.account.toLowerCase() !== args.account.toLowerCase()) throw new Error(`Observation cache belongs to Codecks organization '${args.existing.organization.account}', not '${args.account}'.`);
    const cardComplete = !args.scanLimitReached;
    const runs = args.mode === "full" ? {} as Record<string, RunObservation> : { ...(args.existing?.runs ?? {}) };
    const cards = args.mode === "full" && cardComplete ? {} as Record<string, DeliveredCardObservation> : { ...(args.existing?.deliveredCards ?? {}) };
    const refreshedRunKeys = new Set(args.runs.map((entry) => entry.key));
    const refreshedCardKeys = new Set(args.cards.map((entry) => entry.key));
    let removedRuns = 0;
    let removedCards = 0;
    for (const [key, entry] of Object.entries(runs)) if (entry.completedAt && entry.completedAt >= `${args.from}T00:00:00` && entry.completedAt <= `${args.to}T23:59:59.999Z` && !refreshedRunKeys.has(key)) { delete runs[key]; removedRuns += 1; }
    if (cardComplete) for (const [key, entry] of Object.entries(cards)) if (entry.deliveredAt >= `${args.from}T00:00:00` && entry.deliveredAt <= `${args.to}T23:59:59.999Z` && !refreshedCardKeys.has(key)) { delete cards[key]; removedCards += 1; }
    const replacedRuns = args.runs.filter((entry) => Boolean(runs[entry.key])).length;
    const replacedCards = args.cards.filter((entry) => Boolean(cards[entry.key])).length;
    for (const entry of args.runs) runs[entry.key] = entry;
    for (const entry of args.cards) cards[entry.key] = entry;
    const warnings = [...(args.warnings ?? [])];
    if (!cardComplete) warnings.push("Delivered-card activity scan reached its limit; prior observations were preserved and affected periods remain incomplete.");
    const priorCoverage = args.existing?.coverage ?? { runs: [], deliveredCards: [] };
    return {
        schemaVersion: VELOCITY_CACHE_SCHEMA_VERSION, organization: { account: args.account, baseUrl: args.baseUrl }, createdAt: args.existing?.createdAt ?? args.now, lastRefreshAt: args.now,
        requestedWindow: { from: [args.existing?.requestedWindow.from, args.from].filter((entry): entry is string => Boolean(entry)).sort()[0], to: [args.existing?.requestedWindow.to, args.to].filter((entry): entry is string => Boolean(entry)).sort().at(-1)! },
        coverage: { runs: replaceCoverage(priorCoverage.runs, args.from, args.to, "complete"), deliveredCards: replaceCoverage(priorCoverage.deliveredCards, args.from, args.to, cardComplete ? "complete" : "incomplete") },
        refresh: { mode: args.mode, overlapDays: args.overlapDays, complete: cardComplete, runCount: args.runs.length, cardCount: args.cards.length, replacedRuns, replacedCards, removedRuns, removedCards, scannedActivities: args.scannedActivities, scanLimit: args.scanLimit, scanLimitReached: args.scanLimitReached, warnings },
        runs, deliveredCards: cards,
    };
};

const parseSimpleYamlRoster = (raw: string): unknown => {
    const members: Array<Record<string, string>> = [];
    let current: Record<string, string> | undefined;
    for (const sourceLine of raw.split(/\r?\n/)) {
        const line = sourceLine.replace(/\s+#.*$/, "").trim();
        if (!line || line === "members:") continue;
        const item = line.match(/^-\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
        const property = line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
        if (item) { current = { [item[1]]: item[2].replace(/^['"]|['"]$/g, "") }; members.push(current); continue; }
        if (property && current) { current[property[1]] = property[2].replace(/^['"]|['"]$/g, ""); continue; }
        throw new Error("Simple YAML rosters support only a members list with scalar name, userId, team, fromDate, and toDate fields.");
    }
    return { members };
};

const normalizeExclusion = (value: unknown, index: number, source: string): DateExclusion => {
    if (!isRecord(value)) throw new Error(`${source} exclusion ${index + 1} must be an object.`);
    const fromDate = requireIsoDate(value.fromDate, `${source} exclusion ${index + 1} fromDate`);
    const toDate = requireIsoDate(value.toDate ?? value.fromDate, `${source} exclusion ${index + 1} toDate`);
    ensureRange(fromDate, toDate, `${source} exclusion ${index + 1}`);
    const scope = String(value.scope ?? "organization");
    if (!(["organization", "team", "person"] as string[]).includes(scope)) throw new Error(`${source} exclusion ${index + 1} scope must be organization, team, or person.`);
    return {
        fromDate, toDate,
        reason: textOrNull(value.reason) ?? "explicit exclusion",
        scope: scope as DateExclusion["scope"],
        ...(textOrNull(value.team) ? { team: textOrNull(value.team)! } : {}),
        ...(textOrNull(value.userId) ? { userId: textOrNull(value.userId)! } : {}),
        source,
    };
};

export const parseVelocityRosterText = (raw: string): VelocityRoster => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { parsed = parseSimpleYamlRoster(raw); }
    const root = Array.isArray(parsed) ? { members: parsed } : parsed;
    if (!isRecord(root) || !Array.isArray(root.members)) throw new Error("Velocity roster must be an array or an object with a members array.");
    const exclusions = Array.isArray(root.exclusions) ? root.exclusions.map((entry, index) => normalizeExclusion(entry, index, "roster")) : [];
    const members = root.members.map((value, index): RosterMember => {
        if (!isRecord(value) || !textOrNull(value.name) || !textOrNull(value.userId)) throw new Error(`Velocity roster member ${index + 1} requires non-empty name and userId values.`);
        const fromDate = value.fromDate === undefined ? undefined : requireIsoDate(value.fromDate, `member ${index + 1} fromDate`);
        const toDate = value.toDate === undefined ? undefined : requireIsoDate(value.toDate, `member ${index + 1} toDate`);
        if (fromDate && toDate) ensureRange(fromDate, toDate, `member ${index + 1}`);
        return {
            name: String(value.name).trim(), userId: String(value.userId).trim(),
            ...(textOrNull(value.team) ? { team: textOrNull(value.team)! } : {}),
            ...(fromDate ? { fromDate } : {}), ...(toDate ? { toDate } : {}),
            exclusions: Array.isArray(value.exclusions) ? value.exclusions.map((entry, exclusionIndex) => normalizeExclusion({ ...(isRecord(entry) ? entry : {}), scope: "person", userId: String(value.userId) }, exclusionIndex, `member ${index + 1}`)) : [],
        };
    });
    return { members, exclusions };
};

const resolveConfigurations = (cache: ObservationCache, selector: unknown): { selected: ConfigurationIdentity[]; runKeys: Set<string> | null } => {
    const configurations = new Map<string, ConfigurationIdentity>();
    for (const run of Object.values(cache.runs)) {
        const key = run.configuration.id ?? `name:${run.configuration.name ?? "unknown"}`;
        configurations.set(key, run.configuration);
    }
    const all = [...configurations.values()];
    const requested = textOrNull(selector);
    if (!requested) return { selected: all, runKeys: null };
    const byId = all.filter((entry) => entry.id === requested);
    const byName = all.filter((entry) => entry.name?.toLowerCase() === requested.toLowerCase());
    const matches = byId.length > 0 ? byId : byName;
    if (matches.length === 0) throw new Error(`Run configuration '${requested}' was not found. Candidates: ${all.map((entry) => `${entry.name ?? "(unnamed)"} [${entry.id ?? "no id"}]`).join(", ") || "none"}.`);
    if (matches.length > 1) throw new Error(`Run configuration '${requested}' is ambiguous. Candidates: ${matches.map((entry) => `${entry.name ?? "(unnamed)"} [${entry.id ?? "no id"}]`).join(", ")}. Use the stable configuration id.`);
    const selected = matches[0];
    return { selected: [selected], runKeys: new Set(Object.values(cache.runs).filter((run) => (selected.id ? run.configuration.id === selected.id : run.configuration.name === selected.name)).map((run) => run.key)) };
};

const resolveExcludedDecks = (cache: ObservationCache, selectors: unknown): Array<{ id: string | null; title: string | null; accountSeq: number | null }> => {
    if (selectors === undefined) return [];
    if (!Array.isArray(selectors) || selectors.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error("excludeDecks must be an array of non-empty stable deck ids or exact titles.");
    const decks = new Map<string, DeliveredCardObservation["deck"]>();
    for (const card of Object.values(cache.deliveredCards)) if (card.deck.id || card.deck.title || card.deck.accountSeq !== null) decks.set(card.deck.id ?? `seq:${card.deck.accountSeq ?? "?"}:${card.deck.title ?? ""}`, card.deck);
    return selectors.map((raw) => {
        const selector = raw.trim();
        const byId = [...decks.values()].filter((deck) => deck.id === selector || String(deck.accountSeq ?? "") === selector || `seq:${deck.accountSeq ?? ""}` === selector.toLowerCase());
        const byTitle = [...decks.values()].filter((deck) => deck.title?.toLowerCase() === selector.toLowerCase());
        const matches = byId.length > 0 ? byId : byTitle;
        if (matches.length === 0) throw new Error(`Excluded deck '${selector}' was not found. Candidates: ${[...decks.values()].map((deck) => `${deck.title ?? "(untitled)"} [${deck.id ?? `seq:${deck.accountSeq ?? "?"}`}]`).join(", ") || "none"}.`);
        if (matches.length > 1) throw new Error(`Excluded deck '${selector}' is ambiguous. Use a stable deck id. Candidates: ${matches.map((deck) => `${deck.title ?? "(untitled)"} [${deck.id ?? `seq:${deck.accountSeq ?? "?"}`}]`).join(", ")}.`);
        return matches[0];
    });
};

const manifest = (name: string, args: Record<string, unknown>, inputCount: number, outputCount: number, excludedReferences: TransformationRecord["excludedReferences"] = [], excludedEffort: number | null = null, warnings: string[] = []): TransformationRecord => ({
    name, contractVersion: 1, arguments: args, inputCount, outputCount, excludedReferences, excludedEffort, warnings,
});

const weekStarts = (from: string, to: string): string[] => {
    const starts: string[] = [];
    for (let day = mondayOnOrBefore(toUtcDate(from)); day <= toUtcDate(to); day = addDays(day, 7)) starts.push(toIsoDate(day));
    return starts;
};

const appliesExclusion = (exclusion: DateExclusion, date: string, subject: { userId: string | null; team: string | null }): boolean => {
    if (date < exclusion.fromDate || date > exclusion.toDate) return false;
    if (exclusion.scope === "organization") return true;
    if (exclusion.scope === "team") return Boolean(subject.team && exclusion.team?.toLowerCase() === subject.team.toLowerCase());
    return Boolean(subject.userId && exclusion.userId === subject.userId);
};

const subjectDefinitions = (options: ReportOptions): Array<{ name: string; userId: string | null; team: string | null; fromDate?: string; toDate?: string; exclusions: DateExclusion[] }> => {
    const roster = options.roster ?? { members: [], exclusions: [] };
    const team = textOrNull(options.team);
    const members = team ? roster.members.filter((member) => member.team?.toLowerCase() === team.toLowerCase()) : roster.members;
    if (team && members.length === 0) throw new Error(`Roster team '${team}' has no matching members; refusing to broaden the report to organization scope.`);
    if (members.length > 0) return members.map((member) => ({ name: member.name, userId: member.userId, team: member.team ?? null, fromDate: member.fromDate, toDate: member.toDate, exclusions: [...roster.exclusions, ...member.exclusions] }));
    return [{ name: textOrNull(options.user) ?? textOrNull(options.userId) ?? "Organization", userId: textOrNull(options.userId), team, exclusions: roster.exclusions }];
};

const periodComposition = (periods: ReportPeriod[]): VelocitySubjectReport["composition"] => ({
    complete: periods.filter((entry) => entry.completeness === "complete").length,
    partial: periods.filter((entry) => entry.completeness === "partial_boundary").length,
    gapFilled: periods.filter((entry) => entry.valueKind === "filled").length,
    excludedFromStatistics: periods.filter((entry) => !entry.includedInStatistics).length,
    missingData: periods.filter((entry) => entry.completeness === "missing_data").length,
});

const toSummaryPeriods = (periods: ReportPeriod[]): VelocityPeriod[] => periods
    .filter((entry) => entry.includedInStatistics && entry.knownEffort !== null)
    .map((entry) => ({ startDate: entry.startDate, endDate: entry.endDate, label: entry.label, effort: entry.knownEffort! }));

const aggregateBiweekly = (periods: ReportPeriod[], anchor: string): ReportPeriod[] => {
    const grouped = buildBiweeklyPeriods(periods.filter((entry) => entry.knownEffort !== null).map((entry) => ({ startDate: entry.startDate, endDate: entry.endDate, label: entry.label, effort: entry.knownEffort! })), anchor);
    return grouped.map((entry) => {
        const source = periods.filter((week) => week.startDate >= entry.startDate && week.startDate <= entry.endDate);
        const unavailable = source.some((week) => week.knownEffort === null);
        const partial = source.length !== 2 || source.some((week) => week.completeness === "partial_boundary");
        return {
            startDate: entry.startDate, endDate: entry.endDate, label: entry.label, alignment: "fixed_biweekly", anchor,
            measure: source[0]?.measure ?? "calendar_delivered", knownEffort: unavailable ? null : entry.effort,
            presentationEffort: unavailable ? null : roundForPresentation(entry.effort),
            deliveredCardCount: source.reduce((total, week) => total + week.deliveredCardCount, 0),
            missingEffortCount: source.reduce((total, week) => total + week.missingEffortCount, 0),
            completeness: unavailable ? "missing_data" : partial ? "partial_boundary" : source.every((week) => week.completeness === "gap") ? "gap" : "complete",
            valueKind: unavailable ? "unavailable" : "modeled",
            includedInStatistics: !unavailable && !partial && source.every((week) => week.includedInStatistics),
            contributingCards: [...new Set(source.flatMap((week) => week.contributingCards))],
            contributingRuns: [...new Set(source.flatMap((week) => week.contributingRuns))],
            configurationIds: [...new Set(source.flatMap((week) => week.configurationIds))],
        };
    });
};

export const buildVelocityReport = (cache: ObservationCache, options: ReportOptions = {}): VelocityReport => {
    const preset = textOrNull(options.preset) ?? "standard_velocity";
    if (preset !== "standard_velocity" && preset !== "none") throw new Error("preset must be standard_velocity or none.");
    const measure = textOrNull(options.measure) ?? "calendar_delivered";
    if (measure !== "calendar_delivered" && measure !== "run_attributed") throw new Error("measure must be calendar_delivered or run_attributed.");
    const from = options.fromDate === undefined ? cache.requestedWindow.from : requireIsoDate(options.fromDate, "fromDate");
    const to = options.toDate === undefined ? cache.requestedWindow.to : requireIsoDate(options.toDate, "toDate");
    ensureRange(from, to, "Report date window");
    const gapPolicy = textOrNull(options.gapPolicy) ?? (preset === "standard_velocity" ? "include_zero" : "omit");
    if (!["include_zero", "show_exclude_from_statistics", "omit"].includes(gapPolicy)) throw new Error("gapPolicy must be include_zero, show_exclude_from_statistics, or omit.");
    const partialPolicy = textOrNull(options.partialPeriodPolicy) ?? (preset === "standard_velocity" ? "show_exclude" : "include");
    if (!["show_exclude", "include"].includes(partialPolicy)) throw new Error("partialPeriodPolicy must be show_exclude or include.");
    const anchor = options.biweeklyAnchor === undefined ? "1970-01-05" : requireIsoDate(options.biweeklyAnchor, "biweeklyAnchor");
    if (toUtcDate(anchor).getUTCDay() !== 1) throw new Error("biweeklyAnchor must be a Monday.");
    const config = resolveConfigurations(cache, options.sprintConfig);
    const excludedDecks = resolveExcludedDecks(cache, options.excludeDecks);
    if (measure === "run_attributed" && excludedDecks.length > 0) throw new Error("excludeDecks is available only for calendar_delivered reports; Run finishStats cannot safely subtract deck-level card effort.");
    const transformations: TransformationRecord[] = [];
    const warnings = [...cache.refresh.warnings];
    const baseCount = measure === "calendar_delivered" ? Object.keys(cache.deliveredCards).length : Object.keys(cache.runs).length;
    transformations.push(manifest("select_effort_measure", { measure }, Object.keys(cache.runs).length + Object.keys(cache.deliveredCards).length, baseCount));
    transformations.push(manifest("select_date_window", { fromDate: from, toDate: to }, baseCount, baseCount));
    transformations.push(manifest("select_run_configuration", { selector: textOrNull(options.sprintConfig), included: config.selected }, Object.keys(cache.runs).length, config.runKeys?.size ?? Object.keys(cache.runs).length));

    const reportExclusions = Array.isArray(options.dateExclusions) ? options.dateExclusions.map((entry, index) => normalizeExclusion(entry, index, "report")) : [];
    const subjects = subjectDefinitions(options).map((subject): VelocitySubjectReport => {
        const effectiveFrom = subject.fromDate && subject.fromDate > from ? subject.fromDate : from;
        const effectiveTo = subject.toDate && subject.toDate < to ? subject.toDate : to;
        const allDateExclusions = [...subject.exclusions, ...reportExclusions];
        const periods: ReportPeriod[] = [];
        if (measure === "calendar_delivered") {
            const subjectCards = Object.values(cache.deliveredCards).filter((card) => {
                const date = card.deliveredAt.slice(0, 10);
                return date >= effectiveFrom && date <= effectiveTo && (!subject.userId || card.assignee.id === subject.userId);
            });
            const selectedRunIds = config.runKeys ? new Set([...config.runKeys].map((key) => cache.runs[key]?.runId).filter((entry): entry is string => Boolean(entry))) : null;
            const configurationExcluded = selectedRunIds ? subjectCards.filter((card) => !card.runId || !selectedRunIds.has(card.runId)) : [];
            const configuredCards = selectedRunIds ? subjectCards.filter((card) => card.runId && selectedRunIds.has(card.runId)) : subjectCards;
            const deckExcluded = configuredCards.filter((card) => excludedDecks.some((deck) => deck.id ? card.deck.id === deck.id : deck.accountSeq !== null ? card.deck.accountSeq === deck.accountSeq : card.deck.title === deck.title));
            const deckIncluded = configuredCards.filter((card) => !deckExcluded.includes(card));
            const excluded = deckIncluded.filter((card) => allDateExclusions.some((entry) => appliesExclusion(entry, card.deliveredAt.slice(0, 10), subject)));
            const included = deckIncluded.filter((card) => !excluded.includes(card));
            transformations.push(manifest("select_subject", { subject: subject.name, userId: subject.userId, team: subject.team, membershipFrom: subject.fromDate ?? null, membershipTo: subject.toDate ?? null }, Object.keys(cache.deliveredCards).length, subjectCards.length));
            transformations.push(manifest("select_calendar_configuration", { subject: subject.name, selector: textOrNull(options.sprintConfig), unassignedPolicy: selectedRunIds ? "exclude_when_filtering" : "include" }, subjectCards.length, configuredCards.length, configurationExcluded.map((card) => ({ reference: card.shortCode ?? card.cardId, reason: card.runId ? "card belongs to another or unknown Run configuration" : "unassigned card excluded by configuration filter" })), configurationExcluded.reduce((sum, card) => sum + (card.effort ?? 0), 0)));
            transformations.push(manifest("exclude_decks", { subject: subject.name, decks: excludedDecks }, configuredCards.length, deckIncluded.length, deckExcluded.map((card) => ({ reference: card.shortCode ?? card.cardId, reason: `deck '${card.deck.title ?? card.deck.id ?? "unknown"}' excluded` })), deckExcluded.reduce((sum, card) => sum + (card.effort ?? 0), 0)));
            transformations.push(manifest("apply_explicit_date_exclusions", { subject: subject.name, exclusions: allDateExclusions }, deckIncluded.length, included.length, excluded.map((card) => ({ reference: card.shortCode ?? card.cardId, reason: "explicit date exclusion" })), excluded.reduce((sum, card) => sum + (card.effort ?? 0), 0)));
            for (const startDate of weekStarts(effectiveFrom, effectiveTo)) {
                const endDate = toIsoDate(addDays(toUtcDate(startDate), 6));
                const cards = included.filter((card) => card.deliveredAt.slice(0, 10) >= startDate && card.deliveredAt.slice(0, 10) <= endDate);
                const partial = startDate < effectiveFrom || endDate > effectiveTo;
                const completeRetrieval = isCoverageComplete(cache.coverage.deliveredCards, startDate, endDate);
                const explicitlyExcluded = allDateExclusions.some((entry) => entry.fromDate <= startDate && entry.toDate >= endDate && appliesExclusion(entry, startDate, subject));
                if (explicitlyExcluded) continue;
                if (cards.length === 0 && gapPolicy === "omit") continue;
                const missingData = !completeRetrieval;
                const missingEffortCount = cards.filter((card) => card.effortStatus === "missing_estimate").length;
                const knownEffort = missingData ? null : cards.reduce((sum, card) => sum + (card.effort ?? 0), 0);
                periods.push({
                    startDate, endDate, label: `${startDate} to ${endDate}`, alignment: "monday_week", anchor: "Monday", measure,
                    knownEffort, presentationEffort: knownEffort === null ? null : roundForPresentation(knownEffort),
                    deliveredCardCount: cards.length, missingEffortCount,
                    completeness: missingData ? "missing_data" : partial ? "partial_boundary" : cards.length === 0 ? "gap" : "complete",
                    valueKind: missingData ? "unavailable" : cards.length === 0 ? "filled" : "observed",
                    includedInStatistics: !missingData && (partialPolicy === "include" || !partial) && !(cards.length === 0 && gapPolicy === "show_exclude_from_statistics"),
                    contributingCards: cards.map((card) => card.shortCode ?? card.cardId), contributingRuns: [...new Set(cards.map((card) => card.runId).filter((entry): entry is string => Boolean(entry)))], configurationIds: [...new Set(cards.map((card) => card.runId ? Object.values(cache.runs).find((run) => run.runId === card.runId)?.configuration.id : null).filter((entry): entry is string => Boolean(entry)))],
                });
            }
            transformations.push(manifest("bucket_calendar_weeks", { subject: subject.name, gapPolicy, partialPeriodPolicy: partialPolicy }, included.length, periods.length));
        } else {
            const replacement = Array.isArray(options.excludeLabels) ? options.excludeLabels.filter((entry): entry is string => typeof entry === "string") : DEFAULT_RUN_EXCLUSION_LABELS;
            const additional = Array.isArray(options.additionalExcludeLabels) ? options.additionalExcludeLabels.filter((entry): entry is string => typeof entry === "string") : [];
            const labels = [...replacement, ...additional].map((entry) => entry.trim().toLowerCase()).filter(Boolean);
            const configurationRuns = Object.values(cache.runs).filter((run) => !config.runKeys || config.runKeys.has(run.key));
            const unusableRuns = configurationRuns.filter((run) => !run.startDate || !run.endDate || !isIsoDate(run.startDate) || !isIsoDate(run.endDate) || run.startDate > run.endDate);
            const selectedRuns = configurationRuns.filter((run) => !unusableRuns.includes(run) && run.startDate! <= effectiveTo && run.endDate! >= effectiveFrom);
            if (unusableRuns.length > 0) warnings.push(...unusableRuns.map((run) => `Run '${run.key}' has missing, malformed, or reversed dates and remains unavailable for normalization.`));
            const labelExcluded = selectedRuns.filter((run) => labels.some((label) => run.label.toLowerCase().includes(label)));
            const includedRuns = selectedRuns.filter((run) => !labelExcluded.includes(run));
            transformations.push(manifest("exclude_run_labels", { subject: subject.name, labels }, selectedRuns.length, includedRuns.length, labelExcluded.map((run) => ({ reference: run.key, reason: "Run label exclusion" })), labelExcluded.reduce((sum, run) => sum + (subject.userId ? run.assignees[subject.userId]?.effort ?? 0 : run.runWide.effort ?? 0), 0)));
            const modeledRuns: VelocityRun[] = [];
            const unavailableRuns: RunObservation[] = [];
            for (const run of includedRuns) {
                const done = subject.userId ? run.assignees[subject.userId] : run.runWide;
                if (!done || done.effort === null) { unavailableRuns.push(run); continue; }
                modeledRuns.push({ accountSeq: run.accountSeq, label: run.label, startDate: run.startDate, endDate: run.endDate, effort: done.effort });
            }
            const modeled = new Map(buildWeeklyPeriods(modeledRuns).map((entry) => [entry.startDate, entry]));
            for (const startDate of weekStarts(effectiveFrom, effectiveTo)) {
                const endDate = toIsoDate(addDays(toUtcDate(startDate), 6));
                const value = modeled.get(startDate);
                const contributing = includedRuns.filter((run) => Boolean(run.startDate && run.endDate && run.startDate <= endDate && run.endDate >= startDate));
                const unavailable = !isCoverageComplete(cache.coverage.runs, startDate, endDate) || unavailableRuns.some((run) => Boolean(run.startDate && run.endDate && run.startDate <= endDate && run.endDate >= startDate));
                const partial = startDate < effectiveFrom || endDate > effectiveTo;
                if (!value && !unavailable && gapPolicy === "omit") continue;
                const knownEffort = unavailable ? null : value?.effort ?? 0;
                periods.push({
                    startDate, endDate, label: `${startDate} to ${endDate}`, alignment: "monday_week", anchor: "Monday", measure,
                    knownEffort, presentationEffort: knownEffort === null ? null : roundForPresentation(knownEffort), deliveredCardCount: 0, missingEffortCount: unavailable ? 1 : 0,
                    completeness: unavailable ? "missing_data" : partial ? "partial_boundary" : value ? "complete" : "gap",
                    valueKind: unavailable ? "unavailable" : value ? "modeled" : "filled",
                    includedInStatistics: !unavailable && (partialPolicy === "include" || !partial) && !(knownEffort === 0 && !value && gapPolicy === "show_exclude_from_statistics"),
                    contributingCards: [], contributingRuns: contributing.map((run) => run.key), configurationIds: [...new Set(contributing.map((run) => run.configuration.id).filter((entry): entry is string => Boolean(entry)))],
                });
            }
            transformations.push(manifest("normalize_run_effort_to_weeks", { subject: subject.name, allocation: "equal_calendar_days", gapPolicy, partialPeriodPolicy: partialPolicy }, includedRuns.length + unusableRuns.length, periods.length, [...unusableRuns.map((run) => ({ reference: run.key, reason: "missing, malformed, or reversed Run dates" })), ...unavailableRuns.map((run) => ({ reference: run.key, reason: run.runWide.effortStatus }))]));
        }
        const biweekly = options.biweekly === false ? [] : aggregateBiweekly(periods, anchor);
        if (options.biweekly !== false) transformations.push(manifest("aggregate_fixed_biweekly", { subject: subject.name, anchor }, periods.length, biweekly.length));
        return { name: subject.name, userId: subject.userId, team: subject.team, periods, biweekly, summary: summarizeVelocityPeriods(toSummaryPeriods(periods)), composition: periodComposition(periods) };
    });
    if (!cache.refresh.complete) warnings.push("Cache retrieval is incomplete; affected periods remain unavailable rather than being treated as zero.");
    if (subjects.some((subject) => subject.periods.some((period) => period.missingEffortCount > 0))) warnings.push("Some observations have missing effort; totals include known effort only and disclose missing-effort counts.");
    return {
        schemaVersion: VELOCITY_REPORT_SCHEMA_VERSION,
        cacheSchemaVersion: cache.schemaVersion,
        organization: cache.organization,
        preset,
        measure,
        dateWindow: { from, to },
        configurationSelection: config.selected,
        transformations,
        subjects,
        warnings: [...new Set(warnings)],
        outputs: {},
    };
};

const md = (value: unknown): string => String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const display = (value: number | null): string => value === null ? "N/A" : String(value);

export const buildVelocityMarkdown = (report: VelocityReport): string => {
    const lines = [
        "# Codecks Velocity Report", "",
        `- Observation cache schema: ${report.cacheSchemaVersion}`,
        `- Report schema: ${report.schemaVersion}`,
        `- Organization: ${md(report.organization.account)}`,
        `- Measure: ${report.measure}`,
        `- Preset: ${md(report.preset)} (expanded below)` ,
        `- Date range: ${report.dateWindow.from} to ${report.dateWindow.to}`,
        `- Configurations: ${report.configurationSelection.map((entry) => `${md(entry.name ?? "unnamed")} [${md(entry.id ?? "no id")}]`).join(", ") || "none observed"}`,
        "", "## Transformations", "",
        "| Order | Transformation | Arguments | Input | Output | Excluded | Warnings |",
        "|---:|---|---|---:|---:|---:|---|",
        ...report.transformations.map((entry, index) => `| ${index + 1} | ${md(entry.name)} | ${md(JSON.stringify(entry.arguments))} | ${entry.inputCount} | ${entry.outputCount} | ${entry.excludedReferences.length} | ${md(entry.warnings.join("; "))} |`),
        "",
    ];
    for (const subject of report.subjects) {
        lines.push(
            `## ${md(subject.name)}`, "",
            `- User ID: ${md(subject.userId ?? "organization-wide")}`,
            `- Team: ${md(subject.team ?? "not selected")}`,
            `- Sample weeks: ${subject.summary.sampleWeeks}`,
            `- Composition: complete=${subject.composition.complete}, partial=${subject.composition.partial}, gap-filled=${subject.composition.gapFilled}, missing-data=${subject.composition.missingData}, excluded-from-statistics=${subject.composition.excludedFromStatistics}`,
            "", "| Period | Effort | Kind | Completeness | Cards | Missing effort | Statistics | Provenance |",
            "|---|---:|---|---|---:|---:|---|---|",
            ...subject.periods.map((period) => `| ${period.startDate} to ${period.endDate} | ${display(period.presentationEffort)} | ${period.valueKind} | ${period.completeness} | ${period.deliveredCardCount} | ${period.missingEffortCount} | ${period.includedInStatistics ? "included" : "excluded"} | ${md([...period.contributingCards, ...period.contributingRuns].join(", "))} |`),
            "", "### Statistics", "",
            "| Sample weeks | Total effort | Mean | P25 | P50 | P75 | Sample standard deviation | Sample variance |",
            "|---:|---:|---:|---:|---:|---:|---:|---:|",
            `| ${subject.summary.sampleWeeks} | ${subject.summary.totalEffort} | ${display(subject.summary.mean)} | ${display(subject.summary.p25)} | ${display(subject.summary.p50)} | ${display(subject.summary.p75)} | ${display(subject.summary.sampleStandardDeviation)} | ${display(subject.summary.sampleVariance)} |`,
            "",
        );
    }
    if (report.warnings.length > 0) lines.push("## Warnings", "", ...report.warnings.map((warning) => `- ${md(warning)}`), "");
    return `${lines.join("\n")}\n`;
};

export const buildVelocityCsv = (report: VelocityReport, cache: ObservationCache): string => {
    const rows: unknown[][] = [["record_type", "subject", "user_id", "measure", "start", "end", "reference", "configuration_id", "configuration_name", "effort", "effort_status", "completeness", "included_in_statistics", "reason_or_metadata"]];
    for (const run of Object.values(cache.runs)) rows.push(["raw_run", "", "", "run_attributed", run.startDate, run.endDate, run.key, run.configuration.id, run.configuration.name, run.runWide.effort, run.runWide.effortStatus, "", "", run.warnings.join("; ")]);
    for (const card of Object.values(cache.deliveredCards)) rows.push(["raw_delivered_card", "", card.assignee.id, "calendar_delivered", card.deliveredAt, card.deliveredAt, card.shortCode ?? card.cardId, card.runId, "", card.effort, card.effortStatus, "", "", card.title]);
    report.transformations.forEach((entry, index) => rows.push(["transformation", "", "", report.measure, "", "", `${index + 1}:${entry.name}`, "", "", entry.excludedEffort, "", "", "", JSON.stringify(entry.arguments)]));
    for (const subject of report.subjects) {
        for (const period of subject.periods) rows.push(["weekly_period", subject.name, subject.userId, report.measure, period.startDate, period.endDate, period.label, period.configurationIds.join(";"), "", period.knownEffort, period.valueKind, period.completeness, period.includedInStatistics, `cards=${period.deliveredCardCount};missing_effort=${period.missingEffortCount}`]);
        for (const period of subject.biweekly) rows.push(["biweekly_period", subject.name, subject.userId, report.measure, period.startDate, period.endDate, period.label, period.configurationIds.join(";"), "", period.knownEffort, period.valueKind, period.completeness, period.includedInStatistics, ""]);
        rows.push(["summary", subject.name, subject.userId, report.measure, report.dateWindow.from, report.dateWindow.to, "statistics", "", "", subject.summary.totalEffort, subject.summary.statisticsAvailable ? "available" : "unavailable", "", "", JSON.stringify(subject.summary)]);
    }
    return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
};
