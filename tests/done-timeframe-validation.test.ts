import { strict as assert } from "node:assert";
import { card_list_done_within_timeframe } from "../src/codecks-core.ts";

const invokeDoneWithin = (args: Record<string, unknown>): Promise<string> =>
  card_list_done_within_timeframe.execute({ format: "json", ...args } as any) as Promise<string>;

const assertValidationError = async (args: Record<string, unknown>, expectedMessage: string): Promise<void> => {
  const text = await invokeDoneWithin(args);
  assert(text.includes('"ok": false'), `Expected error payload for ${JSON.stringify(args)}. Got: ${text}`);
  assert(text.includes('"category": "validation_error"'), `Expected validation error for ${JSON.stringify(args)}. Got: ${text}`);
  assert(text.includes(expectedMessage), `Expected message '${expectedMessage}' for ${JSON.stringify(args)}. Got: ${text}`);
};

await assertValidationError({}, "since is required.");
await assertValidationError({ since: "   " }, "since is required.");
await assertValidationError({ since: "not-a-date" }, "since must be a valid ISO datetime.");
await assertValidationError(
  { since: "2026-04-28T00:00:00Z", until: "2026-04-27T00:00:00Z" },
  "until must be after since.",
);
await assertValidationError(
  { since: "2026-04-27T00:00:00Z", until: "not-a-date" },
  "until must be a valid ISO datetime.",
);

console.log("free-codecks done-timeframe validation tests passed");
