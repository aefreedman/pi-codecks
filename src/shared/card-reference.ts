
export const CARD_CODE_LETTERS = "123456789acefghijkoqrsuvwxyz";
export const CARD_CODE_LENGTH = CARD_CODE_LETTERS.length;
export const CARD_CODE_START = CARD_CODE_LENGTH * (CARD_CODE_LENGTH + 1) - 1;
export const CARD_CODE_INDEX = new Map<string, number>(
    CARD_CODE_LETTERS.split("").map((letter, index) => [letter, index]),
);
export const CARD_CODE_REGEX = /\$([0-9a-z]+)/gi;
export const CARD_URL_REGEX = /codecks\.io\/card\/([0-9a-z]+)/i;
export const CARD_SLUG_REGEX = /^([0-9a-z]+)(?:-|$)/i;
export const USER_ID_TAG_REGEX = /@\[\s*userId\s*:\s*([0-9a-f-]+)\s*\]/gi;
export const MAX_REFERENCE_LOOKUPS = 10;
export const CARD_REFERENCE_CHAR_CLASS = `[${CARD_CODE_LETTERS}]`;
export const CARD_REFERENCE_INLINE_CODE_REGEX = new RegExp("`(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)`", "gi");
export const CARD_REFERENCE_EMPHASIS_REGEXES = [
    new RegExp("\\*\\*\\*(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)\\*\\*\\*", "gi"),
    new RegExp("___(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)___", "gi"),
    new RegExp("\\*\\*(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)\\*\\*", "gi"),
    new RegExp("__(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)__", "gi"),
    new RegExp("\\*(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)\\*", "gi"),
    new RegExp("_(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)_", "gi"),
    new RegExp("~~(\\$" + CARD_REFERENCE_CHAR_CLASS + "+)~~", "gi"),
] as const;
export const CARD_REFERENCE_FENCED_BLOCK_REGEX = /```(?:[^\r\n`]*)\r?\n([\s\S]*?)\r?\n```/gi;

export const isValidCardCode = (code: string): boolean =>
{
    if (!code)
    {
        return false;
    }

    for (const char of code)
    {
        if (!CARD_CODE_INDEX.has(char))
        {
            return false;
        }
    }

    return true;
};

export const normalizeCardCode = (value: string, allowBare = false): string | null =>
{
    const trimmed = value.trim().toLowerCase();
    const hasPrefix = trimmed.startsWith("$");
    if (!hasPrefix && !allowBare)
    {
        return null;
    }

    const cleaned = hasPrefix ? trimmed.slice(1) : trimmed;
    if (!cleaned)
    {
        return null;
    }

    return isValidCardCode(cleaned) ? cleaned : null;
};

export const extractCardCode = (value: string, allowBare = false): string | null =>
{
    const urlMatch = value.match(CARD_URL_REGEX);
    if (urlMatch)
    {
        return normalizeCardCode(urlMatch[1] ?? "", true);
    }

    const dollarMatch = value.match(CARD_CODE_REGEX);
    if (dollarMatch && dollarMatch.length > 0)
    {
        return normalizeCardCode(dollarMatch[0] ?? "", true);
    }

    if (allowBare)
    {
        const slugMatch = value.match(CARD_SLUG_REGEX);
        if (slugMatch)
        {
            const candidate = normalizeCardCode(slugMatch[1] ?? "", true);
            if (candidate)
            {
                return candidate;
            }
        }

        return normalizeCardCode(value, true);
    }

    return null;
};

export const cardCodeToAccountSeq = (value: string): number | null =>
{
    const code = normalizeCardCode(value, true);
    if (!code)
    {
        return null;
    }

    let intVal = CARD_CODE_INDEX.get(code[0]);
    if (intVal === undefined)
    {
        return null;
    }

    for (let i = 1; i < code.length; i += 1)
    {
        intVal += 1;
        intVal *= CARD_CODE_LENGTH;
        const index = CARD_CODE_INDEX.get(code[i]);
        if (index === undefined)
        {
            return null;
        }
        intVal += index;
    }

    const seq = intVal - CARD_CODE_START;
    return seq >= 0 ? seq : null;
};

export const accountSeqToCardCode = (value: number): string =>
{
    if (!Number.isFinite(value) || value < 0)
    {
        return "";
    }

    let seq = "";
    let q = value + CARD_CODE_START + 1;

    do
    {
        q -= 1;
        const remainder = q % CARD_CODE_LENGTH;
        q = Math.floor(q / CARD_CODE_LENGTH);
        seq = `${CARD_CODE_LETTERS[remainder]}${seq}`;
    }
    while (q !== 0);

    return seq;
};

export const extractReferenceCodes = (content?: unknown): string[] =>
{
    const raw = content ? String(content) : "";
    const matches = raw.matchAll(CARD_CODE_REGEX);
    const codes = new Set<string>();

    for (const match of matches)
    {
        const candidate = normalizeCardCode(match[0] ?? "", true);
        if (candidate)
        {
            codes.add(candidate);
        }
    }

    return Array.from(codes);
};

export const stripCardReferenceFormatting = (value: string): string =>
{
    let normalized = value.replace(CARD_REFERENCE_INLINE_CODE_REGEX, "$1");
    for (const regex of CARD_REFERENCE_EMPHASIS_REGEXES)
    {
        normalized = normalized.replace(regex, "$1");
    }
    return normalized;
};

export const normalizeCardReferencesForUserText = (value: string): string =>
{
    if (!value)
    {
        return value;
    }

    const withoutReferenceOnlyFences = value.replace(CARD_REFERENCE_FENCED_BLOCK_REGEX, (match, blockContent) =>
    {
        const content = String(blockContent ?? "");
        const lines = content.split(/\r?\n/);
        const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
        if (nonEmptyLines.length === 0)
        {
            return match;
        }

        const allReferenceLines = nonEmptyLines.every((line) =>
        {
            const normalized = stripCardReferenceFormatting(line).trim();
            return /^(?:[-*+]\s+)?\$[123456789acefghijkoqrsuvwxyz]+$/i.test(normalized);
        });
        if (!allReferenceLines)
        {
            return match;
        }

        return lines
            .map((line) => stripCardReferenceFormatting(line))
            .join("\n");
    });

    return stripCardReferenceFormatting(withoutReferenceOnlyFences);
};

export type ParsedCardIdentifier = {
    accountSeq?: number;
    cardId?: string;
    cardCode?: string;
};

export const parseCardIdentifier = (value: string | number | undefined): ParsedCardIdentifier =>
{
    if (value === undefined || value === null)
    {
        return {};
    }

    if (typeof value === "number")
    {
        const numericCode = normalizeCardCode(String(value), true);
        if (numericCode)
        {
            const seq = cardCodeToAccountSeq(numericCode);
            if (seq !== null)
            {
                return { accountSeq: seq, cardCode: numericCode };
            }
        }

        return { cardId: String(value) };
    }

    const trimmed = String(value).trim();
    if (!trimmed)
    {
        return {};
    }

    const explicitSeq = trimmed.match(/^(?:seq|accountseq)\s*:\s*(\d+)$/i);
    if (explicitSeq)
    {
        return { accountSeq: Number(explicitSeq[1]) };
    }

    if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(trimmed))
    {
        return { cardId: trimmed };
    }

    const allowBareCode = /^[0-9a-z]+$/i.test(trimmed) && trimmed.length <= 6;
    const code = extractCardCode(trimmed, allowBareCode);
    if (code)
    {
        const seq = cardCodeToAccountSeq(code);
        if (seq !== null)
        {
            return { accountSeq: seq, cardCode: code };
        }
    }

    return { cardId: trimmed };
};

export const formatShortCode = (value?: number): string =>
{
    if (value === undefined)
    {
        return "";
    }

    const code = accountSeqToCardCode(value);
    return code ? `$${code}` : "";
};

export const buildReusableCardRefs = (accountSeq?: number): { cardRef: string | null; accountSeqRef: string | null } =>
{
    const shortCode = formatShortCode(accountSeq);
    return {
        cardRef: shortCode || null,
        accountSeqRef: accountSeq !== undefined ? `seq:${accountSeq}` : null,
    };
};
