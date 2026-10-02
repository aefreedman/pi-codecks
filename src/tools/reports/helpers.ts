import { fetchLoggedInUser } from "../../runtime/identity";
import { runQuery } from "../../runtime/transport";
import { getEntityMap } from "../../shared/entity-maps";
import { isRecord, relationQuery, unwrapData } from "../../shared/query";
import { fetchAccountRuns, normalizeRunSummary, runSummaryFields } from "../../shared/runs";
import { UUID_PATTERN } from "../../shared/session-id";
import type { CodecksEntity } from "../../shared/types";
import { fetchUsersByIds, normalizeUserId } from "../../shared/users";

type RunDoneStats = {
    count: number;
    effort: number;
    noEffort: number;
};

type RunDeliveredEffortEntry = {
    runId: string | null;
    sprintId: string | null;
    accountSeq: number | null;
    label: string;
    customLabel: unknown;
    startDate: unknown;
    endDate: unknown;
    dateRange: string | null;
    completedAt: unknown;
    sprintConfig: unknown;
    delivered: RunDoneStats;
    runDelivered: RunDoneStats | null;
    current?: RunDoneStats | null;
    source: string;
    warnings: string[];
};

const toTimestamp = (value: unknown): number =>
{
    const timestamp = new Date(String(value ?? "")).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
};

const toNumberOrZero = (value: unknown): number =>
{
    const number = typeof value === "number" ? value : Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
};

const normalizeDoneStats = (value: unknown): RunDoneStats | null =>
{
    if (!isRecord(value))
    {
        return null;
    }

    return {
        count: toNumberOrZero(value.count),
        effort: toNumberOrZero(value.effort),
        noEffort: toNumberOrZero(value.noEffort),
    };
};

const normalizeProgressDoneStats = (value: unknown): RunDoneStats | null =>
{
    if (!Array.isArray(value))
    {
        return normalizeDoneStats(value);
    }

    return {
        count: toNumberOrZero(value[0]),
        effort: toNumberOrZero(value[1]),
        noEffort: toNumberOrZero(value[2]),
    };
};

const zeroDoneStats = (): RunDoneStats => ({ count: 0, effort: 0, noEffort: 0 });

const addDoneStats = (left: RunDoneStats, right: RunDoneStats): RunDoneStats => ({
    count: left.count + right.count,
    effort: left.effort + right.effort,
    noEffort: left.noEffort + right.noEffort,
});

const findRecordById = (records: unknown, id: string): Record<string, unknown> | undefined =>
{
    if (!isRecord(records))
    {
        return undefined;
    }

    const direct = records[id];
    if (isRecord(direct))
    {
        return direct;
    }

    const normalized = normalizeUserId(id);
    const key = Object.keys(records).find((entry) => normalizeUserId(entry) === normalized);
    const value = key ? records[key] : undefined;
    return isRecord(value) ? value : undefined;
};

const sumDoneStatsByGroup = (records: unknown): RunDoneStats | null =>
{
    if (!isRecord(records))
    {
        return null;
    }

    let total = zeroDoneStats();
    let found = false;
    for (const value of Object.values(records))
    {
        if (!isRecord(value))
        {
            continue;
        }

        const done = normalizeDoneStats(value.done);
        if (!done)
        {
            continue;
        }

        total = addDoneStats(total, done);
        found = true;
    }

    return found ? total : null;
};

const extractRunDoneStats = (statsContainer: unknown, userId?: string): RunDoneStats | null =>
{
    if (!isRecord(statsContainer))
    {
        return null;
    }

    if (userId)
    {
        const assignee = findRecordById(statsContainer.assignee, userId);
        return normalizeDoneStats(assignee?.done) ?? zeroDoneStats();
    }

    if (isRecord(statsContainer.progress))
    {
        const progressDone = normalizeProgressDoneStats(statsContainer.progress.done);
        if (progressDone)
        {
            return progressDone;
        }
    }

    return sumDoneStatsByGroup(statsContainer.priority);
};

const getSprintConfigName = (run: CodecksEntity): string =>
{
    const sprintConfig = typeof run.sprintConfig === "object" && run.sprintConfig ? run.sprintConfig as CodecksEntity : undefined;
    return String(sprintConfig?.name ?? "").trim();
};

const matchesSprintConfig = (run: CodecksEntity, filter: unknown): boolean =>
{
    const trimmed = String(filter ?? "").trim().toLowerCase();
    if (!trimmed)
    {
        return true;
    }

    const sprintConfig = typeof run.sprintConfig === "object" && run.sprintConfig ? run.sprintConfig as CodecksEntity : undefined;
    const candidates = [
        sprintConfig?.name,
        sprintConfig?.id,
        sprintConfig?.color,
    ].map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean);

    return candidates.some((candidate) => candidate.includes(trimmed));
};

