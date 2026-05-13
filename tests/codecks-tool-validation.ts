const TEST_PREFIX = "[tool-test]";
const DEFAULT_API_BASE = "https://api.codecks.io";
const TEST_PROFILE = (process.env.CODECKS_TEST_PROFILE ?? process.env.CODECKS_PROFILE ?? "").trim();
const REQUEST_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.CODECKS_TEST_REQUEST_TIMEOUT_MS ?? "10000", 10);
  if (!Number.isFinite(raw)) {
    return 30000;
  }
  return Math.max(5000, Math.min(120000, raw));
})();
const RETRY_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const TEST_RETRY_ATTEMPTS = (() => {
  const raw = Number.parseInt(process.env.CODECKS_TEST_RETRY_ATTEMPTS ?? "1", 10);
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(0, Math.min(5, raw));
})();
const TEST_RETRY_BASE_DELAY_MS = (() => {
  const raw = Number.parseInt(process.env.CODECKS_TEST_RETRY_BASE_DELAY_MS ?? "350", 10);
  if (!Number.isFinite(raw)) {
    return 350;
  }
  return Math.max(100, Math.min(5000, raw));
})();
const TEST_RETRY_JITTER_MS = 125;
const REQUEST_RATE_LIMIT = (() => {
  const raw = Number.parseInt(process.env.CODECKS_TEST_RATE_LIMIT ?? "16", 10);
  if (!Number.isFinite(raw)) {
    return 32;
  }
  return Math.max(5, Math.min(60, raw));
})();
const REQUEST_RATE_WINDOW_MS = (() => {
  const raw = Number.parseInt(process.env.CODECKS_TEST_RATE_WINDOW_MS ?? "5000", 10);
  if (!Number.isFinite(raw)) {
    return 5000;
  }
  return Math.max(1000, Math.min(15000, raw));
})();
const TEST_OPERATION_TIMEOUT_MS = (() => {
  const raw = Number.parseInt(process.env.CODECKS_TEST_OPERATION_TIMEOUT_MS ?? "30000", 10);
  if (!Number.isFinite(raw)) {
    return 120000;
  }
  return Math.max(10000, Math.min(300000, raw));
})();

const resolveRuntimeConfig = (): { apiBase: string; token: string; account: string; profile?: string } => {
  const profile = TEST_PROFILE || undefined;
  const profileAccount = profile ? (getProfileEnv(profile, "ACCOUNT") ?? getProfileEnv(profile, "SUBDOMAIN")) : undefined;
  const profileApiBase = profile ? getProfileEnv(profile, "API_BASE") : undefined;
  const profileTokenRef = profile ? (getProfileEnv(profile, "TOKEN_OP_REF") ?? getProfileEnv(profile, "TOKEN_REF")) : undefined;
  const profileTokenDirect = profile ? (getProfileEnv(profile, "TOKEN") ?? getProfileEnv(profile, "API_TOKEN")) : undefined;

  const account = (profileAccount ?? process.env.CODECKS_ACCOUNT ?? "").trim();
  const apiBase = (profileApiBase ?? process.env.CODECKS_API_BASE ?? DEFAULT_API_BASE).trim();
  if (profileTokenRef) {
    throw new Error("Codecks integration tests no longer execute 1Password helpers directly. Resolve the secret through pi-onepassword or another explicit secret integration, then set CODECKS_TOKEN or CODECKS_PROFILE_<PROFILE>_TOKEN.");
  }

  const token = (profileTokenDirect ?? process.env.CODECKS_TOKEN ?? process.env.CODECKS_API_TOKEN ?? "").trim();

  return { apiBase, token, account, profile };
};

let API_BASE = process.env.CODECKS_API_BASE ?? DEFAULT_API_BASE;
let TOKEN = process.env.CODECKS_TOKEN ?? process.env.CODECKS_API_TOKEN ?? "";
let ACCOUNT = process.env.CODECKS_ACCOUNT ?? process.env.CODECKS_SUBDOMAIN ?? "";
const profileDeckOverride = TEST_PROFILE
  ? (process.env[`CODECKS_TEST_PROFILE_${toProfileSegment(TEST_PROFILE)}_DECK`]
    ?? getProfileEnv(TEST_PROFILE, "TEST_DECK"))
  : undefined;
const CREATE_DECK_ENV = process.env.CODECKS_TEST_DECK ?? profileDeckOverride ?? "";
const ATTACHMENT_PATH_ENV = process.env.CODECKS_TEST_ATTACHMENT_PATH ?? "";
const VISION_BOARD_CARD_ENV = (process.env.CODECKS_TEST_VISION_BOARD_CARD ?? "").trim();

if (!process.env.CODECKS_REQUEST_TIMEOUT_MS) {
  process.env.CODECKS_REQUEST_TIMEOUT_MS = String(REQUEST_TIMEOUT_MS);
}
if (!process.env.CODECKS_RETRY_ATTEMPTS) {
  process.env.CODECKS_RETRY_ATTEMPTS = "0";
}
if (!process.env.CODECKS_RATE_LIMIT) {
  process.env.CODECKS_RATE_LIMIT = String(REQUEST_RATE_LIMIT);
}
if (!process.env.CODECKS_RATE_WINDOW_MS) {
  process.env.CODECKS_RATE_WINDOW_MS = String(REQUEST_RATE_WINDOW_MS);
}

type AnyRecord = Record<string, unknown>;

type CardRef = {
  cardId?: string;
  accountSeq?: number;
  title?: string;
  content?: string;
  status?: string;
  derivedStatus?: string;
  isDoc?: boolean;
  visibility?: string;
};

const pass = (msg: string): void => console.log(`PASS: ${msg}`);
const fail = (msg: string): void => console.log(`FAIL: ${msg}`);
const skip = (msg: string): void => console.log(`SKIP: ${msg}`);
const info = (msg: string): void => console.log(`INFO: ${msg}`);

const isObject = (value: unknown): value is AnyRecord => typeof value === "object" && value !== null;

const unwrapData = (payload: unknown): unknown => {
  if (isObject(payload) && "data" in payload) {
    return payload.data;
  }
  return payload;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const requestTimestamps: number[] = [];

const enforceRateLimit = async (): Promise<void> => {
  while (true) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && now - requestTimestamps[0] > REQUEST_RATE_WINDOW_MS) {
      requestTimestamps.shift();
    }

    if (requestTimestamps.length < REQUEST_RATE_LIMIT) {
      requestTimestamps.push(now);
      return;
    }

    const waitMs = Math.max(0, REQUEST_RATE_WINDOW_MS - (now - requestTimestamps[0]) + 10);
    await wait(waitMs);
  }
};

const withTimeout = async <T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      return undefined;
    }
    return Math.max(0, seconds * 1000);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return Math.max(0, parsed - Date.now());
};

const parseRetryDelayFromPayloadMs = (payload: unknown): number | undefined => {
  if (!isObject(payload)) {
    return undefined;
  }

  const candidates: string[] = [];
  if (typeof payload.message === "string") {
    candidates.push(payload.message);
  }
  if (typeof payload.error === "string") {
    candidates.push(payload.error);
  }

  for (const candidate of candidates) {
    const match = candidate.match(/retry\s+in\s+(\d+)\s+seconds?/i);
    if (match) {
      const seconds = Number(match[1]);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }
  }

  return undefined;
};

const sessionId = (): string => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tool-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const cardCodeLetters = "123456789acefghijkoqrsuvwxyz";
const cardCodeLength = cardCodeLetters.length;
const cardCodeStart = cardCodeLength * (cardCodeLength + 1) - 1;

const accountSeqToCardCode = (value: number): string => {
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  let seq = "";
  let q = value + cardCodeStart + 1;
  do {
    q -= 1;
    const remainder = q % cardCodeLength;
    q = Math.floor(q / cardCodeLength);
    seq = `${cardCodeLetters[remainder]}${seq}`;
  } while (q !== 0);
  return seq;
};

const deepWalk = (value: unknown, visit: (node: unknown) => void): void => {
  visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepWalk(entry, visit);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const child of Object.values(value)) {
    deepWalk(child, visit);
  }
};

