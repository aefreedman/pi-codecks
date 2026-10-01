import { resolveCardType } from "./card-observation";
import { formatShortCode } from "./card-reference";
import { normalizeCollection } from "./query";
import { normalizeResolvableContextInput } from "./resolvable-context";
import { type CodecksEntity } from "./types";

export const formatDateTime = (value?: unknown): string =>
{
    if (!value)
    {
        return "";
    }

    const date = new Date(String(value));
    if (Number.isNaN(date.getTime()))
    {
        return String(value);
    }

    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
};

export const formatStatusIcon = (value?: unknown): string =>
{
    const status = String(value ?? "").trim().toLowerCase();
    if (!status)
    {
        return "[?]";
    }

    if (status === "done")
    {
        return "[x]";
    }

    if (status === "started")
    {
        return "[>]";
    }

    if (status === "not_started")
    {
        return "[ ]";
    }

    return "[?]";
};

export const formatPriorityLabel = (value?: unknown): string =>
{
    if (value === null || value === undefined)
    {
        return "None";
    }

    if (typeof value === "number")
    {
        if (value === 0)
        {
            return "None";
        }
        if (value === 1)
        {
            return "Low";
        }
        if (value === 2)
        {
            return "Medium";
        }
        if (value === 3)
        {
            return "High";
        }
        return `Unknown (${value})`;
    }

    const normalized = String(value).trim().toLowerCase();
    if (!normalized)
    {
        return "None";
    }

    if (normalized === "a" || normalized === "high")
    {
        return "High";
    }
    if (normalized === "b" || normalized === "medium")
    {
        return "Medium";
    }
    if (normalized === "c" || normalized === "low")
    {
        return "Low";
    }
    if (normalized === "none" || normalized === "null")
    {
        return "None";
    }

    return `Unknown (${value})`;
};

export const normalizeTagLabel = (value: unknown): string =>
{
    if (!value)
    {
        return "";
    }

    if (typeof value === "string")
    {
        return value.trim();
    }

    if (typeof value === "object")
    {
        const entity = value as CodecksEntity;
        const candidate = entity.name
            ?? entity.title
            ?? entity.tag
            ?? entity.label
            ?? entity.id;
        return candidate ? String(candidate).trim() : "";
    }

    return String(value).trim();
};

export const formatTags = (value: unknown): string[] =>
{
    const values = normalizeCollection(value as unknown[] | undefined);
    const tags = values
        .map((entry) => normalizeTagLabel(entry))
        .filter((entry) => entry.length > 0);

    return Array.from(new Set(tags));
};

export const normalizeTableValue = (value: string): string =>
{
    return value.replace(/\s+/g, " ").trim();
};

export const renderTable = (rows: Array<[string, string]>): string[] =>
{
    if (rows.length === 0)
    {
        return [];
    }

    const normalized = rows.map(([label, value]) => [label, normalizeTableValue(value)] as [string, string]);
    const labelWidth = Math.max(...normalized.map(([label]) => label.length));
    const valueWidth = Math.max(...normalized.map(([, value]) => value.length));
    const border = `+${"-".repeat(labelWidth + 2)}+${"-".repeat(valueWidth + 2)}+`;
    const lines = [border];

    for (const [label, value] of normalized)
    {
        lines.push(`| ${label.padEnd(labelWidth)} | ${value.padEnd(valueWidth)} |`);
    }

    lines.push(border);
    return lines;
};

export const formatCardContent = (content?: unknown): string =>
{
    const raw = content ? String(content) : "";
    if (!raw.trim())
    {
        return "(no content)";
    }

    const lines = raw.split(/\r?\n/);
    if (lines.length === 0)
    {
        return "(no content)";
    }

    const firstLine = lines[0];
    const trimmed = firstLine.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("#"))
    {
        lines[0] = `# ${firstLine}`;
    }

    return lines.join("\n");
};

export const formatResolvableContextLabel = (value: unknown): string =>
{
    const normalized = normalizeResolvableContextInput(value);
    if ("error" in normalized)
    {
        const raw = String(value ?? "").trim();
        return raw || "unknown";
    }

    return normalized.label;
};

export const formatCardLine = (card: CodecksEntity): string =>
{
    const title = card.title ?? "(untitled)";
    const deck = (card.deck as CodecksEntity | undefined)?.title ?? "No deck";
    const milestone = (card.milestone as CodecksEntity | undefined)?.title
        ?? (card.milestone as CodecksEntity | undefined)?.name
        ?? "No milestone";
    const assignee = (card.assignee as CodecksEntity | undefined)?.name
        ?? (card.assignee as CodecksEntity | undefined)?.fullName
        ?? "Unassigned";
    const status = card.status ?? "unknown";
    const cardType = resolveCardType(card);
    const tags = formatTags(card.masterTags);
    const updated = formatDateTime(card.lastUpdatedAt);
    const accountSeq = card.accountSeq as number | undefined;
    const shortCode = formatShortCode(accountSeq);
    const id = shortCode || (card.cardId as string | number | undefined) || accountSeq || "";
    const tagsPart = tags.length > 0 ? ` â€¢ Tags: ${tags.join(", ")}` : "";
    const statePart = cardType === "documentation" ? "Type: Documentation" : `Status: ${status}`;
    return `${title} â€” ${statePart} â€¢ Deck: ${deck} â€¢ Milestone: ${milestone} â€¢ Assignee: ${assignee}${tagsPart} â€¢ Updated: ${updated} â€¢ ID: ${id}`;
};
