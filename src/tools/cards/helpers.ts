import { validateMutationText } from "../../shared/mutation-text";
import { getAuthenticatedConfig, getBaseConfig } from "../../runtime/credentials";
import { fetchLoggedInUser, fetchSharedActor } from "../../runtime/identity";
import { getActiveAbortSignal, getOperationContext, noteOperationRequest } from "../../runtime/operation-context";
import { CodecksOperationError } from "../../runtime/operation-error";
import { enforceRateLimit, observeServerCooldown, serverCooldownUntil } from "../../runtime/pacing";
import { MAX_BATCH_CARD_RESPONSE_BYTES, apiFailure, codecksAuthHeaders, runDispatch, runQuery } from "../../runtime/transport";
import { type CardTypeValue, getCardChildCountInfo, hasOwn, isCardTypeKnown, resolveCardType } from "../../shared/card-observation";
import { cardDetailFields, extractCardsFromPayload, fetchCardByAccountSeq, fetchCardById, hydrateCard, resolveCardForUpdate } from "../../shared/card-queries";
import { buildReusableCardRefs, formatShortCode, normalizeCardReferencesForUserText, parseCardIdentifier } from "../../shared/card-reference";
import { normalizeCardSearchSummary, resolveExplicitHumanHandTarget } from "../../shared/card-search";
import { extractRelationEntities, getEntityMap, resolveFromMap } from "../../shared/entity-maps";
import { type LookupResult, normalizeMilestoneSummary, renderLookupMessage, resolveDeck, resolveMilestone } from "../../shared/entity-resolution";
import { formatPriorityLabel, formatTags } from "../../shared/presentation";
import { blankToUndefined, formatIdForQuery, getAccount, getRelation, isRecord, normalizeCollection, relationQuery, unwrapData } from "../../shared/query";
import { normalizeResolvableContextInput } from "../../shared/resolvable-context";
import { classifyApiErrorCategory, getOperationErrorData, toErrorMessage, toStructuredErrorResult, toStructuredResult } from "../../shared/results";
import { type RunLookupResult, resolveRunForUpdate } from "../../shared/runs";
import { generateSessionId } from "../../shared/session-id";
import { type CodecksEntity, type CodecksUser } from "../../shared/types";
import { formatCardUrl } from "../../shared/urls";
import { fetchUsersByIds, getFallbackAssigneeId, normalizeUserId, resolveAssigneeId } from "../../shared/users";
import { createHash } from "node:crypto";
import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { evictOnePasswordCredentialGeneration } from "../../codecks-onepassword";
import { promises as fs } from "fs";
import { basename } from "path";
import { extname } from "path";
import { isAbsolute } from "path";
import { join } from "path";
import { relative } from "path";
import { resolve } from "path";