const extractCardCandidates = (payload: unknown): CardRef[] => {
  const results: CardRef[] = [];
  const seen = new Set<string>();

  deepWalk(unwrapData(payload), (node) => {
    if (!isObject(node)) {
      return;
    }

    const hasCardShape = "cardId" in node || "accountSeq" in node || "title" in node;
    if (!hasCardShape) {
      return;
    }

    const rawCardId = node.cardId;
    const rawSeq = node.accountSeq;
    const rawTitle = node.title;
    const key = `${String(rawCardId ?? "")}|${String(rawSeq ?? "")}|${String(rawTitle ?? "")}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    const candidate: CardRef = {};
    if (typeof rawCardId === "string" && rawCardId.length > 0) {
      candidate.cardId = rawCardId;
    }
    if (typeof rawSeq === "number") {
      candidate.accountSeq = rawSeq;
    }
    if (typeof rawTitle === "string") {
      candidate.title = rawTitle;
    }
    if (typeof node.content === "string") {
      candidate.content = node.content;
    }
    if (typeof node.status === "string") {
      candidate.status = node.status;
    }
    if (typeof node.derivedStatus === "string") {
      candidate.derivedStatus = node.derivedStatus;
    }
    if (typeof node.isDoc === "boolean") {
      candidate.isDoc = node.isDoc;
    }
    if (typeof node.visibility === "string") {
      candidate.visibility = node.visibility;
    }

    if (candidate.cardId || candidate.accountSeq !== undefined || candidate.title) {
      results.push(candidate);
    }
  });

  return results;
};

const parseResponse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const requestJson = async (path: string, body: unknown): Promise<unknown> => {
  for (let attempt = 0; ; attempt += 1) {
    await enforceRateLimit();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await withTimeout(fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Account": ACCOUNT,
          "X-Auth-Token": TOKEN,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      }), REQUEST_TIMEOUT_MS + 2000, `HTTP request ${path}`);
    } catch (error) {
      clearTimeout(timeoutHandle);
      const message = (error as Error).message.toLowerCase();
      const timedOut = message.includes("abort") || message.includes("timeout");
      if (timedOut && attempt < TEST_RETRY_ATTEMPTS) {
        await wait(TEST_RETRY_BASE_DELAY_MS + Math.floor(Math.random() * TEST_RETRY_JITTER_MS));
        continue;
      }
      if (timedOut) {
        throw new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms for '${path}'`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }

    const payload = await withTimeout(
      parseResponse(response),
      REQUEST_TIMEOUT_MS + 2000,
      `parse response ${path}`,
    );
    if (response.ok) {
      return payload;
    }

    const shouldRetry = RETRY_STATUS_CODES.has(response.status) && attempt < TEST_RETRY_ATTEMPTS;
    if (shouldRetry) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      const retryPayloadMs = parseRetryDelayFromPayloadMs(payload);
      const backoffMs = TEST_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt));
      const waitMs = retryAfterMs
        ?? retryPayloadMs
        ?? (backoffMs + Math.floor(Math.random() * TEST_RETRY_JITTER_MS));
      await wait(waitMs);
      continue;
    }

    throw new Error(`HTTP ${response.status} ${response.statusText}: ${JSON.stringify(payload)}`);
  }
};

const runQuery = async (query: AnyRecord): Promise<unknown> => requestJson("/", { query });
const runDispatch = async (dispatchPath: string, payload: AnyRecord): Promise<unknown> =>
  requestJson(`/dispatch/${dispatchPath}`, payload);

const invokeTool = async (name: string, args: AnyRecord): Promise<string> => {
  const module = await import("../src/codecks-core.ts");
  const candidate = (module as AnyRecord)[name];
  const execute = isObject(candidate) ? candidate.execute : undefined;
  if (typeof execute !== "function") {
    throw new Error(`tool '${name}' is not available`);
  }

  const startedAt = Date.now();
  try {
    const result = await withTimeout(Promise.resolve(execute(args)), TEST_OPERATION_TIMEOUT_MS, `tool ${name}`);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs > 5000) {
      info(`slow tool '${name}' completed in ${elapsedMs}ms`);
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    throw new Error(`${(error as Error).message} (elapsed ${elapsedMs}ms; tool=${name})`);
  }
};

const structuredOk = (result: string): boolean => result.includes('"ok": true');
const structuredErrorCategory = (result: string): string | undefined => {
  const match = result.match(/"category"\s*:\s*"([^"]+)"/);
  return match?.[1];
};

const structuredData = (result: string): AnyRecord | undefined => {
  const match = result.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) {
    return undefined;
  }
  try {
    const payload = JSON.parse(match[1]) as AnyRecord;
    const data = payload.data;
    return isObject(data) ? data : undefined;
  } catch {
    return undefined;
  }
};

const normalizedCardTypeFromResult = (result: string): string | undefined => {
  const data = structuredData(result);
  if (!isObject(data)) {
    return undefined;
  }

  if (typeof data.cardType === "string") {
    return data.cardType.toLowerCase();
  }

  const card = data.card;
  if (isObject(card) && typeof card.cardType === "string") {
    return card.cardType.toLowerCase();
  }

  return undefined;
};

const structuredWarnings = (result: string): string[] => {
  const match = result.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match) {
    return [];
  }
  try {
    const payload = JSON.parse(match[1]) as AnyRecord;
    const warnings = payload.warnings;
    if (!Array.isArray(warnings)) {
      return [];
    }
    return warnings.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
};

const getEntityMap = (data: unknown, key: string): AnyRecord => {
  if (!isObject(data)) {
    return {};
  }
  const candidate = data[key];
  return isObject(candidate) ? candidate : {};
};

const getRelationRefs = (node: unknown, relationName: string): unknown[] => {
  if (!isObject(node)) {
    return [];
  }
  const direct = node[relationName];
  if (Array.isArray(direct)) {
    return direct;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith(`${relationName}(`) && Array.isArray(value)) {
      return value;
    }
  }
  return [];
};

const hydrateRelationEntities = (node: unknown, relationName: string, map: AnyRecord): AnyRecord[] => {
  const refs = getRelationRefs(node, relationName);
  return refs
    .map((entry) => {
      if (isObject(entry)) {
        return entry;
      }
      const id = String(entry ?? "");
      const fromMap = map[id];
      return isObject(fromMap) ? fromMap : undefined;
    })
    .filter((entry): entry is AnyRecord => isObject(entry));
};

const fetchOpenResolvablesForCard = async (cardId: string, context?: string): Promise<AnyRecord[]> => {
  const filters: AnyRecord = {
    isClosed: false,
    $order: "-createdAt",
  };
  if (context) {
    filters.context = context;
  }

  const relation = `resolvables(${JSON.stringify(filters)})`;
  const payload = await runQuery({
    [`card(${cardId})`]: [
      "cardId",
      {
        [relation]: [
          "id",
          "context",
          "isClosed",
          "createdAt",
          {
            entries: ["entryId", "content", "version", "createdAt", "lastChangedAt"],
          },
        ],
      },
    ],
  });

  const data = unwrapData(payload);
  const cardMap = getEntityMap(data, "card");
  const resolvableMap = getEntityMap(data, "resolvable");
  const entryMap = getEntityMap(data, "resolvableEntry");
  const cardNode = isObject(cardMap[cardId])
    ? cardMap[cardId] as AnyRecord
    : (isObject((data as AnyRecord)?.[`card(${cardId})`]) ? (data as AnyRecord)[`card(${cardId})`] as AnyRecord : undefined);

  const resolvables = hydrateRelationEntities(cardNode, "resolvables", resolvableMap);
  return resolvables.map((resolvable) => ({
    ...resolvable,
    entries: hydrateRelationEntities(resolvable, "entries", entryMap),
  }));
};

const getLoggedInUserId = async (): Promise<string | number | undefined> => {
  const payload = await runQuery({
    _root: [
      {
        loggedInUser: ["id"],
      },
    ],
  });

  const data = unwrapData(payload);
  if (!isObject(data)) {
    return undefined;
  }

  const root = Array.isArray(data._root) ? data._root[0] : data._root;
  if (isObject(root)) {
    const ref = root.loggedInUser;
    if (isObject(ref) && (typeof ref.id === "string" || typeof ref.id === "number")) {
      return ref.id;
    }
    if ((typeof ref === "string" || typeof ref === "number") && isObject(data.user)) {
      const userMap = data.user as AnyRecord;
      const entry = userMap[String(ref)];
      if (isObject(entry) && (typeof entry.id === "string" || typeof entry.id === "number")) {
        return entry.id;
      }
    }
  }

  let found: string | number | undefined;
  deepWalk(data, (node) => {
    if (found !== undefined || !isObject(node)) {
      return;
    }
    if (typeof node.id === "string" || typeof node.id === "number") {
      found = node.id;
    }
  });
  return found;
};

const resolveDeckId = async (value: string): Promise<string | number | undefined> => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(trimmed)) {
    return trimmed;
  }

  const payload = await runQuery({
    _root: [
      {
        account: [
          {
            decks: ["id", "title", "accountSeq"],
          },
        ],
      },
    ],
  });

  const matches: Array<{ id?: string | number; title: string }> = [];
  deepWalk(unwrapData(payload), (node) => {
    if (!isObject(node)) {
      return;
    }
    const title = typeof node.title === "string" ? node.title : "";
    if (!title) {
      return;
    }
    matches.push({ id: node.id as string | number | undefined, title });
  });

  const exactCaseSensitive = matches.filter((deck) => deck.id !== undefined && deck.title === trimmed);
  if (exactCaseSensitive.length === 1) {
    return exactCaseSensitive[0].id;
  }
  if (exactCaseSensitive.length > 1) {
    return undefined;
  }

  const exactCaseInsensitive = matches.filter((deck) =>
    deck.id !== undefined && deck.title.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exactCaseInsensitive.length === 1) {
    return exactCaseInsensitive[0].id;
  }
  if (exactCaseInsensitive.length > 1) {
    return undefined;
  }

  const partialCaseInsensitive = matches.filter((deck) =>
    deck.id !== undefined && deck.title.toLowerCase().includes(trimmed.toLowerCase()),
  );
  if (partialCaseInsensitive.length === 1) {
    return partialCaseInsensitive[0].id;
  }

  return undefined;
};

