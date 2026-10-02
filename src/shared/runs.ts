import { runQuery } from "../runtime/transport";
import { extractRelationEntities, getEntityMap, resolveFromMap } from "./entity-maps";
import { getAccount, normalizeCollection, relationQuery, unwrapData } from "./query";
import { UUID_PATTERN } from "./session-id";
import { type CodecksEntity } from "./types";
import { formatRunUrl } from "./urls";

export type RunLookupResult = {
    run: CodecksEntity;
    runId: string;
    accountSeq?: number;
    label: string;
    dateRange: string;
};

export const hydrateRun = (run: CodecksEntity, maps: {
    sprintConfig: Record<string, CodecksEntity>;
    card: Record<string, CodecksEntity>;
}): CodecksEntity =>
{
    const cards = normalizeCollection(run.cards as unknown[] | undefined)
        .map((entry) => (typeof entry === "object" && entry ? entry as CodecksEntity : resolveFromMap(entry, maps.card)))
        .filter((entry): entry is CodecksEntity => Boolean(entry));
    return {
        ...run,
        sprintConfig: resolveFromMap(run.sprintConfig, maps.sprintConfig) ?? run.sprintConfig,
        ...(cards.length > 0 ? { cards } : {}),
    };
};

export const fetchAccountRuns = async (fields: Array<string | Record<string, unknown>> = runSummaryFields): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    "sprintsEnabled",
                    {
                        sprints: fields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    if (account?.sprintsEnabled === false)
    {
        throw new Error("Codecks Runs/Sprints are not enabled for this account.");
    }

    const sprintMap = getEntityMap(data, "sprint");
    const sprintConfigMap = getEntityMap(data, "sprintConfig");
    const cardMap = getEntityMap(data, "card");
    return extractRelationEntities(account, "sprints", sprintMap)
        .map((run) => hydrateRun(run, { sprintConfig: sprintConfigMap, card: cardMap }));
};

export const fetchRunsByAccountSeq = async (
    accountSeq: number,
    fields: Array<string | Record<string, unknown>> = runDetailFields,
): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        [relationQuery("sprints", { accountSeq: [accountSeq] })]: fields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const sprintMap = getEntityMap(data, "sprint");
    const sprintConfigMap = getEntityMap(data, "sprintConfig");
    const cardMap = getEntityMap(data, "card");
    return extractRelationEntities(account, "sprints", sprintMap)
        .map((run) => hydrateRun(run, { sprintConfig: sprintConfigMap, card: cardMap }));
};

export const parseRunAccountSeq = (value: unknown): number | undefined =>
{
    if (typeof value === "number" && Number.isInteger(value) && value > 0)
    {
        return value;
    }

    if (typeof value !== "string")
    {
        return undefined;
    }

    const trimmed = value.trim();
    const explicit = trimmed.match(/^(?:run|sprint|seq|accountseq)\s*:?\s*(\d+)$/i);
    if (explicit)
    {
        return Number(explicit[1]);
    }

    if (/^\d+$/.test(trimmed))
    {
        return Number(trimmed);
    }

    return undefined;
};

export const getRunId = (run: CodecksEntity | undefined): string => String(run?.id ?? "").trim();

export const getRunAccountSeq = (run: CodecksEntity | undefined): number | undefined =>
{
    const value = run?.accountSeq;
    if (typeof value === "number")
    {
        return value;
    }
    if (typeof value === "string" && /^\d+$/.test(value))
    {
        return Number(value);
    }
    return undefined;
};

export const getRunDateRange = (run: CodecksEntity): string =>
{
    const start = String(run.startDate ?? "").trim();
    const end = String(run.endDate ?? "").trim();
    if (start && end)
    {
        return `${start} â€“ ${end}`;
    }
    return start || end || "";
};

export const getRunLabel = (run: CodecksEntity): string =>
{
    const customLabel = String(run.name ?? "").trim();
    if (customLabel)
    {
        return customLabel;
    }
    const accountSeq = getRunAccountSeq(run);
    const dateRange = getRunDateRange(run);
    return [accountSeq !== undefined ? `Run ${accountSeq}` : "Run", dateRange].filter(Boolean).join(" â€¢ ");
};

export const normalizeRunSummary = (run: CodecksEntity): Record<string, unknown> =>
{
    const sprintConfig = typeof run.sprintConfig === "object" && run.sprintConfig ? run.sprintConfig as CodecksEntity : undefined;
    const accountSeq = getRunAccountSeq(run);
    return {
        runId: getRunId(run) || null,
        sprintId: getRunId(run) || null,
        accountSeq: accountSeq ?? null,
        label: getRunLabel(run),
        customLabel: run.name ?? null,
        description: run.description ?? null,
        startDate: run.startDate ?? null,
        endDate: run.endDate ?? null,
        dateRange: getRunDateRange(run) || null,
        sprintConfig: sprintConfig ? {
            id: sprintConfig.id ?? null,
            name: sprintConfig.name ?? null,
            color: sprintConfig.color ?? null,
        } : (run.sprintConfig ?? null),
        isDeleted: Boolean(run.isDeleted),
        completedAt: run.completedAt ?? null,
        lockedAt: run.lockedAt ?? null,
        url: accountSeq !== undefined ? formatRunUrl(accountSeq) : null,
    };
};

export const resolveRunForUpdate = async (value: string | number): Promise<RunLookupResult | null> =>
{
    const accountSeq = parseRunAccountSeq(value);
    const trimmed = String(value).trim();
    let matches: CodecksEntity[] = [];

    if (accountSeq !== undefined)
    {
        matches = await fetchRunsByAccountSeq(accountSeq);
    }
    else if (UUID_PATTERN.test(trimmed))
    {
        const runs = await fetchAccountRuns(runDetailFields);
        matches = runs.filter((run) => getRunId(run) === trimmed);
    }
    else
    {
        const query = trimmed.toLowerCase();
        const runs = await fetchAccountRuns(runDetailFields);
        matches = runs.filter((run) =>
        {
            const label = getRunLabel(run).toLowerCase();
            const customLabel = String(run.name ?? "").toLowerCase();
            return label.includes(query) || customLabel.includes(query);
        });
    }

    const run = matches[0];
    const runId = getRunId(run);
    if (!run || !runId)
    {
        return null;
    }

    return {
        run,
        runId,
        accountSeq: getRunAccountSeq(run),
        label: getRunLabel(run),
        dateRange: getRunDateRange(run),
    };
};

export const runSummaryFields = [
    "id",
    "accountSeq",
    "name",
    "description",
    "index",
    "startDate",
    "endDate",
    "stats",
    "manualOrderLabels",
    "userCapacities",
    "handSyncEnabled",
    "createdAt",
    "isDeleted",
    "completedAt",
    "lockedAt",
    { sprintConfig: ["id", "name", "color"] },
];

export const runDetailFields = [
    ...runSummaryFields,
    { cards: ["cardId", "accountSeq", "title", "status", "derivedStatus", "isDoc", "sprintId"] },
];