export const normalizeCreateTags = (value: unknown): string[] =>
{
    const values = normalizeCollection(value as unknown[] | undefined);
    const seen = new Set<string>();
    const tags: string[] = [];

    for (const entry of values)
    {
        const cleaned = String(entry ?? "").trim().replace(/^#+/, "");
        if (!cleaned)
        {
            continue;
        }

        const key = cleaned.toLowerCase();
        if (seen.has(key))
        {
            continue;
        }

        seen.add(key);
        tags.push(cleaned);
    }

    return tags;
};

export const buildBodyHashtagTokens = (tags: string[]): string[] =>
{
    const seen = new Set<string>();
    const tokens: string[] = [];

    for (const tag of tags)
    {
        const token = tag
            .trim()
            .replace(/^#+/, "")
            .replace(/\s+/g, "-")
            .replace(/^[-_]+|[-_]+$/g, "");
        if (!token)
        {
            continue;
        }

        const key = token.toLowerCase();
        if (seen.has(key))
        {
            continue;
        }

        seen.add(key);
        tokens.push(token);
    }

    return tokens;
};

export const appendBodyHashtagsToCardContent = (content: string, tags: string[]): string =>
{
    const { titleLine, body } = splitCardContent(content);
    // Only canonical tag-only footer lines are metadata. Leave prose and code alone.
    const lines = body.split(/\r?\n/);
    let footerStart = lines.length;
    while (footerStart > 0 && (/^\s*$/.test(lines[footerStart - 1])
        || /^#[^\s#`]+(?:[ \t]+#[^\s#`]+)*[ \t]*$/.test(lines[footerStart - 1])))
    {
        footerStart--;
    }
    let fence: string | undefined;
    for (const line of lines.slice(0, footerStart))
    {
        const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
        if (!match) continue;
        if (!fence) fence = match[1];
        else if (match[1][0] === fence[0] && match[1].length >= fence.length
            && line.slice(match[0].length).trim() === "") fence = undefined;
    }
    if (fence) footerStart = lines.length;

    const existing = lines.slice(footerStart).join(" ").trim().split(/\s+/).filter(Boolean);
    const seen = new Set<string>();
    const footer = [...existing, ...tags.map((tag) => `#${tag}`)].filter((token) =>
    {
        const key = token.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    if (footer.length === 0) return content;
    const prefix = lines.slice(0, footerStart).join("\n").trimEnd();
    return buildCardContent(titleLine, [prefix, footer.join(" ")].filter(Boolean).join("\n\n"));
};

export const normalizeCardTypeInput = (value: string): { value: CardTypeValue; label: string; isDoc: boolean } | null =>
{
    const normalized = value.trim().toLowerCase();
    if (!normalized)
    {
        return null;
    }

    if (["regular", "task", "normal"].includes(normalized))
    {
        return { value: "regular", label: "regular", isDoc: false };
    }

    if (["documentation", "doc", "docs"].includes(normalized))
    {
        return { value: "documentation", label: "documentation", isDoc: true };
    }

    return null;
};

export const normalizePriorityInput = (value: string): { code: string | null; label: string } | null =>
{
    const normalized = value.trim().toLowerCase();
    if (!normalized)
    {
        return null;
    }

    if (normalized === "none" || normalized === "null")
    {
        return { code: null, label: "None" };
    }

    if (normalized === "low" || normalized === "c")
    {
        return { code: "c", label: "Low" };
    }

    if (normalized === "medium" || normalized === "b")
    {
        return { code: "b", label: "Medium" };
    }

    if (normalized === "high" || normalized === "a")
    {
        return { code: "a", label: "High" };
    }

    return null;
};

export const normalizeStatusInput = (value: string): { code: string; label: string } | null =>
{
    const normalized = value.trim().toLowerCase();
    if (!normalized)
    {
        return null;
    }

    if (["not_started", "not started", "todo", "to_do", "open", "backlog"].includes(normalized))
    {
        return { code: "not_started", label: "not_started" };
    }

    if (["started", "in_progress", "in progress", "doing", "active"].includes(normalized))
    {
        return { code: "started", label: "started" };
    }

    if (["done", "complete", "completed", "closed"].includes(normalized))
    {
        return { code: "done", label: "done" };
    }

    return null;
};

export const normalizeCardTitleLine = (value: string): string => stripLeadingHeaderTags(value).trim();

export const findFirstNonEmptyLineIndex = (lines: string[]): number => lines.findIndex((line) => line.trim().length > 0);

export const stripLeadingHeaderTags = (content: string): string =>
{
    const lines = content.split(/\r?\n/);
    if (lines.length === 0)
    {
        return content;
    }

    lines[0] = lines[0].replace(/^\s*#+\s*/, "");
    return lines.join("\n");
};

export const splitCardContent = (content: string, fallbackTitle?: string): { titleLine: string; body: string } =>
{
    const lines = content.split(/\r?\n/);
    const firstContentIndex = findFirstNonEmptyLineIndex(lines);
    if (firstContentIndex === -1)
    {
        return {
            titleLine: normalizeCardTitleLine(fallbackTitle ?? ""),
            body: "",
        };
    }

    const titleLine = normalizeCardTitleLine(lines[firstContentIndex]) || normalizeCardTitleLine(fallbackTitle ?? "");
    const bodyLines = lines.slice(firstContentIndex + 1);

    while (bodyLines.length > 0 && bodyLines[0].trim() === "")
    {
        bodyLines.shift();
    }

    return {
        titleLine,
        body: bodyLines.join("\n"),
    };
};

export const buildCardContent = (titleLine: string, body: string): string =>
{
    const title = normalizeCardTitleLine(titleLine);
    if (!body || body.trim().length === 0)
    {
        return title;
    }

    return `${title}\n\n${body}`;
};

export const removeDuplicateBodyTitle = (titleLine: string, body: string): string =>
{
    const normalizedTitle = normalizeCardTitleLine(titleLine).toLowerCase();
    if (!normalizedTitle)
    {
        return body;
    }

    const lines = body.split(/\r?\n/);
    const firstContentIndex = findFirstNonEmptyLineIndex(lines);
    if (firstContentIndex === -1)
    {
        return "";
    }

    const firstLine = normalizeCardTitleLine(lines[firstContentIndex]).toLowerCase();
    if (firstLine !== normalizedTitle)
    {
        return body;
    }

    const cleanedLines = lines.slice();
    cleanedLines.splice(firstContentIndex, 1);
    while (firstContentIndex < cleanedLines.length && cleanedLines[firstContentIndex]?.trim() === "")
    {
        cleanedLines.splice(firstContentIndex, 1);
    }

    return cleanedLines.join("\n");
};

export const normalizeCardTitleInput = (value: string): string =>
{
    return normalizeCardTitleLine(normalizeCardReferencesForUserText(value));
};

export const normalizeCardBodyInput = (value: string): string =>
{
    return normalizeCardReferencesForUserText(value);
};

export const resolveCardDocument = (title: string | undefined, content: string | undefined): { titleLine: string; body: string } =>
{
    const normalizedTitle = title !== undefined ? normalizeCardTitleInput(title) : "";
    const normalizedContent = content !== undefined ? normalizeCardBodyInput(content) : "";

    if (normalizedTitle)
    {
        return {
            titleLine: normalizedTitle,
            body: removeDuplicateBodyTitle(normalizedTitle, normalizedContent),
        };
    }

    return splitCardContent(normalizedContent);
};

export type SignedUploadInfo = {
    signedUrl: string;
    fields: Record<string, string>;
    publicUrl: string;
};

export type AttachmentSourceSnapshot = Readonly<{
    requestedPath: string;
    canonicalPath: string;
    workspacePath: string;
    size: number;
    sha256: string;
    buffer: Buffer;
}>;

export const isPathWithin = (parent: string, candidate: string): boolean =>
{
    const relation = relative(parent, candidate);
    return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
};

export async function snapshotAttachmentSource(filePath: string, workspaceRoot: string): Promise<AttachmentSourceSnapshot>
{
    const requestedPath = isAbsolute(filePath) ? resolve(filePath) : resolve(workspaceRoot, filePath);
    const workspacePath = await fs.realpath(resolve(workspaceRoot));
    let canonicalPath: string;
    try
    {
        canonicalPath = await fs.realpath(requestedPath);
    }
    catch (error)
    {
        throw new Error(`Attachment source cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }

    const lexicalInside = isPathWithin(resolve(workspaceRoot), requestedPath);
    const canonicalInside = isPathWithin(workspacePath, canonicalPath);
    if (lexicalInside && !canonicalInside)
    {
        throw new Error(`Attachment source rejected (attachment_symlink_escape): '${requestedPath}' resolves outside workspace '${workspacePath}'.`);
    }
    if (!canonicalInside)
    {
        throw new Error(`Attachment source rejected (attachment_outside_workspace): '${canonicalPath}' is outside workspace '${workspacePath}'.`);
    }

    const handle = await fs.open(canonicalPath, "r");
    try
    {
        const before = await handle.stat();
        if (!before.isFile())
        {
            throw new Error(`Attachment source must be a regular file: '${canonicalPath}'.`);
        }
        const buffer = await handle.readFile();
        const after = await handle.stat();
        const canonicalAfterRead = await fs.realpath(requestedPath);
        if (canonicalAfterRead !== canonicalPath
            || before.dev !== after.dev
            || before.ino !== after.ino
            || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs
            || buffer.byteLength !== after.size)
        {
            throw new Error("Attachment source changed while it was being inspected; no upload was attempted.");
        }
        return Object.freeze({
            requestedPath,
            canonicalPath,
            workspacePath,
            size: after.size,
            sha256: createHash("sha256").update(buffer).digest("hex"),
            buffer,
        });
    }
    finally
    {
        await handle.close();
    }
}

export function assertUnchangedAttachmentSource(before: AttachmentSourceSnapshot, after: AttachmentSourceSnapshot): void
{
    if (before.canonicalPath !== after.canonicalPath || before.size !== after.size || before.sha256 !== after.sha256)
    {
        throw new Error("Attachment source identity or content changed after inspection; no upload was attempted. Re-run with the current file.");
    }
}

export const detectContentType = (filePath: string, override?: string): string =>
{
    if (override && override.trim().length > 0)
    {
        return override.trim();
    }

    const ext = extname(filePath).toLowerCase();
    const map: Record<string, string> = {
        ".md": "text/markdown",
        ".markdown": "text/markdown",
        ".txt": "text/plain",
        ".json": "application/json",
    };

    return map[ext] ?? "application/octet-stream";
};

export const requestSignedUpload = async (source: AttachmentSourceSnapshot): Promise<SignedUploadInfo> =>
{
    const config = await getAuthenticatedConfig();
    const signal = getActiveAbortSignal();
    const fileName = basename(source.canonicalPath);
    const queueWaitMs = await enforceRateLimit();
    noteOperationRequest(queueWaitMs);

    const context = getOperationContext();
    if (context) context.requestsDispatched++;
    const response = await fetch(`${config.baseUrl}/s3/sign?objectName=${encodeURIComponent(fileName)}`, {
        method: "GET",
        headers: codecksAuthHeaders(config),
        signal,
    });

    const retryAfter = observeServerCooldown(response);
    if (response.status === 401 && config.credentialProviderId === "onepassword") evictOnePasswordCredentialGeneration(config.credentialGeneration);
    if (response.status === 429 && retryAfter.status !== "valid") throw new CodecksOperationError("rate_limited", "Codecks rejected the request with HTTP 429.", {
        httpStatus: 429, retryAfterParseStatus: retryAfter.status, retryAfterReason: retryAfter.reason,
        ...(retryAfter.requestedMs !== undefined ? { retryAfterMs: retryAfter.requestedMs, retryAfterFormat: retryAfter.format } : {}),
        recoveryHint: "Retry after the bounded fifteen-second recovery window.",
    });
    const text = await response.text();
    let payload: unknown = text;

    if (text)
    {
        try
        {
            payload = JSON.parse(text) as unknown;
        }
        catch
        {
            payload = text;
        }
    }

    if (!response.ok)
    {
        if (response.status === 429)
        {
            throw new CodecksOperationError("rate_limited", "Codecks rejected the request with HTTP 429.", {
                httpStatus: 429,
                requestsAttempted: 1,
                retryAfterParseStatus: retryAfter.status,
                ...(retryAfter.requestedMs !== undefined ? { retryAfterMs: retryAfter.requestedMs, retryAfterFormat: retryAfter.format } : {}),
                ...(retryAfter.reason ? { retryAfterReason: retryAfter.reason } : {}),
                ...(retryAfter.value !== null ? { cooldownUntil: serverCooldownUntil } : {}),
                recoveryHint: "Wait for the server rate-limit window, then retry sequentially.",
            });
        }
        throw apiFailure(response, payload, "/s3/sign", "read-only", 1, config.token);
    }

    if (!payload || typeof payload !== "object")
    {
        throw new Error("Codecks upload signing returned an invalid response.");
    }

    const data = payload as Record<string, unknown>;
    const signedUrl = data.signedUrl as string | undefined;
    const fields = data.fields as Record<string, string> | undefined;
    const publicUrl = data.publicUrl as string | undefined;

    if (!signedUrl || !fields || !publicUrl)
    {
        throw new Error("Codecks upload signing response is missing required fields.");
    }

    return { signedUrl, fields, publicUrl };
};

export const uploadFileToSignedUrl = async (
    signed: SignedUploadInfo,
    source: AttachmentSourceSnapshot,
    contentType: string,
): Promise<{ fileName: string; size: number; type: string; url: string }> =>
{
    const fileName = basename(source.canonicalPath);
    const formData = new FormData();

    for (const [key, value] of Object.entries(signed.fields))
    {
        formData.append(key, String(value));
    }

    formData.append("Content-Type", contentType);
    const blob = new Blob([source.buffer as unknown as BlobPart], { type: contentType });
    formData.append("file", blob, fileName);

    const response = await fetch(signed.signedUrl, {
        method: "POST",
        body: formData,
        signal: getActiveAbortSignal(),
    });

    if (!response.ok)
    {
        throw new CodecksOperationError("api_error", "Signed storage upload was rejected; do not replay without inspecting the exact card.", {
            httpStatus: response.status, uploadStage: "storage", mutationCertainty: "indeterminate",
        });
    }

    return {
        fileName,
        size: source.size,
        type: contentType,
        url: signed.publicUrl,
    };
};

export const statusUpdateCardFields = [
    "cardId",
    "accountSeq",
    "title",
    "content",
    "status",
    "derivedStatus",
    "isDoc",
    {
        [relationQuery("resolvables", { isClosed: false })]: ["id", "context", "isClosed"],
    },
];

export const fetchCardForStatusUpdate = async (args: { cardId?: string; accountSeq?: number }): Promise<{ card?: CodecksEntity; openContexts: Set<string> }> =>
{
    let payload: unknown;
    let lookupKey = "";
    if (args.accountSeq !== undefined)
    {
        const relationKey = relationQuery("cards", { accountSeq: [args.accountSeq] });
        lookupKey = relationKey;
        payload = await runQuery({
            _root: [
                {
                    account: [
                        {
                            [relationKey]: statusUpdateCardFields,
                        },
                    ],
                },
            ],
        });
    }
    else if (args.cardId)
    {
        const idLiteral = formatIdForQuery(args.cardId);
        lookupKey = `card(${idLiteral})`;
        payload = await runQuery({
            [lookupKey]: statusUpdateCardFields,
        });
    }
    else
    {
        return { openContexts: new Set() };
    }

    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const resolvableMap = getEntityMap(data, "resolvable");
    const card = args.accountSeq !== undefined
        ? extractCardsFromPayload(payload, "cards")[0]
        : cardMap[String(args.cardId)]
            ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
            ?? (data ? (data.card as CodecksEntity | undefined) : undefined);
    const openContexts = new Set(extractRelationEntities(card, "resolvables", resolvableMap)
        .filter((entry) => !entry.isClosed)
        .map((entry) => normalizeResolvableContextInput(entry.context))
        .filter((entry): entry is { context: "comment" | "review" | "block"; label: string } => !("error" in entry))
        .map((entry) => entry.context));
    return { card, openContexts };
};

export const fetchVisionBoardCapability = async (): Promise<boolean | undefined> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: ["visionBoardEnabled"],
            },
        ],
    });
    const account = getAccount(payload);
    return typeof account?.visionBoardEnabled === "boolean" ? account.visionBoardEnabled : undefined;
};

export const fetchVisionBoardById = async (visionBoardId: string): Promise<CodecksEntity | undefined> =>
{
    const idLiteral = formatIdForQuery(visionBoardId);
    const query = {
        [`visionBoard(${idLiteral})`]: visionBoardMetadataFields,
    };

    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const visionBoardMap = getEntityMap(data, "visionBoard");
    const lookupKey = `visionBoard(${idLiteral})`;
    return visionBoardMap[String(visionBoardId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, visionBoardMap)
        ?? (data ? (data.visionBoard as CodecksEntity | undefined) : undefined);
};

export const fetchAccountVisionBoards = async (filters?: Record<string, unknown>): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        [relationQuery("visionBoards", filters)]: visionBoardMetadataFields,
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const visionBoardMap = getEntityMap(data, "visionBoard");
    return extractRelationEntities(account, "visionBoards", visionBoardMap);
};

export const fetchAccountVisionBoardQueries = async (
    filters: Record<string, unknown> | undefined,
    includePayload: boolean,
): Promise<CodecksEntity[]> =>
{
    const payload = await runQuery({
        _root: [
            {
                account: [
                    {
                        [relationQuery("visionBoardQueries", filters)]: buildVisionBoardQueryFields(includePayload),
                    },
                ],
            },
        ],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const account = getAccount(payload);
    const queryMap = getEntityMap(data, "visionBoardQuery");
    return extractRelationEntities(account, "visionBoardQueries", queryMap);
};

export const visionBoardCardFields = ["cardId", "accountSeq", "title", "visionBoard"];

export const visionBoardMetadataFields = [
    "accountSeq",
    "createdAt",
    "isDeleted",
    { creator: ["id", "name", "fullName"] },
    { card: ["cardId", "accountSeq", "title"] },
];

export const buildVisionBoardQueryFields = (includePayload: boolean): Array<string | Record<string, unknown>> => [
    "type",
    "createdAt",
    "lastUsedAt",
    "isStale",
    { card: ["cardId", "accountSeq", "title"] },
    ...(includePayload ? ["query", "payload"] : []),
];

export const parseDateTimeInput = (value: unknown, label: string): { date: Date; iso: string } | { error: string } =>
{
    if (typeof value !== "string")
    {
        return { error: `${label} is required.` };
    }

    const trimmed = value.trim();
    if (!trimmed)
    {
        return { error: `${label} is required.` };
    }

    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime()))
    {
        return { error: `${label} must be a valid ISO datetime.` };
    }

    return {
        date: parsed,
        iso: parsed.toISOString(),
    };
};

export type MissingEffortCandidate = {
    card: CodecksEntity;
    summary: Record<string, unknown>;
    exclusionReasons: string[];
};

export const buildMissingEffortCandidates = (cards: CodecksEntity[], args: { skipCodes?: string[]; includeDone?: boolean }): MissingEffortCandidate[] =>
{
    const skipCodes = new Set((args.skipCodes ?? [])
        .map((code) => code.trim().replace(/^\$/, "").toLowerCase())
        .filter((code) => code.length > 0));

    return cards.map((card) =>
    {
        const summary = normalizeCardSearchSummary(card);
        const shortCode = String(summary.shortCode ?? "").replace(/^\$/, "").toLowerCase();
        const exclusionReasons: string[] = [];
        const status = String(card.status ?? "").trim().toLowerCase();
        const visibility = String(card.visibility ?? "default").trim().toLowerCase();

        if (skipCodes.has(shortCode))
        {
            exclusionReasons.push("skipped_by_request");
        }

        if (!hasOwn(card, "effort"))
        {
            exclusionReasons.push("effort_unknown");
        }
        else if (card.effort !== undefined && card.effort !== null && card.effort !== "")
        {
            exclusionReasons.push("effort_already_set");
        }

        if (!isCardTypeKnown(card))
        {
            exclusionReasons.push("card_type_unknown");
        }
        else if (resolveCardType(card) === "documentation" || card.isDoc)
        {
            exclusionReasons.push("documentation_card");
        }

        const childCount = getCardChildCountInfo(card);
        if (!childCount.known)
        {
            exclusionReasons.push("child_count_unknown");
        }
        else if ((childCount.count ?? 0) > 0)
        {
            exclusionReasons.push("hero_card");
        }

        if (!hasOwn(card, "status"))
        {
            exclusionReasons.push("status_unknown");
        }
        else if (!args.includeDone && status === "done")
        {
            exclusionReasons.push("done_card");
        }

        if (["archived", "deleted"].includes(visibility))
        {
            exclusionReasons.push(visibility);
        }

        return { card, summary, exclusionReasons };
    });
};

export type CardGetDetail = {
    card?: CodecksEntity;
    cardMap: Record<string, CodecksEntity>;
};

export const isSingleCardEntity = (value: unknown): value is CodecksEntity =>
{
    if (!value || typeof value !== "object" || Array.isArray(value))
    {
        return false;
    }

    const entity = value as CodecksEntity;
    return entity.cardId !== undefined
        || entity.accountSeq !== undefined
        || entity.title !== undefined
        || entity.content !== undefined
        || entity.status !== undefined
        || entity.derivedStatus !== undefined;
};

export const hasCardTarget = (value: unknown): boolean =>
{
    if (value === undefined || value === null)
    {
        return false;
    }

    return typeof value !== "string" || value.trim().length > 0;
};

export const MAX_BATCH_CARD_GET_REFS = 25;

export const fetchCardDetailsByAccountSeqs = async (accountSeqs: number[]): Promise<CardGetDetail & { cards: CodecksEntity[] }> =>
{
    const query = {
        _root: [
            {
                account: [
                    {
                        [relationQuery("cards", { accountSeq: accountSeqs })]: cardDetailFields,
                    },
                ],
            },
        ],
    };
    const payload = await runQuery(query, MAX_BATCH_CARD_RESPONSE_BYTES);
    const relation = getRelation(getAccount(payload), "cards");
    if (!Array.isArray(relation)) throw new CodecksOperationError("api_error", "Codecks batch response lacks an explicit cards collection.");
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const userMap = getEntityMap(data, "user");
    const deckMap = getEntityMap(data, "deck");
    const milestoneMap = getEntityMap(data, "milestone");
    const cards: CodecksEntity[] = extractCardsFromPayload(payload, "cards").map((rawCard) => ({
        ...hydrateCard(rawCard, { user: userMap, deck: deckMap, milestone: milestoneMap }),
        creator: resolveFromMap(rawCard.creator, userMap) ?? rawCard.creator,
    } as CodecksEntity));
    if (cards.length !== relation.length || cards.some(card => !Number.isSafeInteger(card.accountSeq))
        || new Set(cards.map(card => card.accountSeq)).size !== cards.length)
    {
        throw new CodecksOperationError("api_error", "Codecks batch response contains unresolved or ambiguous card references.");
    }
    for (const card of cards)
    {
        if (card.cardId !== undefined) cardMap[String(card.cardId)] = card;
    }
    return { cardMap, card: undefined, cards };
};

export const fetchCardDetailForGet = async (args: {
    cardId?: string | number;
    accountSeq?: number;
}): Promise<CardGetDetail> =>
{
    if (args.accountSeq !== undefined)
    {
        const query = {
            _root: [
                {
                    account: [
                        {
                            [relationQuery("cards", { accountSeq: [args.accountSeq] })]: cardDetailFields,
                        },
                    ],
                },
            ],
        };
        const payload = await runQuery(query);
        const data = unwrapData(payload) as Record<string, unknown> | undefined;
        const cardMap = getEntityMap(data, "card");
        const userMap = getEntityMap(data, "user");
        const rawCard = extractCardsFromPayload(payload, "cards")[0];
        const card = rawCard
            ? { ...rawCard, creator: resolveFromMap(rawCard.creator, userMap) ?? rawCard.creator }
            : undefined;
        return { card, cardMap };
    }

    const cardId = args.cardId !== undefined ? String(args.cardId).trim() : "";
    if (!cardId)
    {
        return { cardMap: {} };
    }

    const idLiteral = formatIdForQuery(cardId);
    const query = {
        [`card(${idLiteral})`]: cardDetailFields,
    };
    const payload = await runQuery(query);
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const cardMap = getEntityMap(data, "card");
    const userMap = getEntityMap(data, "user");
    const deckMap = getEntityMap(data, "deck");
    const milestoneMap = getEntityMap(data, "milestone");
    const lookupKey = `card(${idLiteral})`;
    const fallbackCard = data && isSingleCardEntity(data.card) ? data.card : undefined;
    const rawCard = cardMap[String(cardId)]
        ?? resolveFromMap(data ? data[lookupKey] : undefined, cardMap)
        ?? fallbackCard;
    const card = rawCard
        ? {
            ...hydrateCard(rawCard, { user: userMap, deck: deckMap, milestone: milestoneMap }),
            creator: resolveFromMap(rawCard.creator, userMap) ?? rawCard.creator,
        }
        : undefined;

    return { card, cardMap };
};

export const normalizeUserSummary = (entity: unknown): Record<string, unknown> | null =>
{
    if (!entity || typeof entity !== "object")
    {
        return null;
    }

    const value = entity as CodecksEntity;
    return {
        id: value.id ?? null,
        name: value.name ?? null,
        fullName: value.fullName ?? null,
    };
};

export const normalizeDeckSummary = (entity: unknown): Record<string, unknown> | null =>
{
    if (!entity || typeof entity !== "object")
    {
        return null;
    }

    const value = entity as CodecksEntity;
    return {
        id: value.id ?? null,
        accountSeq: value.accountSeq ?? null,
        title: value.title ?? null,
    };
};

export const normalizeRelatedCardSummary = (entity: CodecksEntity | undefined): Record<string, unknown> | null =>
{
    if (!entity)
    {
        return null;
    }

    const accountSeq = entity.accountSeq as number | undefined;
    const shortCode = formatShortCode(accountSeq);
    const cardType = resolveCardType(entity);
    return {
        cardId: entity.cardId ?? null,
        accountSeq: accountSeq ?? null,
        shortCode: shortCode || null,
        ...buildReusableCardRefs(accountSeq),
        url: shortCode ? formatCardUrl(shortCode) : null,
        title: entity.title ?? null,
        status: entity.status ?? null,
        derivedStatus: entity.derivedStatus ?? null,
        cardType,
        isDoc: cardType === "documentation",
    };
};

export const normalizeCardGetData = (
    card: CodecksEntity,
    cardMap: Record<string, CodecksEntity>,
): Record<string, unknown> =>
{
    const accountSeq = card.accountSeq as number | undefined;
    const shortCode = formatShortCode(accountSeq);
    const parentCard = resolveFromMap(card.parentCard, cardMap)
        ?? (typeof card.parentCard === "object" && card.parentCard ? card.parentCard as CodecksEntity : undefined);
    const childCards = extractRelationEntities(card, "childCards", cardMap);
    const cardType = resolveCardType(card);

    return {
        cardId: card.cardId ?? null,
        accountSeq: accountSeq ?? null,
        shortCode: shortCode || null,
        ...buildReusableCardRefs(accountSeq),
        url: shortCode ? formatCardUrl(shortCode) : null,
        title: card.title ?? null,
        content: card.content ?? "",
        contentTrust: "external",
        status: card.status ?? null,
        derivedStatus: card.derivedStatus ?? null,
        visibility: card.visibility ?? null,
        cardType,
        isDoc: cardType === "documentation",
        effort: card.effort ?? null,
        priority: card.priority ?? null,
        dueDate: card.dueDate ?? null,
        lastUpdatedAt: card.lastUpdatedAt ?? null,
        deck: normalizeDeckSummary(card.deck),
        milestone: normalizeMilestoneSummary(card.milestone),
        assignee: normalizeUserSummary(card.assignee),
        creator: normalizeUserSummary(card.creator),
        tags: formatTags(card.masterTags),
        parentCard: normalizeRelatedCardSummary(parentCard),
        childCards: childCards.map((child) => normalizeRelatedCardSummary(child)).filter((child) => child !== null),
    };
};

export const normalizeCardCandidate = (card: CodecksEntity): Record<string, unknown> =>
{
    const accountSeq = card.accountSeq as number | undefined;
    const shortCode = formatShortCode(accountSeq);
    return {
        cardId: card.cardId ?? null,
        accountSeq: accountSeq ?? null,
        shortCode: shortCode || null,
        ...buildReusableCardRefs(accountSeq),
        title: card.title ?? null,
        status: card.status ?? null,
        cardType: resolveCardType(card),
        deck: (card.deck as CodecksEntity | undefined)?.title ?? null,
        milestone: (card.milestone as CodecksEntity | undefined)?.name
            ?? (card.milestone as CodecksEntity | undefined)?.title
            ?? null,
        assignee: (card.assignee as CodecksEntity | undefined)?.name
            ?? (card.assignee as CodecksEntity | undefined)?.fullName
            ?? null,
    };
};

export type CardCreatePayloadOptions = {
    assigneeId: string | number | null;
    content: string;
    putOnHand: boolean;
    deckId: string | number | null;
    milestoneId: string | number | null;
    effort: number | null;
    priority: string | null;
    userId: string | number | undefined;
    parentCardId: string | null;
    isDoc?: boolean;
};

export const buildCardCreatePayload = (options: CardCreatePayloadOptions): Record<string, unknown> =>
{
    const payload: Record<string, unknown> = {
        assigneeId: options.assigneeId,
        content: options.content,
        putOnHand: options.putOnHand,
        deckId: options.deckId === null ? null : String(options.deckId),
        milestoneId: options.milestoneId === null ? null : String(options.milestoneId),
        masterTags: [],
        attachments: [],
        effort: options.effort,
        priority: options.priority,
        childCards: [],
        ...(options.userId !== undefined ? { userId: options.userId } : {}),
        parentCardId: options.parentCardId,
    };
    if (options.isDoc !== undefined)
    {
        payload.isDoc = options.isDoc;
    }
    return payload;
};

export type BulkCreateRecord = {
    correlationKey?: string;
    title?: string;
    content?: string;
    cardType?: string;
    deck?: string | number;
    milestone?: string | number;
    effort?: number;
    priority?: string;
    assigneeId?: string | number;
    putOnHand?: boolean;
    parentCardId?: string | number;
    tags?: string[];
};

export type BulkUpdateRecord = {
    correlationKey?: string;
    cardId?: string | number;
    title?: string;
    content?: string;
    cardType?: string;
    deck?: string | number;
    milestone?: string | number;
    assigneeId?: string | number;
    effort?: number | null;
    clearDeck?: boolean;
    clearMilestone?: boolean;
    clearAssignee?: boolean;
    clearEffort?: boolean;
    priority?: string;
    tags?: string[];
    runId?: string | number;
    clearRun?: boolean;
    parentCardId?: string | number;
    clearParent?: boolean;
    mode?: "replace" | "append" | "prepend";
};

export type NormalizedBulkCreateRecord = {
    index: number;
    correlationKey: string | null;
    title: string;
    content: string;
    cardType: CardTypeValue;
    deck: { id: string | number; name: string } | null;
    milestone: { id: string | number; name: string } | null;
    assignee: { id: string | number; name: string } | null;
    effort: number | null;
    priority: { code: string | null; label: string };
    tags: string[];
    bodyHashtags: string[];
    putOnHand: boolean;
    parent: { cardId: string; cardRef: string | null; title: string } | null;
    payload: Record<string, unknown>;
};

export type NormalizedBulkUpdateRecord = {
    index: number;
    correlationKey: string | null;
    target: { cardId: string; accountSeq: number | null; cardRef: string | null; accountSeqRef: string | null; title: string };
    updatedFields: string[];
    mode: "replace" | "append" | "prepend";
    current: Record<string, unknown>;
    proposed: Record<string, unknown>;
    payload: Record<string, unknown>;
};

export const BULK_CREATE_FIELDS = new Set(["correlationKey", "title", "content", "cardType", "deck", "milestone", "effort", "priority", "assigneeId", "putOnHand", "parentCardId", "tags"]);

export const BULK_UPDATE_CLEAR_FIELDS = { clearDeck: "deck", clearMilestone: "milestone", clearAssignee: "assigneeId", clearEffort: "effort", clearRun: "runId", clearParent: "parentCardId" } as const;

export const BULK_UPDATE_FIELDS = new Set([...Object.keys(BULK_UPDATE_CLEAR_FIELDS), "correlationKey", "cardId", "title", "content", "cardType", "deck", "milestone", "assigneeId", "effort", "priority", "tags", "runId", "clearRun", "parentCardId", "clearParent", "mode"]);

export const BULK_UPDATE_VALUE_FIELDS = ["title", "content", "cardType", "deck", "milestone", "assigneeId", "effort", "priority", "tags", "runId", "clearRun", "parentCardId", "clearParent"];

export const validateStrictBulkRecords = (records: unknown[], kind: "create" | "update"): string[] =>
{
    const errors: string[] = [];
    const allowed = kind === "create" ? BULK_CREATE_FIELDS : BULK_UPDATE_FIELDS;
    const path = kind === "create" ? "cards" : "updates";
    records.forEach((value, index) =>
    {
        if (!value || typeof value !== "object" || Array.isArray(value))
        {
            errors.push(`${path}[${index}] must be an object.`);
            return;
        }
        const record = value as Record<string, unknown>;
        for (const field of Object.keys(record))
        {
            if (!allowed.has(field))
            {
                errors.push(field === "assignee"
                    ? `${path}[${index}].assignee is unsupported; use assigneeId from codecks_user_lookup.`
                    : `${path}[${index}].${field} is unsupported.`);
            }
        }
        if (record.correlationKey !== undefined && (typeof record.correlationKey !== "string" || record.correlationKey.length === 0 || record.correlationKey.length > 200))
        {
            errors.push(`${path}[${index}].correlationKey must be a non-empty string of at most 200 characters.`);
        }
        errors.push(...validateMutationText([
            [`${path}[${index}].title`, record.title],
            [`${path}[${index}].content`, record.content],
            ...((Array.isArray(record.tags) ? record.tags : []).map((tag, tagIndex) => [`${path}[${index}].tags[${tagIndex}]`, tag] as [string, unknown])),
        ]));
        if (kind === "create" && !buildCardContent(resolveCardDocument(record.title as string | undefined, record.content as string | undefined).titleLine, resolveCardDocument(record.title as string | undefined, record.content as string | undefined).body).trim())
        {
            errors.push(`cards[${index}] requires title and/or content.`);
        }
        if (kind === "update")
        {
            if (record.cardId === undefined || String(record.cardId).trim() === "") errors.push(`updates[${index}].cardId is required.`);
            if (record.clearDeck === true) errors.push(`updates[${index}].clearDeck is unavailable: Codecks returned HTTP 500 for deck removal via cards/update with deckId:null. The supported removal contract is unverified; use the Codecks UI. No updates were sent.`);
            if (!BULK_UPDATE_VALUE_FIELDS.some((field) => !Object.hasOwn(BULK_UPDATE_CLEAR_FIELDS, field) && record[field] !== undefined) && !Object.keys(BULK_UPDATE_CLEAR_FIELDS).some((field) => record[field] === true)) errors.push(`updates[${index}] is a no-op; provide at least one supported update field.`);
            for (const [clearField, valueField] of Object.entries(BULK_UPDATE_CLEAR_FIELDS))
            {
                if (record[clearField] !== undefined && typeof record[clearField] !== "boolean") errors.push(`updates[${index}].${clearField} must be a boolean.`);
                if (record[clearField] === true && record[valueField] !== undefined) errors.push(`updates[${index}] cannot combine ${clearField}=true with ${valueField}.`);
            }
        }
    });
    return errors;
};

export const resolveBulkAssignee = async (value: string | number | undefined): Promise<{ id: string | number; name: string }> =>
{
    const id = await resolveAssigneeId(value);
    const users = await fetchUsersByIds([String(id)]);
    const user = users[normalizeUserId(String(id))];
    return { id, name: String(user?.fullName ?? user?.name ?? id) };
};

export type BulkCreateNormalizationContext = {
    decks: Map<string, Promise<LookupResult>>;
    milestones: Map<string, Promise<LookupResult>>;
    assignees: Map<string, Promise<{ id: string | number; name: string }>>;
    parents: Map<string, Promise<Awaited<ReturnType<typeof resolveCardForUpdate>>>>;
};

export const cachedResolution = <T>(cache: Map<string, Promise<T>>, value: string | number, resolve: () => Promise<T>): Promise<T> =>
{
    const key = String(value);
    let pending = cache.get(key);
    if (!pending) { pending = resolve(); cache.set(key, pending); }
    return pending;
};

export const normalizeBulkCreateRecord = async (record: BulkCreateRecord, defaults: BulkCreateRecord, index: number, loggedInUser: CodecksUser, context: BulkCreateNormalizationContext): Promise<NormalizedBulkCreateRecord> =>
{
    const document = resolveCardDocument(record.title, record.content);
    const tags = normalizeCreateTags(record.tags);
    const bodyHashtags = buildBodyHashtagTokens(tags);
    const content = appendBodyHashtagsToCardContent(buildCardContent(document.titleLine, document.body), bodyHashtags);
    const cardType = record.cardType === undefined ? { value: "regular" as CardTypeValue, isDoc: false } : normalizeCardTypeInput(record.cardType);
    if (!cardType) throw new Error(`cards[${index}].cardType must be regular or documentation.`);

    let deck: NormalizedBulkCreateRecord["deck"] = null;
    const deckValue = blankToUndefined(record.deck ?? defaults.deck);
    if (deckValue !== undefined)
    {
        const result = await cachedResolution(context.decks, deckValue, () => resolveDeck(deckValue));
        if (result.kind !== "resolved") throw new Error(`cards[${index}].deck: ${renderLookupMessage(result, String(deckValue))}`);
        deck = { id: String(result.id), name: result.label };
    }

    let milestone: NormalizedBulkCreateRecord["milestone"] = null;
    const milestoneValue = blankToUndefined(record.milestone ?? defaults.milestone);
    if (milestoneValue !== undefined)
    {
        const result = await cachedResolution(context.milestones, milestoneValue, () => resolveMilestone(milestoneValue));
        if (result.kind !== "resolved") throw new Error(`cards[${index}].milestone: ${renderLookupMessage(result, String(milestoneValue))}`);
        milestone = { id: String(result.id), name: result.label };
    }

    const explicitAssignee = blankToUndefined(record.assigneeId);
    const isOrg = getBaseConfig().profileKey === "ORG";
    const defaultAssigneeId = isOrg ? undefined : loggedInUser.id ?? getFallbackAssigneeId();
    if (explicitAssignee === undefined && defaultAssigneeId === undefined && !isOrg)
        throw new Error(`cards[${index}] could not resolve a default assignee; provide assigneeId from codecks_user_lookup.`);
    const assignee: NormalizedBulkCreateRecord["assignee"] = explicitAssignee !== undefined
        ? await cachedResolution(context.assignees, explicitAssignee, () => resolveBulkAssignee(explicitAssignee))
        : defaultAssigneeId !== undefined
            ? { id: defaultAssigneeId, name: String(loggedInUser.fullName ?? loggedInUser.name ?? defaultAssigneeId) }
            : null;
    const priority = record.priority === undefined ? { code: null, label: "None" } : normalizePriorityInput(record.priority);
    if (!priority) throw new Error(`cards[${index}].priority must be none, low, medium, high, a, b, or c.`);

    let parent: NormalizedBulkCreateRecord["parent"] = null;
    const parentValue = blankToUndefined(record.parentCardId ?? defaults.parentCardId);
    if (parentValue !== undefined)
    {
        const result = await cachedResolution(context.parents, parentValue, () => resolveCardForUpdate(parentValue));
        if (!result) throw new Error(`cards[${index}].parentCardId was not found.`);
        parent = { cardId: result.cardId, cardRef: result.shortCode || null, title: result.title || "(untitled)" };
    }

    const putOnHand = record.putOnHand ?? false;
    if (!deck && !assignee) throw new Error(`cards[${index}] cannot be both unassigned and deckless; provide deck or assigneeId.`);
    if (isOrg && putOnHand) throw new CodecksOperationError("org_actor_unverified", `cards[${index}] cannot infer an ORG hand target from putOnHand; no mutation was sent.`);
    return {
        index,
        correlationKey: record.correlationKey ?? null,
        title: document.titleLine || "(untitled)",
        content,
        cardType: cardType.value,
        deck,
        milestone,
        assignee,
        effort: record.effort ?? null,
        priority,
        tags,
        bodyHashtags,
        putOnHand,
        parent,
        payload: buildCardCreatePayload({
            assigneeId: assignee?.id ?? null,
            content,
            putOnHand,
            deckId: deck?.id ?? null,
            milestoneId: milestone?.id ?? null,
            effort: record.effort ?? null,
            priority: priority.code,
            userId: loggedInUser.id,
            parentCardId: parent?.cardId ?? null,
            isDoc: record.cardType === undefined ? undefined : cardType.isDoc,
        }),
    };
};

export const relationEntityId = (value: unknown): string | null =>
{
    if (value && typeof value === "object") return String((value as CodecksEntity).id ?? (value as CodecksEntity).cardId ?? "") || null;
    return value === undefined || value === null ? null : String(value);
};

export const normalizedMutationFingerprint = (value: Record<string, unknown>): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const stableFingerprintValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableFingerprintValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, stableFingerprintValue((value as Record<string, unknown>)[key])]));
    return value;
};

export const bulkPreviewFingerprint = async (operation: "card_bulk_create" | "card_bulk_update", records: Array<{ payload: Record<string, unknown> }>): Promise<string> =>
{
    const config = await getAuthenticatedConfig();
    // HMAC binds previews to the actual resolved credential without exposing a
    // token hash, cache key, reference, or credential in the result.
    return createHmac("sha256", config.token).update(JSON.stringify(stableFingerprintValue({
        version: 2, profile: config.profileKey, account: config.account, operation,
        records: records.map(({ payload }) => {
            const { sessionId: _sessionId, ...canonicalPayload } = payload;
            return canonicalPayload;
        }),
    }))).digest("hex");
};

export const actionKeyFor = (operation: "create" | "update", index: number, payload: Record<string, unknown>): string =>
{
    const { sessionId: _sessionId, ...stablePayload } = payload;
    return `${operation}:${index}:${normalizedMutationFingerprint(stablePayload).slice(0, 24)}`;
};

export type DispatchCardIdentity = {
    cardId: string | null;
    accountSeq: number | null;
    title: string | null;
};

export const parseCardAccountSeq = (value: unknown): number | null =>
{
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value))
    {
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
};

// Dispatch responses vary between { card }, { payload: { card } }, and { payload }.
// Nested card/payload records are authoritative; a generic outer `id` may be
// an action ID and is therefore never interpreted as a card identity.

export const extractDispatchCardIdentity = (response: unknown): DispatchCardIdentity =>
{
    const data = unwrapData(response);
    const candidates: Array<{ value: Record<string, unknown>; allowGenericId: boolean }> = [];
    if (isRecord(data))
    {
        if (isRecord(data.card)) candidates.push({ value: data.card, allowGenericId: true });
        if (isRecord(data.payload))
        {
            if (isRecord(data.payload.card)) candidates.push({ value: data.payload.card, allowGenericId: true });
            candidates.push({ value: data.payload, allowGenericId: true });
        }
        candidates.push({ value: data, allowGenericId: false });
    }

    for (const { value: candidate, allowGenericId } of candidates)
    {
        const rawCardId = candidate.cardId ?? (allowGenericId ? candidate.id : undefined);
        const cardId = rawCardId === undefined || rawCardId === null || String(rawCardId).trim() === ""
            ? null
            : String(rawCardId);
        const accountSeq = parseCardAccountSeq(candidate.accountSeq);
        if (cardId || accountSeq !== null)
        {
            return {
                cardId,
                accountSeq,
                title: typeof candidate.title === "string" ? candidate.title : null,
            };
        }
    }
    return { cardId: null, accountSeq: null, title: null };
};

export const publicCardIdentity = (identity: Pick<DispatchCardIdentity, "cardId" | "accountSeq">) =>
{
    const accountSeq = identity.accountSeq ?? undefined;
    return {
        cardId: identity.cardId,
        accountSeq: identity.accountSeq,
        shortCode: formatShortCode(accountSeq) || null,
        ...buildReusableCardRefs(accountSeq),
    };
};

export const publicBulkCreateRecord = (record: NormalizedBulkCreateRecord) => ({
    index: record.index,
    correlationKey: record.correlationKey,
    normalizedRequested: {
        title: record.title, content: record.content, cardType: record.cardType, deck: record.deck,
        milestone: record.milestone, assignee: record.assignee, effort: record.effort, priority: record.priority,
        tags: record.tags, putOnHand: record.putOnHand, parent: record.parent,
    },
});

export const preflightOutcomeRecords = (records: unknown[], operationOrErrors: "create" | "update" | Array<{ index?: number; message: string }> = "create", maybeErrors: Array<{ index?: number; message: string }> = []) => {
    const errors = Array.isArray(operationOrErrors) ? operationOrErrors : maybeErrors;
    const operation = Array.isArray(operationOrErrors) ? "create" : operationOrErrors;
    const byIndex = new Map<number, string[]>();
    for (const error of errors) { const index = error.index ?? Number(error.message.match(/\[(\d+)\]/)?.[1]); if (Number.isInteger(index)) byIndex.set(index, [...(byIndex.get(index) ?? []), error.message]); }
    return records.map((record, index) => ({ index, correlationKey: isRecord(record) && typeof record.correlationKey === "string" ? record.correlationKey : null, status: byIndex.has(index) ? "failed" : "definitely_unsent", certainty: byIndex.has(index) ? "definitely_rejected" : "definitely_unsent", ...(byIndex.has(index) ? { error: { category: "validation_error", message: byIndex.get(index)!.join(" ") } } : {}) , operation }));
};

export const markDefinitelyUnsent = (results: Record<string, unknown>[], afterIndex: number) => { for (const entry of results) if (Number(entry.index) > afterIndex && entry.status === "ready") { entry.status = "definitely_unsent"; entry.certainty = "definitely_unsent"; } };

export const isOperationalError = (error: unknown): boolean => error instanceof CodecksOperationError;

export const classifyMutationOutcome = (error: unknown): "failed" | "indeterminate" =>
    error instanceof CodecksOperationError && ["request_timeout", "caller_aborted"].includes(error.category) || /\b(?:5\d\d|timeout|network|socket|connection|fetch failed)\b/i.test(toErrorMessage(error)) ? "indeterminate" : "failed";

export const markBulkCreateDefinitelyUnsent = (results: Record<string, unknown>[], afterIndex: number) => {
    for (const entry of results) if (Number(entry.index) > afterIndex && entry.status === "ready") {
        entry.status = "definitely_unsent"; entry.certainty = "definitely_unsent";
        entry.recovery = "No dispatch attempt was made; this record is safe to submit later.";
    }
};

export const writeBulkArtifact = async (operation: "create" | "update", details: Record<string, unknown>) => {
    try
    {
        const directory = await fs.mkdtemp(join(tmpdir(), `pi-codecks-bulk-${operation}-`));
        const path = join(directory, "result.json");
        await fs.writeFile(path, `${JSON.stringify(details, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        return { path, format: "json", temporary: true };
    }
    catch (error)
    {
        return { unavailable: true, reason: "The sanitized detailed-result artifact could not be written." };
    }
};

export const fetchBulkUpdateCard = async (value: string | number): Promise<CodecksEntity | undefined> =>
{
    const parsed = parseCardIdentifier(value);
    return parsed.accountSeq !== undefined
        ? fetchCardByAccountSeq(parsed.accountSeq, [...cardDetailFields, "sprintId"])
        : parsed.cardId ? fetchCardById(parsed.cardId, [...cardDetailFields, "sprintId"]) : undefined;
};

export type BulkUpdateNormalizationContext = {
    cards: Map<string, Promise<CodecksEntity | undefined>>;
    runs: Map<string, Promise<RunLookupResult | null>>;
};

export const normalizeBulkUpdateRecord = async (record: BulkUpdateRecord, index: number, context: BulkUpdateNormalizationContext): Promise<NormalizedBulkUpdateRecord> =>
{
    const cardKey = String(record.cardId);
    const cardPromise = context.cards.get(cardKey) ?? fetchBulkUpdateCard(record.cardId!);
    context.cards.set(cardKey, cardPromise);
    const card = await cardPromise;
    if (!card?.cardId) throw new Error(`updates[${index}].cardId was not found.`);
    const accountSeq = typeof card.accountSeq === "number" ? card.accountSeq : undefined;
    const mode = record.mode ?? "replace";
    const payload: Record<string, unknown> = { sessionId: generateSessionId(), id: card.cardId };
    const current: Record<string, unknown> = {
        title: card.title ?? null,
        content: card.content ?? "",
        cardType: resolveCardType(card),
        deck: (card.deck as CodecksEntity | undefined)?.title ?? null,
        deckId: relationEntityId(card.deck),
        milestone: (card.milestone as CodecksEntity | undefined)?.name ?? (card.milestone as CodecksEntity | undefined)?.title ?? null,
        milestoneId: relationEntityId(card.milestone),
        assignee: (card.assignee as CodecksEntity | undefined)?.fullName ?? (card.assignee as CodecksEntity | undefined)?.name ?? null,
        assigneeId: relationEntityId(card.assignee),
        effort: card.effort ?? null,
        priority: formatPriorityLabel(card.priority),
        tags: formatTags(card.masterTags),
        runId: card.sprintId ?? null,
        parentCardId: relationEntityId(card.parentCard),
    };
    const proposed: Record<string, unknown> = {};

    const parts = splitCardContent(String(card.content ?? ""), String(card.title ?? ""));
    const title = record.title !== undefined ? normalizeCardTitleInput(record.title) : parts.titleLine;
    let body = parts.body;
    if (record.content !== undefined)
    {
        const incoming = removeDuplicateBodyTitle(title, normalizeCardBodyInput(record.content));
        body = mode === "append" ? [body, incoming].filter(Boolean).join("\n\n")
            : mode === "prepend" ? [incoming, body].filter(Boolean).join("\n\n") : incoming;
    }
    if (record.title !== undefined || record.content !== undefined)
    {
        payload.title = title;
        payload.content = appendBodyHashtagsToCardContent(buildCardContent(title, removeDuplicateBodyTitle(title, body)), []);
        proposed.title = title;
        proposed.content = payload.content;
    }
    if (record.cardType !== undefined)
    {
        const value = normalizeCardTypeInput(record.cardType);
        if (!value) throw new Error(`updates[${index}].cardType must be regular or documentation.`);
        payload.isDoc = value.isDoc;
        proposed.cardType = value.value;
    }
    if (record.deck !== undefined)
    {
        const value = await resolveDeck(record.deck);
        if (value.kind !== "resolved") throw new Error(`updates[${index}].deck: ${renderLookupMessage(value, String(record.deck))}`);
        payload.deckId = value.id;
        proposed.deck = { id: value.id, name: value.label };
    }
    if (record.clearMilestone === true)
    {
        payload.milestoneId = null;
        proposed.milestone = null;
    }
    else if (record.milestone !== undefined)
    {
        const value = await resolveMilestone(record.milestone);
        if (value.kind !== "resolved") throw new Error(`updates[${index}].milestone: ${renderLookupMessage(value, String(record.milestone))}`);
        payload.milestoneId = value.id;
        proposed.milestone = { id: value.id, name: value.label };
    }
    if (record.clearAssignee === true)
    {
        if (!payload.deckId && !current.deckId)
            throw new Error(`updates[${index}] cannot clear the assignee of a deckless card; unassigned and deckless is not allowed.`);
        payload.assigneeId = null;
        proposed.assignee = null;
    }
    else if (record.assigneeId !== undefined)
    {
        const value = await resolveBulkAssignee(record.assigneeId);
        payload.assigneeId = value.id;
        proposed.assignee = value;
    }
    if (record.clearEffort === true)
    {
        payload.effort = null;
        proposed.effort = null;
    }
    else if (record.effort !== undefined)
    {
        payload.effort = record.effort;
        proposed.effort = record.effort;
    }
    if (record.priority !== undefined)
    {
        const value = normalizePriorityInput(record.priority);
        if (!value) throw new Error(`updates[${index}].priority must be none, low, medium, high, a, b, or c.`);
        payload.priority = value.code;
        proposed.priority = value;
    }
    if (record.tags !== undefined)
    {
        const value = normalizeCreateTags(record.tags);
        payload.masterTags = value;
        proposed.tags = value;
    }
    if (record.clearRun === true)
    {
        payload.sprintId = null;
        proposed.run = null;
    }
    else if (record.runId !== undefined)
    {
        const runKey = String(record.runId);
        const runPromise = context.runs.get(runKey) ?? resolveRunForUpdate(record.runId);
        context.runs.set(runKey, runPromise);
        const value = await runPromise;
        if (!value) throw new Error(`updates[${index}].runId was not found.`);
        payload.sprintId = value.runId;
        proposed.run = { id: value.runId, accountSeq: value.accountSeq ?? null, name: value.label };
    }
    if (record.clearParent === true)
    {
        payload.parentCardId = null;
        proposed.parent = null;
    }
    else if (record.parentCardId !== undefined)
    {
        const value = await resolveCardForUpdate(record.parentCardId);
        if (!value) throw new Error(`updates[${index}].parentCardId was not found.`);
        if (value.cardId === String(card.cardId)) throw new Error(`updates[${index}] cannot set a card as its own parent.`);
        payload.parentCardId = value.cardId;
        proposed.parent = { cardId: value.cardId, cardRef: value.shortCode || null, title: value.title || "(untitled)" };
    }

    return {
        index,
        correlationKey: record.correlationKey ?? null,
        target: {
            cardId: String(card.cardId),
            accountSeq: accountSeq ?? null,
            cardRef: formatShortCode(accountSeq) || null,
            accountSeqRef: accountSeq !== undefined ? `seq:${accountSeq}` : null,
            title: String(card.title ?? "(untitled)"),
        },
        updatedFields: Object.keys(payload).filter((field) => !["sessionId", "id"].includes(field)),
        mode,
        current,
        proposed,
        payload,
    };
};

export const NAMED_HAND_READ_LIMIT = 500;

export type NamedHandEntry = { cardId: string; sortIndex: number };

export const fetchCompleteNamedHand = async (userId: string | number): Promise<NamedHandEntry[]> =>
{
    const payload = await runQuery({
        _root: [{ account: [{
            [relationQuery("queueEntries", { userId, cardDoneAt: null, $order: "sortIndex", $limit: NAMED_HAND_READ_LIMIT })]: [
                "cardId", "sortIndex", { user: ["id"] },
            ],
        }] }],
    });
    const data = unwrapData(payload) as Record<string, unknown> | undefined;
    const entries = Object.values(getEntityMap(data, "queueEntry"))
        .sort((left, right) => Number(left.sortIndex ?? NaN) - Number(right.sortIndex ?? NaN));
    const users = getEntityMap(data, "user");
    if (entries.length >= NAMED_HAND_READ_LIMIT)
        throw new CodecksOperationError("api_error", "The target hand page is incomplete; no hand write was sent.");
    const seen = new Set<string>();
    let previousSort = -Infinity;
    return entries.map((entry) =>
    {
        const rawCardId = entry.cardId ?? entry.card_id;
        const cardId = typeof rawCardId === "string" ? rawCardId : "";
        const sortIndex = entry.sortIndex;
        const user = resolveFromMap(entry.user, users)
            ?? (isRecord(entry.user) ? entry.user : undefined);
        if (!cardId || seen.has(cardId) || typeof sortIndex !== "number" || !Number.isFinite(sortIndex)
            || sortIndex <= previousSort || String(user?.id ?? "") !== String(userId))
            throw new CodecksOperationError("api_error", "Target hand ordering or ownership cannot be verified; no hand write was sent.");
        seen.add(cardId);
        previousSort = sortIndex;
        return { cardId, sortIndex };
    });
};

export const equalNamedHand = (left: NamedHandEntry[], right: NamedHandEntry[]): boolean =>
    left.length === right.length && left.every((entry, i) => entry.cardId === right[i]?.cardId && entry.sortIndex === right[i]?.sortIndex);

export const mutateNamedHand = async (
    action: "card-add-to-hand" | "card-remove-from-hand",
    args: { cardId: string | number; userId?: string | number; format?: "text" | "json" },
): Promise<string> =>
{
    const format = args.format ?? "json";
    const adding = action === "card-add-to-hand";
    let card: Awaited<ReturnType<typeof resolveCardForUpdate>>;
    let targetId: string | number;
    let actor: { id: string | number; verifiedOrg: boolean };
    let baseline: NamedHandEntry[];
    try
    {
        if (getBaseConfig().profileKey === "ORG" && args.userId === undefined)
            return toStructuredErrorResult(format, action, "validation_error", "ORG has no own hand; provide an explicit human userId. No mutation was sent.");
        targetId = args.userId === undefined ? (await fetchLoggedInUser()).id! : await resolveExplicitHumanHandTarget(args.userId);
        card = await resolveCardForUpdate(args.cardId);
        if (!card) return toStructuredErrorResult(format, action, "not_found", "Card not found; no hand write was sent.");
        actor = await fetchSharedActor();
        baseline = await fetchCompleteNamedHand(targetId);
        const matches = baseline.filter((entry) => entry.cardId === card!.cardId).length;
        if (adding && matches !== 0) return toStructuredErrorResult(format, action, "validation_error", "The card is already on the target hand; no write was sent.");
        if (!adding && matches !== 1) return toStructuredErrorResult(format, action, "validation_error", "The card is not uniquely on the target hand; no write was sent.");
        // There is no atomic conditional dispatch. Refuse a baseline that drifted even once.
        const immediate = await fetchCompleteNamedHand(targetId);
        if (!equalNamedHand(baseline, immediate))
            return toStructuredErrorResult(format, action, "validation_error", "The target hand changed between reads; no write was sent. Refresh before retrying.");
    }
    catch (error)
    {
        return toStructuredErrorResult(format, action, error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
    }

    try
    {
        await runDispatch(adding ? "handQueue/setCardOrders" : "handQueue/removeCards", {
            sessionId: generateSessionId(),
            cardIds: adding ? [...baseline.map((entry) => entry.cardId), card!.cardId] : [card!.cardId],
            ...(adding ? { draggedCardIds: [card!.cardId] } : {}),
            userId: targetId,
        }, actor.verifiedOrg ? String(actor.id) : undefined, String(targetId));
    }
    catch (error)
    {
        return toStructuredErrorResult(format, action, error instanceof CodecksOperationError ? error.category : classifyApiErrorCategory(toErrorMessage(error)), toErrorMessage(error), getOperationErrorData(error));
    }
    try
    {
        const after = await fetchCompleteNamedHand(targetId);
        const expected = adding ? [...baseline.map((entry) => entry.cardId), card!.cardId] : baseline.filter((entry) => entry.cardId !== card!.cardId).map((entry) => entry.cardId);
        if (after.length !== expected.length || after.some((entry, i) => entry.cardId !== expected[i]))
            throw new CodecksOperationError("api_error", "Hand write response did not match exact target readback; stop and reconcile before any new write.", { mutationCertainty: "indeterminate", requestsAttempted: 1 });
        return toStructuredResult(format, action,
            `${adding ? "Added" : "Removed"} ${card!.shortCode || "card"} ${adding ? "to" : "from"} the verified human hand; exact membership and existing relative order confirmed.`,
            { cardCode: card!.shortCode || null, handAction: adding ? "add" : "remove", readbackConfirmed: true, previousEntryCount: baseline.length, resultingEntryCount: after.length });
    }
    catch (error)
    {
        return toStructuredErrorResult(format, action, "api_error", "Hand write response requires exact target reconciliation; do not retry automatically.", { mutationCertainty: "indeterminate", requestsAttempted: 1 });
    }
};
