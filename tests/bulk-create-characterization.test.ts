import assert from "node:assert/strict";
import * as core from "../src/codecks-core.ts";

process.env.CODECKS_ACCOUNT = "test-account";
process.env.CODECKS_TOKEN = "test-token";

type Json = Record<string, any>;
type RequestCounts = {
  loggedInUser: number;
  duplicateScans: number;
  creates: number;
  identityReads: number;
};
type Measurement = RequestCounts & { serializedBytes: number };

const ACCOUNT_ID = "account-test";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const response = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "content-type": "application/json" },
});
const parseResult = (value: unknown): Json => {
  const match = String(value).match(/```json\s*([\s\S]*?)\s*```/i);
  assert.ok(match, `expected structured result: ${String(value)}`);
  return JSON.parse(match[1]);
};
const relationKey = (query: Json, relation: string): string | undefined => {
  const root = query._root?.[0];
  return (root?.account ?? []).flatMap((entry: Json) => Object.keys(entry)).find((key: string) => key === relation || key.startsWith(`${relation}(`));
};
const loggedInPayload = () => ({ data: { _root: { loggedInUser: USER_ID }, user: { [USER_ID]: { id: USER_ID, name: "Sam", fullName: "Sam Example" } } } });
const emptyCardScanPayload = (key: string) => ({ data: { _root: { account: ACCOUNT_ID }, account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [key]: [] } }, card: {} } });
const invoke = async (args: Json) => core.runWithAbortSignal(undefined, () => core.card_bulk_create.execute(args), process.cwd());

const measure = async (count: number, dryRun: boolean): Promise<Measurement> => {
  const requests: RequestCounts = { loggedInUser: 0, duplicateScans: 0, creates: 0, identityReads: 0 };
  const identities = new Map<number, string>();
  let nextAccountSeq = 2400;
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/dispatch/cards/create")) {
        requests.creates += 1;
        const accountSeq = nextAccountSeq++;
        const cardId = `11111111-1111-4111-8111-${String(accountSeq).padStart(12, "0")}`;
        identities.set(accountSeq, cardId);
        return response({ id: "dispatch-action-id", payload: { id: cardId, accountSeq } });
      }

      const query = body.query as Json;
      if (JSON.stringify(query).includes("loggedInUser")) {
        requests.loggedInUser += 1;
        return response(loggedInPayload());
      }
      const key = relationKey(query, "cards");
      assert.ok(key, `unexpected query: ${JSON.stringify(query)}`);
      const accountSeqMatch = key!.match(/"accountSeq":\[(\d+)\]/);
      if (accountSeqMatch) {
        requests.identityReads += 1;
        const accountSeq = Number(accountSeqMatch[1]);
        const cardId = identities.get(accountSeq);
        assert.ok(cardId, `unexpected identity lookup for seq:${accountSeq}`);
        return response({
          data: {
            _root: { account: ACCOUNT_ID },
            account: { [ACCOUNT_ID]: { id: ACCOUNT_ID, [key!]: [cardId] } },
            card: { [cardId]: { cardId, accountSeq, title: `Card ${accountSeq}`, status: "not_started", isDoc: false } },
          },
        });
      }
      requests.duplicateScans += 1;
      return response(emptyCardScanPayload(key!));
    }) as typeof fetch;

    const result = await invoke({
      cards: Array.from({ length: count }, (_, index) => ({ title: `Characterization ${index}`, correlationKey: `row-${index}` })),
      dryRun,
      format: "json",
    });
    const parsed = parseResult(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.count, count);
    assert.equal(parsed.data.created, dryRun ? 0 : count);
    return { ...requests, serializedBytes: Buffer.byteLength(String(result), "utf8") };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const expectedBytes = new Map([
  [1, { preview: 2331, apply: 3211 }],
  [4, { preview: 7683, apply: 11200 }],
  [34, { preview: 61372, apply: 91260 }],
  [100, { preview: 179579, apply: 267482 }],
]);

console.log("cards,preview_login,preview_scan,preview_creates,preview_identity_reads,preview_bytes,apply_login,apply_scan,apply_creates,apply_identity_reads,apply_bytes");
for (const count of [1, 4, 34, 100]) {
  const preview = await measure(count, true);
  const apply = await measure(count, false);
  const bytes = expectedBytes.get(count)!;
  assert.deepEqual(
    preview,
    { loggedInUser: 1, duplicateScans: 1, creates: 0, identityReads: 0, serializedBytes: bytes.preview },
    `${count}-card preview characterization changed`,
  );
  assert.deepEqual(
    apply,
    { loggedInUser: 1, duplicateScans: 1, creates: count, identityReads: count, serializedBytes: bytes.apply },
    `${count}-card apply characterization changed`,
  );
  console.log(`${count},${preview.loggedInUser},${preview.duplicateScans},${preview.creates},${preview.identityReads},${preview.serializedBytes},${apply.loggedInUser},${apply.duplicateScans},${apply.creates},${apply.identityReads},${apply.serializedBytes}`);
}

console.log("bulk-create characterization tests passed");
