import { formatMilestoneUrl } from "./urls";
import { runQuery } from "../runtime/transport";
import { extractEntitiesFromPayload, extractRelationEntities, getEntityMap } from "./entity-maps";
import { getAccount, relationQuery, toIdValue, unwrapData } from "./query";
import { type CodecksEntity } from "./types";

export const deckDetailFields = [
    "id",
    "accountSeq",
    "title",
    "description",
    "isDeleted",
];

export const milestoneDetailFields = [
    "id",
    "accountSeq",
    "name",
    "description",
    "date",
    "startDate",
    "color",
    "isGlobal",
    "handSyncEnabled",
    "isDeleted",
];

export type LookupResult =
    | { kind: "resolved"; id: string | number; label: string }
    | { kind: "ambiguous"; label: string; candidates: Array<{ id?: string | number; title?: string; accountSeq?: number }> }
    | { kind: "missing"; label: string };

export type DeckLookupResult =
    | {
        kind: "resolved";
        id: string | number;
        label: string;
        deck: CodecksEntity;
        accountSeq?: number;
    }
    | Extract<LookupResult, { kind: "ambiguous" | "missing" }>;

export type MilestoneLookupResult =
    | {
        kind: "resolved";
        id: string | number;
        label: string;
        milestone: CodecksEntity;
        accountSeq?: number;
    }
    | Extract<LookupResult, { kind: "ambiguous" | "missing" }>;

export type LookupEntity = {
    id?: string | number;
    accountSeq?: number;
    title?: string;
    name?: string;
};

export const isUuidLike = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value.trim());

export const resolveByNameWithCaseFallback = (
    entities: LookupEntity[],
    input: string,
    label: string,
): LookupResult =>
{
    const needle = input.trim();
    const normalized = needle.toLowerCase();
    const withName = entities
        .map((entry) => ({
            ...entry,
            resolvedName: String(entry.title ?? entry.name ?? ""),
        }))
        .filter((entry) => entry.resolvedName.length > 0);

    const toAmbiguous = (items: Array<LookupEntity & { resolvedName: string }>): LookupResult => ({
        kind: "ambiguous",
        label,
        candidates: items.map((entry) => ({
            id: entry.id,
            title: entry.resolvedName,
            accountSeq: entry.accountSeq,
        })),
    });

    const exactCaseSensitive = withName.filter((entry) => entry.resolvedName === needle);
    if (exactCaseSensitive.length === 1)
    {
        const match = exactCaseSensitive[0];
        return {
            kind: "resolved",
            id: match.id ?? input,
            label: match.resolvedName,
        };
    }
    if (exactCaseSensitive.length > 1)
    {
        return toAmbiguous(exactCaseSensitive);
    }

    const exactCaseInsensitive = withName.filter((entry) => entry.resolvedName.toLowerCase() === normalized);
    if (exactCaseInsensitive.length === 1)
    {
        const match = exactCaseInsensitive[0];
        return {
            kind: "resolved",
            id: match.id ?? input,
            label: match.resolvedName,
        };
    }
    if (exactCaseInsensitive.length > 1)
    {
        return toAmbiguous(exactCaseInsensitive);
    }

    const partialCaseInsensitive = withName.filter((entry) => entry.resolvedName.toLowerCase().includes(normalized));
    if (partialCaseInsensitive.length === 1)
    {
        const match = partialCaseInsensitive[0];
        return {
            kind: "resolved",
            id: match.id ?? input,
            label: match.resolvedName,
        };
    }
    if (partialCaseInsensitive.length > 1)
    {
        return toAmbiguous(partialCaseInsensitive);
    }

    return { kind: "missing", label };
};

export const resolveDeck = async (value: string | number | undefined): Promise<LookupResult> =>
{
    if (value === undefined || value === "")
    {
        return { kind: "missing", label: "deck" };
    }

    const raw = String(value).trim();
    if (typeof value === "number" || /^\d+$/.test(raw))
    {
        return { kind: "resolved", id: toIdValue(value), label: String(value) };
    }

    const query = {
        _root: [
            {
                account: [
                    {
                        decks: ["id", "title", "accountSeq", "isDeleted"],
                    },
                ],
            },
        ],
    };

    const payload = await runQuery(query);
    const decks = extractEntitiesFromPayload(payload, "decks", "deck")
        .filter((entry) => entry.isDeleted !== true && String(entry.isDeleted ?? "").toLowerCase() !== "true");
    if (isUuidLike(raw))
    {
        const deck = decks.find((entry) => String(entry.id ?? "") === raw);
        return deck?.id !== undefined
            ? { kind: "resolved", id: deck.id as string | number, label: String(deck.title ?? deck.name ?? raw) }
            : { kind: "missing", label: "deck" };
    }

    return resolveByNameWithCaseFallback(
        decks.map((deck) => ({
            id: deck.id as string | number | undefined,
            accountSeq: deck.accountSeq as number | undefined,
            title: deck.title as string | undefined,
        })),
        raw,
        "deck",
    );
};

