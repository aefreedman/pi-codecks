import { type DeckLookupResult, fetchAccountDecks, fetchDecksByAccountSeq, getDeckAccountSeq, getDeckId, getDeckLabel, getMilestoneAccountSeq, getMilestoneLabel, isUuidLike, parseDeckAccountSeq } from "../../shared/entity-resolution";
import { type CodecksEntity } from "../../shared/types";
import { formatMilestoneUrl } from "../../shared/urls";

export const resolveDeckForGet = async (value: string | number): Promise<DeckLookupResult> =>
{
    const accountSeq = parseDeckAccountSeq(value);
    const raw = String(value).trim();
    const decks = accountSeq === undefined ? await fetchAccountDecks() : await fetchDecksByAccountSeq(accountSeq);
    const matches = accountSeq !== undefined
        ? decks
        : isUuidLike(raw)
            ? decks.filter((deck) => getDeckId(deck) === raw)
            : decks.filter((deck) => getDeckLabel(deck) === raw || getDeckLabel(deck).toLowerCase() === raw.toLowerCase());
    if (matches.length === 0) return { kind: "missing", label: "deck" };
    if (matches.length > 1) return {
        kind: "ambiguous",
        label: "deck",
        candidates: matches.map((deck) => ({ id: getDeckId(deck), title: getDeckLabel(deck), accountSeq: getDeckAccountSeq(deck) })),
    };
    const deck = matches[0]!;
    return { kind: "resolved", id: getDeckId(deck), label: getDeckLabel(deck), deck, accountSeq: getDeckAccountSeq(deck) };
};

export const filterMilestonesBySearch = (milestones: CodecksEntity[], search: string | undefined): CodecksEntity[] =>
{
    const needle = search?.trim().toLowerCase();
    if (!needle)
    {
        return milestones;
    }

    return milestones.filter((milestone) => {
        const haystack = [
            milestone.name,
            milestone.title,
            milestone.description,
            getMilestoneAccountSeq(milestone)?.toString(),
            milestone.id,
        ]
            .filter((value) => value !== undefined && value !== null)
            .map((value) => String(value).toLowerCase())
            .join("\n");
        return haystack.includes(needle);
    });
};

export const renderMilestoneListText = (milestones: CodecksEntity[], heading: string): string =>
{
    const lines = [
        `## ${heading}`,
        "",
        `Milestones: ${milestones.length}`,
        "",
        ...milestones.map((milestone) => {
            const accountSeq = getMilestoneAccountSeq(milestone);
            const url = accountSeq !== undefined ? ` â€” ${formatMilestoneUrl(accountSeq)}` : "";
            const deleted = milestone.isDeleted === true ? " [deleted]" : "";
            return `- #${accountSeq ?? "?"} ${getMilestoneLabel(milestone)}${deleted}${url}`;
        }),
    ];
    return lines.join("\n");
};