const queryCardByTitle = async (title: string): Promise<CardRef | undefined> => {
  const relation = `cards(${JSON.stringify({
    title: { op: "contains", value: title },
    $limit: 10,
    $order: "-lastUpdatedAt",
  })})`;

  const payload = await runQuery({
    _root: [
      {
        account: [
          {
            [relation]: [
              "cardId",
              "accountSeq",
              "title",
              "content",
              "status",
              "derivedStatus",
              "isDoc",
            ],
          },
        ],
      },
    ],
  });

  const cards = extractCardCandidates(payload)
    .filter((card) => typeof card.title === "string" && card.title.includes(title));

  const exact = cards.find((card) => card.title === title);
  return exact ?? cards[0];
};

const queryCardById = async (cardId: string): Promise<CardRef | undefined> => {
  const payload = await runQuery({
    [`card(${cardId})`]: ["cardId", "accountSeq", "title", "content", "status", "derivedStatus", "isDoc"],
  });

  const cards = extractCardCandidates(payload)
    .filter((card) => card.cardId === cardId);
  return cards[0];
};

const normalizeTitleLikeLine = (line: string): string => line.replace(/^\s*#+\s*/, "").trim();

const inspectCanonicalCardContent = (content: string, title: string): { firstLine: string; firstLineRaw: string; titleMatches: number } => {
  const lines = content.split(/\r?\n/);
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  const firstLineRaw = firstContentIndex >= 0 ? lines[firstContentIndex] : "";
  const firstLine = normalizeTitleLikeLine(firstLineRaw);
  const normalizedLines = lines
    .map(normalizeTitleLikeLine)
    .filter((line) => line.length > 0);
  const titleMatches = normalizedLines.filter((line) => line === title).length;

  return {
    firstLine,
    firstLineRaw,
    titleMatches,
  };
};

const markerContent = (title: string, tag: string): string => {
  const lines = [
    title,
    "",
    `validation-marker: ${tag}`,
    `timestamp: ${new Date().toISOString()}`,
    "temporary validation payload",
  ];
  return lines.join("\n");
};

const run = async (): Promise<number> => {
  try {
    const resolved = resolveRuntimeConfig();
    API_BASE = resolved.apiBase;
    TOKEN = resolved.token;
    ACCOUNT = resolved.account;

    if (resolved.profile) {
      process.env.CODECKS_PROFILE = resolved.profile;
      info(`using profile '${resolved.profile}'`);
    }
  } catch (error) {
    fail(`profile/config resolution failed: ${(error as Error).message}`);
    return 1;
  }

  if (!TOKEN || !ACCOUNT) {
    skip("Codecks credentials missing; set CODECKS_TOKEN/CODECKS_ACCOUNT or CODECKS_TEST_PROFILE profile variables.");
    return 0;
  }

  pass("credentials present");

  let preflightFailures = 0;

  if (VISION_BOARD_CARD_ENV) {
    try {
      const boardResult = await invokeTool("card_get_vision_board", {
        cardId: VISION_BOARD_CARD_ENV,
        format: "json",
      });
      if (!structuredOk(boardResult)) {
        preflightFailures += 1;
        fail(`card_get_vision_board reference lookup failed: ${boardResult}`);
      } else {
        const boardData = structuredData(boardResult);
        const visionBoard = isObject(boardData?.visionBoard) ? boardData?.visionBoard as AnyRecord : undefined;
        const capabilities = isObject(boardData?.capabilities) ? boardData?.capabilities as AnyRecord : undefined;
        if (boardData?.status === "available" && typeof boardData?.resolvedCardId === "string" && typeof visionBoard?.id === "string") {
          if (capabilities?.visionBoardEnabled === undefined || capabilities?.visionBoardEnabled === true) {
            pass("card_get_vision_board resolves a live reference card with a vision board");
          } else {
            preflightFailures += 1;
            fail(`card_get_vision_board capability mismatch: ${boardResult}`);
          }
        } else {
          preflightFailures += 1;
          fail(`card_get_vision_board reference output mismatch: ${boardResult}`);
        }
      }

      const payloadResult = await invokeTool("card_get_vision_board", {
        cardId: VISION_BOARD_CARD_ENV,
        includePayload: true,
        format: "json",
      });
      if (!structuredOk(payloadResult)) {
        preflightFailures += 1;
        fail(`card_get_vision_board payload lookup failed: ${payloadResult}`);
      } else {
        const payloadData = structuredData(payloadResult);
        const queryCount = typeof payloadData?.queryCount === "number" ? payloadData.queryCount : -1;
        const warnings = structuredWarnings(payloadResult);
        const payloadFlagPresent = payloadResult.includes('"payloadIncluded"') && payloadResult.includes('"payloadTruncated"');
        const unsupportedWarning = warnings.some((entry) => entry.toLowerCase().includes("structured vision board query/payload retrieval"));
        if (payloadFlagPresent && (queryCount > 0 || unsupportedWarning)) {
          pass("card_get_vision_board payload mode reports either live query data or a clear unsupported warning");
        } else {
          preflightFailures += 1;
          fail(`card_get_vision_board payload-mode mismatch: ${payloadResult}`);
        }
      }
    } catch (error) {
      preflightFailures += 1;
      fail(`card_get_vision_board live reference checks failed: ${(error as Error).message}`);
    }
  } else {
    skip("vision board reference checks skipped (set CODECKS_TEST_VISION_BOARD_CARD to enable)");
  }

  if (!CREATE_DECK_ENV.trim()) {
    skip("CODECKS_TEST_DECK missing; skipping create-dependent validations.");
    return preflightFailures > 0 ? 1 : 0;
  }

  const runStartedAtIso = new Date().toISOString();
  const runTag = `tool-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const title = `${TEST_PREFIX} Bun Codecks validation ${runTag}`;
  const initialContent = markerContent(title, `${runTag}-create`);

  let cardId: string | undefined;
  let accountSeq: number | undefined;
  let hardFailures = 0;

  const userId = await getLoggedInUserId();
  if (userId === undefined) {
    fail("unable to resolve loggedInUser id for create payload");
    return 1;
  }

  const deckId = await resolveDeckId(CREATE_DECK_ENV);
  if (deckId === undefined) {
    fail(`unable to resolve create deck from CODECKS_TEST_DECK='${CREATE_DECK_ENV}'`);
    return 1;
  }

  info(`using deck '${CREATE_DECK_ENV}' -> id '${String(deckId)}'`);

  try {
    const createResponse = await runDispatch("cards/create", {
      assigneeId: userId,
      content: initialContent,
      putOnHand: false,
      deckId,
      milestoneId: null,
      masterTags: [],
      attachments: [],
      effort: null,
      priority: null,
      childCards: [],
      userId,
    });

    const created = extractCardCandidates(createResponse).find((card) =>
      card.title?.includes(runTag) || card.content?.includes(runTag),
    );

    if (created?.cardId) {
      cardId = created.cardId;
    }
    if (typeof created?.accountSeq === "number") {
      accountSeq = created.accountSeq;
    }
    pass("temporary card create request completed");
  } catch (error) {
    fail(`create failed: ${(error as Error).message}`);
    return 1;
  }

  const queried = await queryCardByTitle(title);
  if (!cardId && queried?.cardId) {
    cardId = queried.cardId;
  }
  if (accountSeq === undefined && typeof queried?.accountSeq === "number") {
    accountSeq = queried.accountSeq;
  }

  if (cardId || accountSeq !== undefined) {
    pass("card identity resolved via create payload or title query");
  } else {
    fail("could not resolve created card id/accountSeq");
    return 1;
  }

  const cardCode = accountSeq !== undefined ? accountSeqToCardCode(accountSeq) : "";
  const toolCardRef = cardCode ? `$${cardCode}` : (cardId ?? "");
  const verifyCanonicalContent = async (expectedTitle: string, label: string): Promise<void> => {
    const after = cardId ? await queryCardById(cardId) : await queryCardByTitle(expectedTitle);
    const content = after?.content ?? "";
    const inspection = inspectCanonicalCardContent(content, expectedTitle);

    if (inspection.titleMatches !== 1) {
      hardFailures += 1;
      fail(`${label} expected exactly one title-like first line; found ${inspection.titleMatches}`);
    } else {
      pass(`${label} kept a single title-like first line`);
    }

    if (inspection.firstLine !== expectedTitle) {
      hardFailures += 1;
      fail(`${label} did not store the title as the first content line: ${JSON.stringify(content)}`);
    } else {
      pass(`${label} stored the title on the first content line`);
    }

    if (/^\s*#/.test(inspection.firstLineRaw)) {
      hardFailures += 1;
      fail(`${label} stored a markdown heading prefix in the persisted title line: ${JSON.stringify(inspection.firstLineRaw)}`);
    } else {
      pass(`${label} stored the persisted title line without a markdown heading prefix`);
    }
  };

  if (cardCode) {
    info(`short code: $${cardCode}`);
    info(`url: https://${ACCOUNT}.codecks.io/card/${cardCode}`);
  } else {
    skip("short code unavailable (accountSeq missing)");
  }

  try {
    if (!cardId) {
      throw new Error("missing cardId for content update");
    }
    const updatedContent = markerContent(title, `${runTag}-updated`);
    await runDispatch("cards/update", {
      sessionId: sessionId(),
      id: cardId,
      title,
      content: updatedContent,
    });

    await wait(400);
    await verifyCanonicalContent(title, "content update");
  } catch (error) {
    hardFailures += 1;
    fail(`content update verification failed: ${(error as Error).message}`);
  }

  if (!cardId) {
    skip("tool-level validation checks skipped (cardId unavailable)");
  } else {
    try {
      const duplicatePlainTitleUpdate = await invokeTool("card_update", {
        cardId: toolCardRef,
        content: markerContent(title, `${runTag}-duplicate-plain-title`),
        mode: "replace",
        format: "json",
      });
      if (!structuredOk(duplicatePlainTitleUpdate)) {
        hardFailures += 1;
        fail(`duplicate plain title replace failed: ${duplicatePlainTitleUpdate}`);
      } else {
        await wait(400);
        await verifyCanonicalContent(title, "duplicate plain title replace");
      }
    } catch (error) {
      hardFailures += 1;
      fail(`duplicate plain title replace check failed: ${(error as Error).message}`);
    }

    try {
      const duplicateHeadingTitleUpdate = await invokeTool("card_update", {
        cardId: toolCardRef,
        content: [`# ${title}`, "", `validation-marker: ${runTag}-duplicate-heading-title`, "compatibility payload"].join("\n"),
        mode: "replace",
        format: "json",
      });
      if (!structuredOk(duplicateHeadingTitleUpdate)) {
        hardFailures += 1;
        fail(`duplicate heading title replace failed: ${duplicateHeadingTitleUpdate}`);
      } else {
        await wait(400);
        await verifyCanonicalContent(title, "duplicate heading title replace");
      }
    } catch (error) {
      hardFailures += 1;
      fail(`duplicate heading title replace check failed: ${(error as Error).message}`);
    }

    try {
      const appendDuplicateHeading = await invokeTool("card_update", {
        cardId: toolCardRef,
        content: [`# ${title}`, "", `validation-marker: ${runTag}-append-duplicate-heading`].join("\n"),
        mode: "append",
        format: "json",
      });
      if (!structuredOk(appendDuplicateHeading)) {
        hardFailures += 1;
        fail(`append duplicate heading failed: ${appendDuplicateHeading}`);
      } else {
        await wait(400);
        await verifyCanonicalContent(title, "append duplicate heading");
      }
    } catch (error) {
      hardFailures += 1;
      fail(`append duplicate heading check failed: ${(error as Error).message}`);
    }

    try {
      const prependDuplicatePlain = await invokeTool("card_update", {
        cardId: toolCardRef,
        content: [title, "", `validation-marker: ${runTag}-prepend-duplicate-plain`].join("\n"),
        mode: "prepend",
        format: "json",
      });
      if (!structuredOk(prependDuplicatePlain)) {
        hardFailures += 1;
        fail(`prepend duplicate plain title failed: ${prependDuplicatePlain}`);
      } else {
        await wait(400);
        await verifyCanonicalContent(title, "prepend duplicate plain title");
      }
    } catch (error) {
      hardFailures += 1;
      fail(`prepend duplicate plain title check failed: ${(error as Error).message}`);
    }

    try {
      const invalidStatus = await invokeTool("card_update_status", {
        cardId: toolCardRef,
        status: "ship_it",
        format: "json",
      });
      if (structuredErrorCategory(invalidStatus) === "validation_error") {
        pass("invalid status rejected with validation_error");
      } else {
        hardFailures += 1;
        fail(`invalid status check did not return validation_error: ${invalidStatus}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`invalid status validation failed: ${(error as Error).message}`);
    }

    try {
      const validStatus = await invokeTool("card_update_status", {
        cardId: toolCardRef,
        status: "in_progress",
        format: "json",
      });
      if (structuredOk(validStatus)) {
        pass("status alias normalized and applied");
      } else {
        hardFailures += 1;
        fail(`status alias update did not succeed: ${validStatus}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`status alias update failed: ${(error as Error).message}`);
    }

    try {
      const heroParentTitle = `${TEST_PREFIX} hero parent ${runTag}`;
      const heroParentCreate = await invokeTool("card_create", {
        title: heroParentTitle,
        content: `hero parent validation marker ${runTag}`,
        deck: CREATE_DECK_ENV,
        format: "json",
      });

      if (!structuredOk(heroParentCreate)) {
        hardFailures += 1;
        fail(`hero parent create failed: ${heroParentCreate}`);
      } else {
        const heroParentData = structuredData(heroParentCreate);
        const heroParentId = typeof heroParentData?.cardId === "string" ? heroParentData.cardId : "";

        if (!heroParentId) {
          hardFailures += 1;
          fail(`hero parent create missing cardId: ${heroParentCreate}`);
        } else {
          const heroChildCreate = await invokeTool("card_create", {
            title: `${TEST_PREFIX} hero child ${runTag}`,
            content: `hero child validation marker ${runTag}`,
            parentCardId: heroParentId,
            format: "json",
          });

          if (!structuredOk(heroChildCreate)) {
            hardFailures += 1;
            fail(`hero child create failed: ${heroChildCreate}`);
          } else {
            const heroChildData = structuredData(heroChildCreate);
            const heroChildId = typeof heroChildData?.cardId === "string" ? heroChildData.cardId : "";
            const heroStartBlocked = await invokeTool("card_update_status", {
              cardId: heroParentId,
              status: "started",
              format: "json",
            });

            if (structuredErrorCategory(heroStartBlocked) === "validation_error"
              && heroStartBlocked.includes("Hero cards cannot be started directly")) {
              pass("hero cards reject direct started status updates with guidance");
            } else {
              hardFailures += 1;
              fail(`hero started restriction check failed: ${heroStartBlocked}`);
            }

            try {
              if (heroChildId) {
                await runDispatch("cards/update", {
                  sessionId: sessionId(),
                  id: heroChildId,
                  status: "done",
                });
              }

              await runDispatch("cards/update", {
                sessionId: sessionId(),
                id: heroParentId,
                status: "done",
              });
              pass("hero-card restriction test cleanup set temp cards status=done");
            } catch (cleanupError) {
              skip(`hero-card restriction cleanup skipped: ${(cleanupError as Error).message}`);
            }
          }
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`hero started restriction validation failed: ${(error as Error).message}`);
    }

    try {
      const invalidPriority = await invokeTool("card_update_priority", {
        cardId: toolCardRef,
        priority: "urgent",
        format: "json",
      });
      if (structuredErrorCategory(invalidPriority) === "validation_error") {
        pass("invalid priority rejected with validation_error");
      } else {
        hardFailures += 1;
        fail(`invalid priority check did not return validation_error: ${invalidPriority}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`invalid priority validation failed: ${(error as Error).message}`);
    }

    try {
      const validPriority = await invokeTool("card_update_priority", {
        cardId: toolCardRef,
        priority: "high",
        format: "json",
      });
      if (structuredOk(validPriority)) {
        pass("priority normalization and update succeeded");
      } else {
        hardFailures += 1;
        fail(`priority update did not succeed: ${validPriority}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`priority update failed: ${(error as Error).message}`);
    }

    try {
      const invalidAssignee = await invokeTool("card_update", {
        cardId: toolCardRef,
        assigneeId: "not-a-real-user-id",
        format: "json",
      });
      if (structuredErrorCategory(invalidAssignee) === "validation_error") {
        pass("invalid explicit assignee rejected");
      } else {
        hardFailures += 1;
        fail(`invalid assignee check did not return validation_error: ${invalidAssignee}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`invalid assignee validation failed: ${(error as Error).message}`);
    }

    try {
      const invalidCreateCardType = await invokeTool("card_create", {
        title: `${TEST_PREFIX} invalid card type ${runTag}`,
        content: "validation payload",
        deck: CREATE_DECK_ENV,
        cardType: "knowledge_base",
        format: "json",
      });
      if (structuredErrorCategory(invalidCreateCardType) === "validation_error") {
        pass("invalid card type rejected during card create");
      } else {
        hardFailures += 1;
        fail(`invalid create cardType check did not return validation_error: ${invalidCreateCardType}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`invalid create cardType validation failed: ${(error as Error).message}`);
    }

    try {
      const docCreateTitle = `${TEST_PREFIX} doc create ${runTag}`;
      const createDocumentation = await invokeTool("card_create", {
        title: docCreateTitle,
        content: [`# ${docCreateTitle}`, "", `documentation validation marker ${runTag}`].join("\n"),
        deck: CREATE_DECK_ENV,
        cardType: "documentation",
        format: "json",
      });

      if (!structuredOk(createDocumentation)) {
        hardFailures += 1;
        fail(`documentation card create failed: ${createDocumentation}`);
      } else {
        const createType = normalizedCardTypeFromResult(createDocumentation);
        const createData = structuredData(createDocumentation);
        const createdCardId = typeof createData?.cardId === "string" ? createData.cardId : "";

        if (createType === "documentation") {
          pass("card_create returns documentation cardType when requested");
        } else {
          hardFailures += 1;
          fail(`card_create reported unexpected cardType: ${createDocumentation}`);
        }

        if (!createdCardId) {
          hardFailures += 1;
          fail(`documentation card create missing cardId: ${createDocumentation}`);
        } else {
          const backendCard = await queryCardById(createdCardId);
          if (backendCard?.isDoc === true) {
            pass("card_create persisted documentation type in backend (isDoc=true)");
          } else {
            hardFailures += 1;
            fail(`documentation card create backend isDoc mismatch: ${JSON.stringify(backendCard)}`);
          }

          const backendContent = backendCard?.content ?? "";
          const contentInspection = inspectCanonicalCardContent(backendContent, docCreateTitle);
          if (contentInspection.titleMatches !== 1) {
            hardFailures += 1;
            fail(`card_create should dedupe title-like lines in stored content; found ${contentInspection.titleMatches}`);
          } else {
            pass("card_create dedupes title-like lines in stored content");
          }

          if (contentInspection.firstLine !== docCreateTitle) {
            hardFailures += 1;
            fail(`card_create did not store the title on the first content line: ${JSON.stringify(backendContent)}`);
          } else {
            pass("card_create stores the title on the first content line");
          }

          if (/^\s*#/.test(contentInspection.firstLineRaw)) {
            hardFailures += 1;
            fail(`card_create stored a markdown heading prefix in the persisted title line: ${JSON.stringify(contentInspection.firstLineRaw)}`);
          } else {
            pass("card_create stores the persisted title line without a markdown heading prefix");
          }

          const formattedDoc = await invokeTool("card_get_formatted", {
            cardId: createdCardId,
            format: "json",
          });
          if (normalizedCardTypeFromResult(formattedDoc) === "documentation") {
            pass("card_get_formatted reports documentation cardType for doc cards");
          } else {
            hardFailures += 1;
            fail(`card_get_formatted doc cardType mismatch: ${formattedDoc}`);
          }

          const docStatusBlocked = await invokeTool("card_update_status", {
            cardId: createdCardId,
            status: "done",
            format: "json",
          });
          if (structuredErrorCategory(docStatusBlocked) === "validation_error"
            && docStatusBlocked.includes("Documentation cards do not support status changes")) {
            pass("documentation cards reject status updates with guidance");
          } else {
            hardFailures += 1;
            fail(`documentation status restriction check failed: ${docStatusBlocked}`);
          }

          try {
            const regularizeDoc = await invokeTool("card_update", {
              cardId: createdCardId,
              cardType: "regular",
              format: "json",
            });
            if (!structuredOk(regularizeDoc)) {
              throw new Error(`card_update regularize doc cleanup failed: ${regularizeDoc}`);
            }

            await runDispatch("cards/update", {
              sessionId: sessionId(),
              id: createdCardId,
              status: "done",
            });
            pass("documentation create test cleanup converted temp doc card to regular and set status=done");
          } catch (cleanupError) {
            skip(`documentation create cleanup skipped: ${(cleanupError as Error).message}`);
          }
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`documentation create verification failed: ${(error as Error).message}`);
    }

    try {
      const invalidCardTypeUpdate = await invokeTool("card_update", {
        cardId: toolCardRef,
        cardType: "knowledge_base",
        format: "json",
      });
      if (structuredErrorCategory(invalidCardTypeUpdate) === "validation_error") {
        pass("invalid card type rejected during card update");
      } else {
        hardFailures += 1;
        fail(`invalid update cardType check did not return validation_error: ${invalidCardTypeUpdate}`);
      }

      if (!cardId) {
        skip("card type conversion checks skipped (cardId unavailable)");
      } else {
        const setDocumentation = await invokeTool("card_update", {
          cardId: toolCardRef,
          cardType: "documentation",
          format: "json",
        });

        const setDocType = normalizedCardTypeFromResult(setDocumentation);
        const backendDocState = await queryCardById(cardId);
        if (structuredOk(setDocumentation) && setDocType === "documentation" && backendDocState?.isDoc === true) {
          pass("card_update converts regular cards to documentation type");
        } else {
          hardFailures += 1;
          fail(`card type conversion to documentation failed: update=${setDocumentation} backend=${JSON.stringify(backendDocState)}`);
        }

        const setRegular = await invokeTool("card_update", {
          cardId: toolCardRef,
          cardType: "regular",
          format: "json",
        });

        const setRegularType = normalizedCardTypeFromResult(setRegular);
        const backendRegularState = await queryCardById(cardId);
        if (structuredOk(setRegular) && setRegularType === "regular" && backendRegularState?.isDoc === false) {
          pass("card_update converts documentation cards back to regular type");
        } else {
          hardFailures += 1;
          fail(`card type conversion back to regular failed: update=${setRegular} backend=${JSON.stringify(backendRegularState)}`);
          try {
            await runDispatch("cards/update", {
              sessionId: sessionId(),
              id: cardId,
              isDoc: false,
            });
            pass("card type fallback cleanup reset temporary card to regular");
          } catch (fallbackError) {
            hardFailures += 1;
            fail(`card type fallback cleanup failed: ${(fallbackError as Error).message}`);
          }
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card type update validation failed: ${(error as Error).message}`);
    }

    try {
      const searchResult = await invokeTool("card_search", {
        title: "plain text that is not a card code",
        format: "json",
      });
      if (!searchResult.toLowerCase().includes("invalid card code format")) {
        pass("card search title no longer mis-parses as bare card code");
      } else {
        hardFailures += 1;
        fail(`card search title inference still too aggressive: ${searchResult}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card search inference check failed: ${(error as Error).message}`);
    }

    try {
      const broadSearch = await invokeTool("card_search", {
        title: "",
        limit: 10,
        format: "json",
      });
      if (structuredOk(broadSearch)) {
        pass("card_search broad listing works against the live Codecks API");
      } else {
        hardFailures += 1;
        fail(`card_search broad listing failed against live API: ${broadSearch}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card_search broad live-API check failed: ${(error as Error).message}`);
    }

    try {
      const deckSearch = await invokeTool("card_search", {
        deck: CREATE_DECK_ENV,
        limit: 10,
        format: "json",
      });
      const deckData = structuredData(deckSearch);
      const deckCards = Array.isArray(deckData?.cards) ? deckData.cards : [];
      const foundCreated = deckCards.some((card) => isObject(card) && String(card.cardId ?? "") === cardId);
      if (structuredOk(deckSearch) && foundCreated) {
        pass("card_search deck-scoped listing finds the created validation card against the live API");
      } else {
        hardFailures += 1;
        fail(`card_search deck-scoped live-API check failed: ${deckSearch}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card_search deck-scoped live-API check failed: ${(error as Error).message}`);
    }

    try {
      const missingEffortPreview = await invokeTool("card_list_missing_effort", {
        deck: CREATE_DECK_ENV,
        limit: 20,
        format: "json",
      });
      const previewData = structuredData(missingEffortPreview);
      const eligibleCards = Array.isArray(previewData?.eligibleCards) ? previewData.eligibleCards : [];
      const foundCreated = eligibleCards.some((card) => isObject(card) && String(card.cardId ?? "") === cardId);
      if (structuredOk(missingEffortPreview) && foundCreated) {
        pass("card_list_missing_effort deck preview finds the created validation card against the live API");
      } else {
        hardFailures += 1;
        fail(`card_list_missing_effort deck live-API check failed: ${missingEffortPreview}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card_list_missing_effort deck live-API check failed: ${(error as Error).message}`);
    }

    try {
      if (!cardCode) {
        skip("short-code lookup validation skipped (created card has no account sequence)");
      } else {
        const explicitShortCodeResult = await invokeTool("card_get_formatted", {
          cardId: `$${cardCode}`,
          format: "json",
        });
        const bareShortCodeResult = await invokeTool("card_get_formatted", {
          cardId: cardCode,
          format: "json",
        });

        if (!structuredOk(explicitShortCodeResult) || !structuredOk(bareShortCodeResult)) {
          hardFailures += 1;
          fail(`dynamic short-code lookup failed: explicit=${explicitShortCodeResult} bare=${bareShortCodeResult}`);
        } else {
          const explicitData = structuredData(explicitShortCodeResult);
          const explicitCard = isObject(explicitData?.card) ? explicitData.card as AnyRecord : undefined;
          const explicitCardId = typeof explicitCard?.cardId === "string" ? explicitCard.cardId : "";
          const bareData = structuredData(bareShortCodeResult);
          const bareCard = isObject(bareData?.card) ? bareData.card as AnyRecord : undefined;
          const bareCardId = typeof bareCard?.cardId === "string" ? bareCard.cardId : "";

          if (explicitCardId && bareCardId === explicitCardId) {
            pass("bare and explicit short-code refs resolve to the created validation card");
          } else {
            hardFailures += 1;
            fail(`dynamic short-code lookup mismatch: explicit=${explicitShortCodeResult} bare=${bareShortCodeResult}`);
          }
        }

        if (/^\d+$/.test(cardCode)) {
          const numericResult = await invokeTool("card_get_formatted", {
            cardId: cardCode,
            format: "json",
          });
          if (structuredOk(numericResult)) {
            pass("numeric bare short-code refs resolve when the created validation card has an all-digit code");
          } else {
            hardFailures += 1;
            fail(`numeric short-code lookup failed for dynamic code ${cardCode}: ${numericResult}`);
          }
        } else {
          skip(`numeric bare short-code validation skipped (dynamic card code ${cardCode} is not all digits)`);
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`dynamic short-code lookup check failed: ${(error as Error).message}`);
    }

    try {
      const structuredGetResult = await invokeTool("card_get", {
        cardId: toolCardRef,
        format: "json",
      });
      if (!structuredOk(structuredGetResult)) {
        hardFailures += 1;
        fail(`card_get structured lookup failed: ${structuredGetResult}`);
      } else {
        const structuredGetData = structuredData(structuredGetResult);
        const structuredCard = isObject(structuredGetData?.card) ? structuredGetData.card as AnyRecord : undefined;
        if (structuredCard?.cardId === cardId && typeof structuredCard?.content === "string") {
          pass("card_get returns structured card data for agent-facing retrieval");
        } else {
          hardFailures += 1;
          fail(`card_get structured payload mismatch: ${structuredGetResult}`);
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card_get structured lookup check failed: ${(error as Error).message}`);
    }

    try {
      const noBoardResult = await invokeTool("card_get_vision_board", {
        cardId: toolCardRef,
        format: "json",
      });
      if (!structuredOk(noBoardResult)) {
        hardFailures += 1;
        fail(`card_get_vision_board absent-state lookup failed: ${noBoardResult}`);
      } else {
        const noBoardData = structuredData(noBoardResult);
        if (noBoardData?.status === "absent" && noBoardData?.queryCount === 0) {
          pass("card_get_vision_board reports absent status for cards without a vision board");
        } else {
          hardFailures += 1;
          fail(`card_get_vision_board absent-state mismatch: ${noBoardResult}`);
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card_get_vision_board absent-state check failed: ${(error as Error).message}`);
    }


    try {
      const bugsDeckId = await resolveDeckId("Bugs");
      if (bugsDeckId === undefined) {
        skip("archived search filtering check skipped (unable to resolve Bugs deck)");
      } else {
        const archivedPayload = await runQuery({
          _root: [
            {
              account: [
                {
                  [`cards(${JSON.stringify({
                    deckId: bugsDeckId,
                    visibility: "archived",
                    $order: "-lastUpdatedAt",
                    $limit: 20,
                  })})`]: [
                    "cardId",
                    "accountSeq",
                    "title",
                    "visibility",
                  ],
                },
              ],
            },
          ],
        });

        const archivedCards = extractCardCandidates(archivedPayload)
          .filter((card) => card.visibility === "archived" && typeof card.title === "string" && card.title.length > 0);
        const target = archivedCards[0];

        if (!target?.cardId || !target.title) {
          skip("archived search filtering check skipped (no archived Bugs card available)");
        } else {
          const defaultSearch = await invokeTool("card_search", {
            title: target.title,
            location: "deck",
            deck: "Bugs",
            limit: 50,
            format: "json",
          });
          const defaultData = structuredData(defaultSearch);
          const defaultCards = Array.isArray(defaultData?.cards) ? defaultData.cards : [];
          const foundInDefault = defaultCards.some((card) => isObject(card) && String(card.cardId ?? "") === target.cardId);

          const includeArchivedSearch = await invokeTool("card_search", {
            title: target.title,
            location: "deck",
            deck: "Bugs",
            includeArchived: true,
            limit: 50,
            format: "json",
          });
          const includeArchivedData = structuredData(includeArchivedSearch);
          const includeArchivedCards = Array.isArray(includeArchivedData?.cards) ? includeArchivedData.cards : [];
          const foundWhenIncluded = includeArchivedCards.some((card) => isObject(card) && String(card.cardId ?? "") === target.cardId);

          if (!foundInDefault && foundWhenIncluded) {
            pass("card_search hides archived cards by default and returns them with includeArchived=true");
          } else {
            hardFailures += 1;
            fail(`archived search filtering mismatch: default=${defaultSearch} includeArchived=${includeArchivedSearch}`);
          }
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`archived search filtering check failed: ${(error as Error).message}`);
    }

    try {
      const normalizationRef = toolCardRef.startsWith("$") ? toolCardRef : "$1";
      const normalizationContent = [
        "Reference normalization",
        "",
        "```",
        `\`${normalizationRef}\``,
        `**${normalizationRef}**`,
        "```",
        "",
        `Inline ref: \`${normalizationRef}\``,
        `Bold ref: **${normalizationRef}**`,
        `Italic ref: *${normalizationRef}*`,
        "Heading ref:",
        `# ${normalizationRef}`,
        "List ref:",
        `* ${normalizationRef}`,
      ].join("\n");
      const normalizationUpdate = await invokeTool("card_update", {
        cardId: toolCardRef,
        content: normalizationContent,
        mode: "replace",
        format: "json",
      });
      if (!structuredOk(normalizationUpdate)) {
        hardFailures += 1;
        fail(`card reference normalization update failed: ${normalizationUpdate}`);
      } else {
        await wait(400);
        const afterNormalization = await queryCardByTitle(title);
        const normalizedContent = afterNormalization?.content ?? "";
        const hasInlineBackticks = /`\$[0-9a-z]+`/i.test(normalizedContent);
        const hasReferenceOnlyFence = /```[\s\S]*\$2v4[\s\S]*```/i.test(normalizedContent);
        const hasBoldWrappedRef = /\*\*\$[0-9a-z]+\*\*/i.test(normalizedContent);
        const hasItalicWrappedRef = /(^|[^*])\*\$[0-9a-z]+\*(?!\*)/im.test(normalizedContent);
        const preservesHeadingRef = normalizedContent.includes(`# ${normalizationRef}`);
        const preservesListRef = normalizedContent.includes(`* ${normalizationRef}`);
        const hasExpectedRefs = normalizedContent.includes(normalizationRef);

        if (!hasInlineBackticks && !hasReferenceOnlyFence && !hasBoldWrappedRef && !hasItalicWrappedRef && preservesHeadingRef && preservesListRef && hasExpectedRefs) {
          pass("user-visible content normalizes card references to plain $code format without breaking valid heading/list markdown");
        } else {
          hardFailures += 1;
          fail(`card reference normalization verification failed: ${normalizedContent}`);
        }
      }
    } catch (error) {
      hardFailures += 1;
      fail(`card reference normalization check failed: ${(error as Error).message}`);
    }

    try {
      const blockerResult = await invokeTool("card_add_blocker", {
        cardId: toolCardRef,
        content: `validation blocker ${runTag}`,
        format: "json",
      });
      if (structuredOk(blockerResult)) {
        pass("blocker tool opened blocker thread");
      } else {
        hardFailures += 1;
        fail(`blocker tool failed: ${blockerResult}`);
      }

      const aliasResult = await invokeTool("card_add_block", {
        cardId: toolCardRef,
        content: "markdown block: ```ts\nconst x=1\n```",
        format: "json",
      });
      const aliasWarnings = structuredWarnings(aliasResult);
      if (structuredErrorCategory(aliasResult) === "validation_error"
        && aliasWarnings.length === 0) {
        pass("block alias blocked by open blocker as expected");
      } else {
        hardFailures += 1;
        fail(`block alias expected validation_error while blocker open: ${aliasResult}`);
      }

      const openBlocks = await fetchOpenResolvablesForCard(cardId, "block");
      const blockIds = Array.from(new Set(openBlocks
        .filter((entry) => isObject(entry) && typeof entry.id === "string")
        .map((entry) => String((entry as AnyRecord).id))));
      const loggedInUserId = await getLoggedInUserId();
      for (const blockId of blockIds) {
        await runDispatch("resolvables/close", {
          id: blockId,
          ...(loggedInUserId !== undefined ? { closedBy: loggedInUserId } : {}),
        });
      }

      const aliasResultAfterClose = await invokeTool("card_add_block", {
        cardId: toolCardRef,
        content: "dependency blocked; waiting on asset",
        format: "json",
      });
      const aliasWarningsAfterClose = structuredWarnings(aliasResultAfterClose);
      const aliasHasDeprecation = aliasWarningsAfterClose.some((warning) => warning.toLowerCase().includes("deprecated"));
      if (structuredOk(aliasResultAfterClose) && aliasHasDeprecation) {
        pass("block alias still works and reports deprecation warning");
      } else {
        hardFailures += 1;
        fail(`block alias warning check failed: ${aliasResultAfterClose}`);
      }

      const cleanupBlocks = await fetchOpenResolvablesForCard(cardId, "block");
      const cleanupBlockIds = Array.from(new Set(cleanupBlocks
        .filter((entry) => isObject(entry) && typeof entry.id === "string")
        .map((entry) => String((entry as AnyRecord).id))));
      for (const blockId of cleanupBlockIds) {
        await runDispatch("resolvables/close", {
          id: blockId,
          ...(loggedInUserId !== undefined ? { closedBy: loggedInUserId } : {}),
        });
      }
      pass("blocker alias test cleanup closed open blockers");
    } catch (error) {
      hardFailures += 1;
      fail(`blocker naming/alias checks failed: ${(error as Error).message}`);
    }

    try {
      const marker = `thread-${runTag}`;
      const openComment = await invokeTool("card_add_comment", {
        cardId: toolCardRef,
        content: marker,
        format: "json",
      });

      if (!structuredOk(openComment)) {
        hardFailures += 1;
        fail(`resolvable lifecycle setup (open comment) failed: ${openComment}`);
      } else {
        const openComments = await fetchOpenResolvablesForCard(cardId, "comment");
        const matched = openComments.find((resolvable) => {
          const entries = Array.isArray(resolvable.entries) ? resolvable.entries : [];
          const latest = entries[entries.length - 1];
          const content = isObject(latest) && typeof latest.content === "string" ? latest.content : "";
          return content.includes(marker);
        });

        const resolvableId = isObject(matched) && typeof matched.id === "string" ? matched.id : undefined;
        const entries = isObject(matched) && Array.isArray(matched.entries) ? matched.entries : [];
        const latestEntry = entries.length > 0 ? entries[entries.length - 1] : undefined;
        const entryId = isObject(latestEntry) && typeof latestEntry.entryId === "string"
          ? latestEntry.entryId
          : undefined;

        if (!resolvableId) {
          hardFailures += 1;
          fail(`resolvable lifecycle could not find newly opened comment thread for marker '${marker}'`);
        } else {
          if (!entryId) {
            hardFailures += 1;
            fail(`resolvable lifecycle could not find latest entry id for thread ${resolvableId}`);
          } else {
            const edited = `edited-${runTag}`;
            const editResult = await invokeTool("card_edit_resolvable_entry", {
              entryId,
              content: edited,
              format: "json",
            });
            if (structuredOk(editResult)) {
              pass("resolvable entry edit succeeded");
            } else {
              hardFailures += 1;
              fail(`resolvable entry edit failed: ${editResult}`);
            }

            const editData = structuredData(editResult);
            const versionAfter = typeof editData?.versionAfter === "number" ? editData.versionAfter : undefined;
            if (versionAfter && versionAfter > 1) {
              const staleEdit = await invokeTool("card_edit_resolvable_entry", {
                entryId,
                content: `stale-${runTag}`,
                expectedVersion: versionAfter - 1,
                format: "json",
              });
              if (structuredErrorCategory(staleEdit) === "conflict") {
                pass("resolvable entry optimistic concurrency conflict detected");
              } else {
                hardFailures += 1;
                fail(`resolvable entry stale-version conflict check failed: ${staleEdit}`);
              }
            } else {
              skip("resolvable entry conflict check skipped (version metadata unavailable)");
            }

            const verifyOpenComments = await fetchOpenResolvablesForCard(cardId, "comment");
            const verified = verifyOpenComments.some((entry) => {
              if (!isObject(entry) || String(entry.id ?? "") !== resolvableId) {
                return false;
              }
              const entryList = Array.isArray(entry.entries) ? entry.entries : [];
              const latest = entryList.length > 0 ? entryList[entryList.length - 1] : undefined;
              if (!isObject(latest)) {
                return false;
              }
              const latestEntryId = typeof latest.entryId === "string" ? latest.entryId : "";
              const content = typeof latest.content === "string" ? latest.content : "";
              return latestEntryId === entryId && content.includes(edited);
            });

            if (verified) {
              pass("resolvable entry edit reflected in resolvable listing");
            } else {
              hardFailures += 1;
              fail(`resolvable entry edit verification failed for entry ${entryId}`);
            }
          }

          const reply = await invokeTool("card_reply_resolvable", {
            resolvableId,
            content: `reply-${runTag}`,
            format: "json",
          });
          if (structuredOk(reply)) {
            pass("resolvable reply succeeded");
          } else {
            hardFailures += 1;
            fail(`resolvable reply failed: ${reply}`);
          }

          const cardContextReply = await invokeTool("card_reply_resolvable", {
            cardId: toolCardRef,
            context: "comment",
            content: `reply-by-card-context-${runTag}`,
            format: "json",
          });
          if (structuredOk(cardContextReply)) {
            pass("resolvable reply by cardId + context succeeded when exactly one matching thread is open");
          } else {
            hardFailures += 1;
            fail(`resolvable reply by cardId + context failed: ${cardContextReply}`);
          }

          const close = await invokeTool("card_close_resolvable", {
            resolvableId,
            format: "json",
          });
          if (structuredOk(close)) {
            pass("resolvable close succeeded");
          } else {
            hardFailures += 1;
            fail(`resolvable close failed: ${close}`);
          }

          const closedReply = await invokeTool("card_reply_resolvable", {
            resolvableId,
            content: `reply-while-closed-${runTag}`,
            format: "json",
          });
          if (structuredErrorCategory(closedReply) === "validation_error") {
            pass("resolvable reply to closed thread is rejected");
          } else {
            hardFailures += 1;
            fail(`resolvable reply to closed thread should fail validation: ${closedReply}`);
          }

          const reopen = await invokeTool("card_reopen_resolvable", {
            resolvableId,
            format: "json",
          });
          if (structuredOk(reopen)) {
            pass("resolvable reopen succeeded");
          } else {
            hardFailures += 1;
            fail(`resolvable reopen failed: ${reopen}`);
          }

          const finalClose = await invokeTool("card_close_resolvable", {
            resolvableId,
            format: "json",
          });
          if (structuredOk(finalClose)) {
            pass("resolvable lifecycle cleanup close succeeded");
          } else {
            hardFailures += 1;
            fail(`resolvable lifecycle cleanup close failed: ${finalClose}`);
          }

          const ambiguityMarkers = [`ambiguous-a-${runTag}`, `ambiguous-b-${runTag}`];
          for (const ambiguityMarker of ambiguityMarkers) {
            const ambiguousComment = await invokeTool("card_add_comment", {
              cardId: toolCardRef,
              content: ambiguityMarker,
              format: "json",
            });
            if (!structuredOk(ambiguousComment)) {
              hardFailures += 1;
              fail(`resolvable ambiguity setup failed for marker ${ambiguityMarker}: ${ambiguousComment}`);
            }
          }

          const ambiguousReply = await invokeTool("card_reply_resolvable", {
            cardId: toolCardRef,
            context: "comment",
            content: `ambiguous-reply-${runTag}`,
            format: "json",
          });
          if (structuredErrorCategory(ambiguousReply) === "validation_error" && ambiguousReply.includes("Multiple open resolvables matched")) {
            pass("resolvable reply by cardId + context reports ambiguity when multiple comments are open");
          } else {
            hardFailures += 1;
            fail(`resolvable ambiguity check failed: ${ambiguousReply}`);
          }

          const ambiguousComments = await fetchOpenResolvablesForCard(cardId, "comment");
          const ambiguousIds = Array.from(new Set(ambiguousComments
            .filter((resolvable) => {
              const entries = isObject(resolvable) && Array.isArray(resolvable.entries) ? resolvable.entries : [];
              return entries.some((entry) => isObject(entry)
                && typeof entry.content === "string"
                && ambiguityMarkers.some((ambiguityMarker) => entry.content.includes(ambiguityMarker)));
            })
            .map((resolvable) => String((resolvable as AnyRecord).id ?? ""))
            .filter((value) => value.length > 0)));
          const loggedInUserId = await getLoggedInUserId();
          for (const ambiguousId of ambiguousIds) {
            await runDispatch("resolvables/close", {
              id: ambiguousId,
              ...(loggedInUserId !== undefined ? { closedBy: loggedInUserId } : {}),
            });
          }
          if (ambiguousIds.length >= 2) {
            pass("resolvable ambiguity test cleanup closed generated comment threads");
          } else {
            hardFailures += 1;
            fail(`resolvable ambiguity cleanup expected at least 2 generated comment ids; found ${ambiguousIds.length}`);
          }
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (
        message.includes("Codecks API error 500")
        || message.includes("Codecks API error 429")
        || message.includes("HTTP 429")
        || message.toLowerCase().includes("rate limit")
        || message.toLowerCase().includes("timed out")
      ) {
        skip(`resolvable lifecycle skipped due to transient API timeout/rate-limit: ${message}`);
      } else {
        hardFailures += 1;
        fail(`resolvable lifecycle test failed: ${message}`);
      }
    }

    try {
      const reviewResult = await invokeTool("card_add_review", {
        cardId: toolCardRef,
        content: `validation review ${runTag}`,
        format: "json",
      });

      const reviewCategory = structuredErrorCategory(reviewResult);
      if (reviewCategory === "api_error") {
        skip("review/block mutual exclusion skipped (review API not available in this deck/workspace)");
      } else {
      const blockResult = await invokeTool("card_add_blocker", {
        cardId: toolCardRef,
        content: `validation block ${runTag}`,
        format: "json",
      });

      const reviewOk = structuredOk(reviewResult);
      const blockCategory = structuredErrorCategory(blockResult);
      if (reviewOk && blockCategory === "validation_error") {
        pass("review/block mutual exclusion enforced");
      } else {
        hardFailures += 1;
        fail(`review/block mutual exclusion check failed: review=${reviewResult} block=${blockResult}`);
      }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (message.includes("Codecks API error 500") || message.toLowerCase().includes("timed out")) {
        skip("review/block mutual exclusion skipped (workspace API timed out/errored for resolvables workflow)");
      } else {
        hardFailures += 1;
        fail(`review/block mutual exclusion test failed: ${message}`);
      }
    }

    try {
      const journeyDispatch = await invokeTool("dispatch", {
        path: "journeys/create",
        payload: {},
        format: "json",
      });
      const integrationDispatch = await invokeTool("dispatch", {
        path: "discord",
        payload: {},
        format: "json",
      });
      const journeyCategory = structuredErrorCategory(journeyDispatch);
      const integrationCategory = structuredErrorCategory(integrationDispatch);
      if (journeyCategory === "out_of_scope" && integrationCategory === "out_of_scope") {
        pass("dispatch out-of-scope policy guardrails enforced");
      } else {
        hardFailures += 1;
        fail(`dispatch policy guardrail check failed: journey=${journeyDispatch} integration=${integrationDispatch}`);
      }
    } catch (error) {
      hardFailures += 1;
      fail(`dispatch policy guardrail test failed: ${(error as Error).message}`);
    }

    if (ATTACHMENT_PATH_ENV.trim()) {
      try {
        const attachment = await invokeTool("card_add_attachment", {
          cardId: toolCardRef,
          filePath: ATTACHMENT_PATH_ENV,
          format: "json",
        });
        if (structuredOk(attachment)) {
          pass("attachment upload succeeded");
        } else {
          hardFailures += 1;
          fail(`attachment upload did not succeed: ${attachment}`);
        }
      } catch (error) {
        hardFailures += 1;
        fail(`attachment upload failed: ${(error as Error).message}`);
      }
    } else {
      skip("attachment check skipped (set CODECKS_TEST_ATTACHMENT_PATH to enable)");
    }
  }

  const optionalAssignee = process.env.CODECKS_TEST_ASSIGNEE_ID ?? process.env.CODECKS_TEST_ASSIGNEE;
  const optionalDeck = process.env.CODECKS_TEST_UPDATE_DECK;
  const optionalMilestone = process.env.CODECKS_TEST_MILESTONE;

  if (!cardId) {
    skip("optional update checks skipped (cardId unavailable)");
  } else if (optionalAssignee || optionalDeck || optionalMilestone) {
    const payload: AnyRecord = {
      sessionId: sessionId(),
      id: cardId,
    };

    if (optionalAssignee) {
      payload.assigneeId = /^\d+$/.test(optionalAssignee) ? Number(optionalAssignee) : optionalAssignee;
    }
    if (optionalDeck) {
      const maybeDeckId = await resolveDeckId(optionalDeck);
      if (maybeDeckId !== undefined) {
        payload.deckId = maybeDeckId;
      } else {
        skip(`optional deck update skipped; unable to resolve '${optionalDeck}'`);
      }
    }
    if (optionalMilestone) {
      payload.milestoneId = /^\d+$/.test(optionalMilestone) ? Number(optionalMilestone) : optionalMilestone;
    }

    if (Object.keys(payload).length > 2) {
      try {
        await runDispatch("cards/update", payload);
        pass("optional assignee/deck/milestone update applied");
      } catch (error) {
        fail(`optional update failed (non-fatal): ${(error as Error).message}`);
      }
    } else {
      skip("optional update inputs provided but no resolvable update fields");
    }
  } else {
    skip("optional assignee/deck/milestone update not configured");
  }

  if (cardId && title.startsWith(TEST_PREFIX)) {
    let cleanupResolvableFailed = false;
    try {
      const openResolvables = await fetchOpenResolvablesForCard(cardId);
      if (openResolvables.length === 0) {
        pass("cleanup found no open resolvables");
      } else {
        const loggedInUserId = await getLoggedInUserId();
        const openIds = Array.from(new Set(openResolvables
          .filter((thread) => isObject(thread) && typeof thread.id === "string")
          .map((thread) => String((thread as AnyRecord).id))));

        for (const resolvableId of openIds) {
          await runDispatch("resolvables/close", {
            id: resolvableId,
            ...(loggedInUserId !== undefined ? { closedBy: loggedInUserId } : {}),
          });
        }

        const remaining = await fetchOpenResolvablesForCard(cardId);
        if (remaining.length === 0) {
          pass("cleanup closed all open resolvables before completion");
        } else {
          cleanupResolvableFailed = true;
          hardFailures += 1;
          fail(`cleanup left ${remaining.length} open resolvable(s); skipping status=done to avoid inconsistent state`);
        }
      }
    } catch (error) {
      cleanupResolvableFailed = true;
      hardFailures += 1;
      fail(`cleanup resolvable-close pass failed: ${(error as Error).message}`);
    }

    if (cleanupResolvableFailed) {
      fail("cleanup skipped status=done because open resolvables could not be fully closed");
      return 1;
    }

    try {
      await runDispatch("cards/update", {
        sessionId: sessionId(),
        id: cardId,
        status: "done",
      });
      pass("cleanup set temp card status=done");

      let foundDoneEvent = false;
      let lastDoneLookupResult = "";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const doneLookup = await invokeTool("card_list_done_within_timeframe", {
          since: runStartedAtIso,
          mode: "cards",
          limit: 500,
          scanLimit: 300,
          pageSize: 50,
          format: "json",
        });
        lastDoneLookupResult = doneLookup;
        if (structuredOk(doneLookup)) {
          const data = structuredData(doneLookup);
          const items = Array.isArray(data?.items) ? data.items : [];
          foundDoneEvent = items.some((entry) => isObject(entry) && String(entry.cardId ?? "") === cardId);
          if (foundDoneEvent) {
            break;
          }
        }
        await wait(900);
      }

      if (foundDoneEvent) {
        pass("done-within-timeframe lookup included cleanup-completed temp card");
      } else {
        hardFailures += 1;
        fail(`done-within-timeframe lookup did not include temp card ${cardId}: ${lastDoneLookupResult}`);
      }
    } catch (error) {
      fail(`cleanup status update failed: ${(error as Error).message}`);
      try {
        await runDispatch("cards/update", {
          sessionId: sessionId(),
          id: cardId,
          content: markerContent(title, `${runTag}-cleanup-fallback`),
        });
        pass("cleanup fallback marked test marker in content");
      } catch (fallbackError) {
        hardFailures += 1;
        fail(`cleanup fallback failed: ${(fallbackError as Error).message}`);
      }
    }
  } else {
    hardFailures += 1;
    fail("cleanup skipped due to missing cardId or unsafe title prefix");
  }

  if (hardFailures > 0) {
    fail(`validation completed with ${hardFailures} hard failure(s)`);
    return 1;
  }

  pass("validation completed");
  return 0;
};

run()
  .then((code) => process.exit(code))
  .catch((error) => {
    fail(`unexpected error: ${(error as Error).message}`);
    process.exit(1);
  });