const resolveRunStatsUser = async (user: unknown, userId: unknown): Promise<{
    userId?: string;
    userLabel?: string;
    warnings: string[];
} | { error: string; candidates?: Array<Record<string, unknown>> }> =>
{
    const explicitUserId = String(userId ?? "").trim();
    const requestedUser = String(user ?? "").trim();
    if (explicitUserId)
    {
        let userLabel = requestedUser || explicitUserId;
        try
        {
            const users = await fetchUsersByIds([explicitUserId]);
            const resolved = users[normalizeUserId(explicitUserId)];
            if (resolved)
            {
                userLabel = String(resolved.fullName ?? resolved.name ?? explicitUserId);
            }
        }
        catch
        {
            // User labels are cosmetic for this tool; keep the explicit id if lookup fails.
        }

        return { userId: explicitUserId, userLabel, warnings: [] };
    }

    if (!requestedUser)
    {
        return { warnings: [] };
    }

    if (/^(me|logged-?in-?user)$/i.test(requestedUser))
    {
        const loggedIn = await fetchLoggedInUser();
        return {
            userId: String(loggedIn.id),
            userLabel: String(loggedIn.fullName ?? loggedIn.name ?? loggedIn.id),
            warnings: [],
        };
    }

    if (UUID_PATTERN.test(requestedUser))
    {
        return { userId: requestedUser, userLabel: requestedUser, warnings: [] };
    }

    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        [relationQuery("cards", { $limit: 2000, $order: "-lastUpdatedAt" })]: [
                            { assignee: ["id", "name", "fullName"] },
                            { creator: ["id", "name", "fullName"] },
                        ],
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const userMap = getEntityMap(data, "user");
    const normalizedQuery = requestedUser.toLowerCase();
    const seen = new Set<string>();
    const matches = Object.values(userMap)
        .filter((candidate) =>
        {
            const name = String(candidate.name ?? "").toLowerCase();
            const fullName = String(candidate.fullName ?? "").toLowerCase();
            return name.includes(normalizedQuery) || fullName.includes(normalizedQuery);
        })
        .filter((candidate) =>
        {
            const id = candidate.id !== undefined ? String(candidate.id) : "";
            if (!id || seen.has(id))
            {
                return false;
            }
            seen.add(id);
            return true;
        });

    const exactMatches = matches.filter((candidate) =>
    {
        const name = String(candidate.name ?? "").toLowerCase();
        const fullName = String(candidate.fullName ?? "").toLowerCase();
        return name === normalizedQuery || fullName === normalizedQuery;
    });
    const candidates = exactMatches.length > 0 ? exactMatches : matches;

    if (candidates.length === 1)
    {
        const resolved = candidates[0];
        return {
            userId: String(resolved.id),
            userLabel: String(resolved.fullName ?? resolved.name ?? resolved.id),
            warnings: ["User name was resolved from recent card assignees/creators; pass userId for an exact lookup."],
        };
    }

    if (candidates.length > 1)
    {
        return {
            error: `Multiple users matched '${requestedUser}'. Pass userId to disambiguate.`,
            candidates: candidates.map((candidate) => ({
                id: candidate.id ?? null,
                name: candidate.name ?? null,
                fullName: candidate.fullName ?? null,
            })),
        };
    }

    return { error: `No user matched '${requestedUser}'. Use codecks_user_lookup to find a valid userId.` };
};

const getCompletedRunLimit = (value: unknown, fallback = 4): number =>
{
    const parsed = Math.floor(Number(value ?? fallback));
    if (!Number.isFinite(parsed))
    {
        return fallback;
    }

    return Math.max(1, Math.min(500, parsed));
};

const buildRunDeliveredEffortEntry = (
    run: CodecksEntity,
    userId: string | undefined,
    includeCurrentStats: boolean,
): RunDeliveredEffortEntry =>
{
    const summary = normalizeRunSummary(run);
    const stats = isRecord(run.stats) ? run.stats : undefined;
    const finishStats = isRecord(stats?.finishStats) ? stats.finishStats : undefined;
    const warnings: string[] = [];
    const delivered = finishStats ? extractRunDoneStats(finishStats, userId) : null;
    const runDelivered = finishStats ? extractRunDoneStats(finishStats) : null;

    if (!finishStats)
    {
        warnings.push("Run is missing stats.finishStats; delivered effort defaults to zero because the completed-run snapshot is unavailable.");
    }

    if (!delivered)
    {
        warnings.push("Run finishStats did not expose a done effort bucket for this scope; delivered effort defaults to zero.");
    }

    const current = includeCurrentStats ? extractRunDoneStats(stats, userId) : undefined;

    return {
        runId: summary.runId as string | null,
        sprintId: summary.sprintId as string | null,
        accountSeq: summary.accountSeq as number | null,
        label: String(summary.label ?? "Run"),
        customLabel: summary.customLabel,
        startDate: summary.startDate,
        endDate: summary.endDate,
        dateRange: summary.dateRange as string | null,
        completedAt: summary.completedAt,
        sprintConfig: summary.sprintConfig,
        delivered: delivered ?? zeroDoneStats(),
        runDelivered,
        ...(includeCurrentStats ? { current } : {}),
        source: userId ? "stats.finishStats.assignee[userId].done" : "stats.finishStats.progress.done",
        warnings,
    };
};