export const fetchAccountDecks = async (fields: Array<string | Record<string, unknown>> = deckDetailFields): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        decks: fields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const deckMap = getEntityMap(data, "deck");
    return extractRelationEntities(account, "decks", deckMap);
};

export const fetchDecksByAccountSeq = async (accountSeq: number): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        [relationQuery("decks", { accountSeq: [accountSeq] })]: deckDetailFields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const deckMap = getEntityMap(data, "deck");
    return extractRelationEntities(account, "decks", deckMap);
};

export const getDeckId = (deck: CodecksEntity | undefined): string => String(deck?.id ?? "").trim();

export const getDeckAccountSeq = (deck: CodecksEntity | undefined): number | undefined =>
{
    const value = deck?.accountSeq;
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

export const getDeckLabel = (deck: CodecksEntity): string =>
    String(deck.title ?? deck.name ?? "").trim()
    || (getDeckAccountSeq(deck) !== undefined ? `Deck ${getDeckAccountSeq(deck)}` : "Deck");

export const parseDeckAccountSeq = (value: unknown): number | undefined =>
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
    const explicit = trimmed.match(/^(?:deck|seq|accountseq)\s*:?\s*(\d+)$/i);
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

export const resolveDeckForUpdate = async (value: string | number): Promise<DeckLookupResult> =>
{
    const accountSeq = parseDeckAccountSeq(value);
    const raw = String(value).trim();
    let matches: CodecksEntity[] = [];

    if (accountSeq !== undefined)
    {
        matches = await fetchDecksByAccountSeq(accountSeq);
    }
    else
    {
        const decks = await fetchAccountDecks();
        if (isUuidLike(raw))
        {
            matches = decks.filter((deck) => getDeckId(deck) === raw);
        }
        else
        {
            const lookup = resolveByNameWithCaseFallback(
                decks.map((deck) => ({
                    id: deck.id as string | number | undefined,
                    accountSeq: getDeckAccountSeq(deck),
                    title: deck.title as string | undefined,
                    name: deck.name as string | undefined,
                })),
                raw,
                "deck",
            );
            if (lookup.kind !== "resolved")
            {
                return lookup;
            }
            matches = decks.filter((deck) => String(deck.id ?? "") === String(lookup.id));
        }
    }

    const deck = matches[0];
    const deckId = getDeckId(deck);
    if (!deck || !deckId)
    {
        return { kind: "missing", label: "deck" };
    }

    return {
        kind: "resolved",
        id: deckId,
        label: getDeckLabel(deck),
        deck,
        accountSeq: getDeckAccountSeq(deck),
    };
};

export const resolveMilestone = async (value: string | number | undefined): Promise<LookupResult> =>
{
    if (value === undefined || value === "")
    {
        return { kind: "missing", label: "milestone" };
    }

    const raw = String(value).trim();
    if (typeof value === "number" || /^\d+$/.test(raw))
    {
        return { kind: "resolved", id: toIdValue(value), label: String(value) };
    }

    const query = {
        _root: [
            {
                account: [
                    {
                        milestones: ["id", "name", "accountSeq", "isDeleted"],
                    },
                ],
            },
        ],
    };

    const payload = await runQuery(query);
    const milestones = extractEntitiesFromPayload(payload, "milestones", "milestone")
        .filter((entry) => entry.isDeleted !== true && String(entry.isDeleted ?? "").toLowerCase() !== "true");
    if (isUuidLike(raw))
    {
        const milestone = milestones.find((entry) => String(entry.id ?? "") === raw);
        return milestone?.id !== undefined
            ? { kind: "resolved", id: milestone.id as string | number, label: String(milestone.name ?? milestone.title ?? raw) }
            : { kind: "missing", label: "milestone" };
    }

    return resolveByNameWithCaseFallback(
        milestones.map((milestone) => ({
            id: milestone.id as string | number | undefined,
            accountSeq: milestone.accountSeq as number | undefined,
            name: milestone.name as string | undefined,
        })),
        raw,
        "milestone",
    );
};

export const fetchAccountMilestones = async (fields: Array<string | Record<string, unknown>> = milestoneDetailFields): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        milestones: fields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const milestoneMap = getEntityMap(data, "milestone");
    return extractRelationEntities(account, "milestones", milestoneMap);
};

