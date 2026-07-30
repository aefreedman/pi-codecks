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

const measure = async (count: number, dryRun: boolean, options: Json): Promise<Measurement> => {
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
      ...options,
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

const expectedDefaultApply = new Map([
  [1, { loggedInUser: 1, duplicateScans: 1, creates: 1, identityReads: 0, serializedBytes: 1170 }],
  [4, { loggedInUser: 1, duplicateScans: 4, creates: 4, identityReads: 0, serializedBytes: 1962 }],
  [34, { loggedInUser: 1, duplicateScans: 1, creates: 34, identityReads: 0, serializedBytes: 10062 }],
  [100, { loggedInUser: 1, duplicateScans: 1, creates: 100, identityReads: 0, serializedBytes: 27623 }],
]);

console.log("cards,historical_preview_scan,historical_apply_scan,historical_apply_identity_reads,default_apply_scan,default_apply_identity_reads,default_apply_bytes");
for (const count of [1, 4, 34, 100]) {
  // Phase-0 characterization is intentionally explicit: schema-v1 detailed output
  // plus opt-in identity verification keeps its old diagnostic purpose visible.
  const historicalPreview = await measure(count, true, { outputMode: "detailed", verification: "identity" });
  const historicalApply = await measure(count, false, { outputMode: "detailed", verification: "identity" });
  const defaultPreview = await measure(count, true, {});
  const defaultApply = await measure(count, false, {});
  assert.equal(defaultPreview.identityReads, 0, `${count}-card default preview must not verify identities`);
  assert.equal(defaultApply.identityReads, 0, `${count}-card default apply must not verify identities`);
  assert.deepEqual(defaultApply, expectedDefaultApply.get(count), `${count}-card compact defaults changed`);
  assert.ok(defaultApply.serializedBytes <= (count === 4 ? 4200 : count === 34 ? 19000 : count === 100 ? 52000 : 1600), `${count}-card compact response exceeded budget`);
  assert.equal(historicalApply.identityReads, count, `${count}-card opt-in identity verification bound changed`);
  console.log(`${count},${historicalPreview.duplicateScans},${historicalApply.duplicateScans},${historicalApply.identityReads},${defaultApply.duplicateScans},${defaultApply.identityReads},${defaultApply.serializedBytes}`);
}

console.log("bulk-create characterization tests passed");