export const fetchDeliveredEffortEntries = async (args: {
    sprintConfig?: unknown;
    user?: unknown;
    userId?: unknown;
    completedRuns?: unknown;
    limit?: unknown;
    includeCurrentStats?: unknown;
}): Promise<{
    entries: RunDeliveredEffortEntry[];
    nativeEntries: Array<Record<string, unknown>>;
    warnings: string[];
    userId?: string;
    userLabel?: string;
    completedRuns: number;
    totalMatchedCompletedRuns: number;
    totalCandidateRuns: number;
} | { error: string; candidates?: Array<Record<string, unknown>> }> =>
{
    const userResult = await resolveRunStatsUser(args.user, args.userId);
    if ("error" in userResult)
    {
        return userResult;
    }

    const completedRuns = getCompletedRunLimit(args.completedRuns ?? args.limit);
    const runs = await fetchAccountRuns(runSummaryFields);
    const candidates = runs
        .filter((run) => !run.isDeleted)
        .filter((run) => Boolean(run.completedAt))
        .filter((run) => matchesSprintConfig(run, args.sprintConfig))
        .sort((left, right) =>
        {
            const completed = String(right.completedAt ?? "").localeCompare(String(left.completedAt ?? ""));
            return completed !== 0 ? completed : String(right.startDate ?? "").localeCompare(String(left.startDate ?? ""));
        });
    const selected = candidates.slice(0, completedRuns);
    const entries = selected.map((run) => buildRunDeliveredEffortEntry(
        run,
        userResult.userId,
        args.includeCurrentStats === true,
    ));
    const warnings = [
        ...userResult.warnings,
        ...entries.flatMap((entry) => entry.warnings.map((warning) => `Run #${entry.accountSeq ?? "?"}: ${warning}`)),
    ];

    // Capture source facts before renderer summary defaults; calculations remain unchanged.
    const nativeEntries = selected.map((run, index) => {
        const stats = isRecord(run.stats) ? run.stats : undefined;
        const finish = isRecord(stats?.finishStats) ? stats.finishStats : undefined;
        // Factual bucket observations are independent of the legacy zero/priority fallback calculation.
        const observeDone = (value: unknown) => {
            const scalar = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
            const fields = Array.isArray(value) ? { count: value[0], effort: value[1], noEffort: value[2] } : isRecord(value) ? value : {};
            return { count: scalar(fields.count), effort: scalar(fields.effort), noEffort: scalar(fields.noEffort), effortStatus: !finish ? "missing_finish_stats" : scalar(fields.effort) === null ? "missing_done_bucket" : "observed" };
        };
        const runWide = observeDone(isRecord(finish?.progress) ? finish.progress.done : undefined);
        const observedDone = userResult.userId ? observeDone(findRecordById(finish?.assignee, userResult.userId)?.done) : runWide;
        const facts: Record<string, unknown> = {};
        for (const key of ["accountSeq", "startDate", "endDate", "completedAt"]) if (Object.hasOwn(run, key)) facts[key] = run[key];
        if (Object.hasOwn(run, "name")) facts.customLabel = run.name;
        if (Object.hasOwn(run, "id")) facts.runId = run.id;
        const container = userResult.userId ? findRecordById(finish?.assignee, userResult.userId) : isRecord(finish?.progress) ? finish.progress : undefined;
        if (container && Object.hasOwn(container, "done")) {
            const done = container.done;
            if (done === null) facts.rawDone = null;
            else if (Array.isArray(done)) {
                const raw: Record<string, unknown> = {};
                for (const [index, key] of ["count", "effort", "noEffort"].entries()) if (Object.hasOwn(done, index)) raw[key] = done[index];
                facts.rawDone = raw;
            } else if (isRecord(done)) {
                const raw: Record<string, unknown> = {};
                for (const key of ["count", "effort", "noEffort"]) if (Object.hasOwn(done, key)) raw[key] = done[key];
                facts.rawDone = raw;
            } else facts.rawDone = done;
        }
        return { ...facts, finishStatsPresence: stats && Object.hasOwn(stats, "finishStats") ? stats.finishStats === null ? "null" : "present" : "missing", observedDone, runWide, calculatedDelivered: entries[index].delivered, source: entries[index].source, ...(args.includeCurrentStats === true ? { current: entries[index].current } : {}) };
    });
    return {
        entries,
        nativeEntries,
        warnings,
        userId: userResult.userId,
        userLabel: userResult.userLabel,
        completedRuns,
        totalMatchedCompletedRuns: candidates.length,
        totalCandidateRuns: runs.length,
    };
};

export const summarizeDeliveredEntries = (entries: RunDeliveredEffortEntry[]): RunDoneStats =>
    entries.reduce((total, entry) => addDoneStats(total, entry.delivered), zeroDoneStats());