export const fetchMilestonesByAccountSeq = async (accountSeq: number): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        [relationQuery("milestones", { accountSeq: [accountSeq] })]: milestoneDetailFields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const milestoneMap = getEntityMap(data, "milestone");
    return extractRelationEntities(account, "milestones", milestoneMap);
};

export const getMilestoneId = (milestone: CodecksEntity | undefined): string => String(milestone?.id ?? "").trim();

export const getMilestoneAccountSeq = (milestone: CodecksEntity | undefined): number | undefined =>
{
    const value = milestone?.accountSeq;
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

export const getMilestoneLabel = (milestone: CodecksEntity): string =>
    String(milestone.name ?? milestone.title ?? "").trim()
    || (getMilestoneAccountSeq(milestone) !== undefined ? `Milestone ${getMilestoneAccountSeq(milestone)}` : "Milestone");

export const parseMilestoneAccountSeq = (value: unknown): number | undefined =>
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
    const explicit = trimmed.match(/^(?:milestone|seq|accountseq)\s*:?\s*(\d+)$/i);
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

export const resolveMilestoneForUpdate = async (value: string | number): Promise<MilestoneLookupResult> =>
{
    const accountSeq = parseMilestoneAccountSeq(value);
    const raw = String(value).trim();
    let matches: CodecksEntity[] = [];

    if (accountSeq !== undefined)
    {
        matches = await fetchMilestonesByAccountSeq(accountSeq);
    }
    else
    {
        const milestones = await fetchAccountMilestones();
        if (isUuidLike(raw))
        {
            matches = milestones.filter((milestone) => getMilestoneId(milestone) === raw);
        }
        else
        {
            const lookup = resolveByNameWithCaseFallback(
                milestones.map((milestone) => ({
                    id: milestone.id as string | number | undefined,
                    accountSeq: getMilestoneAccountSeq(milestone),
                    name: milestone.name as string | undefined,
                    title: milestone.title as string | undefined,
                })),
                raw,
                "milestone",
            );
            if (lookup.kind !== "resolved")
            {
                return lookup;
            }
            matches = milestones.filter((milestone) => String(milestone.id ?? "") === String(lookup.id));
        }
    }

    const milestone = matches[0];
    const milestoneId = getMilestoneId(milestone);
    if (!milestone || !milestoneId)
    {
        return { kind: "missing", label: "milestone" };
    }

    return {
        kind: "resolved",
        id: milestoneId,
        label: getMilestoneLabel(milestone),
        milestone,
        accountSeq: getMilestoneAccountSeq(milestone),
    };
};

export const renderLookupMessage = (result: LookupResult, labelValue?: string): string =>
{
    if (result.kind === "ambiguous")
    {
        const lines = [
            `Multiple ${result.label}s matched "${labelValue ?? ""}". Please be more specific or provide an ID.`,
            "",
            ...result.candidates.map((candidate) =>
                `- ${candidate.title ?? "(untitled)"} (id: ${candidate.id ?? "n/a"}, seq: ${candidate.accountSeq ?? "n/a"})`,
            ),
        ];
        return lines.join("\n");
    }

    if (result.kind === "missing")
    {
        return `No ${result.label} matched "${labelValue ?? ""}". Provide an exact ID or a more specific title.`;
    }

    return "";
};

export const normalizeMilestoneSummary = (entity: unknown): Record<string, unknown> | null =>
{
    if (!entity || typeof entity !== "object")
    {
        return null;
    }

    const value = entity as CodecksEntity;
    const accountSeq = getMilestoneAccountSeq(value);
    return {
        id: value.id ?? null,
        accountSeq: accountSeq ?? null,
        name: value.name ?? null,
        title: value.title ?? null,
        description: value.description ?? null,
        date: value.date ?? null,
        startDate: value.startDate ?? null,
        color: value.color ?? null,
        isGlobal: value.isGlobal ?? null,
        handSyncEnabled: value.handSyncEnabled ?? null,
        isDeleted: value.isDeleted ?? null,
        url: accountSeq !== undefined ? formatMilestoneUrl(accountSeq) : null,
    };
};
