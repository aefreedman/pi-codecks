import assert from "node:assert/strict";

import { __test } from "../src/codecks-core.ts";

const { normalizeCardReferencesForUserText, parseCardIdentifier, buildReusableCardRefs } = __test;

assert.deepEqual(parseCardIdentifier("$12g"), { accountSeq: 42, cardCode: "12g" });
assert.deepEqual(parseCardIdentifier("12g"), { accountSeq: 42, cardCode: "12g" });
assert.deepEqual(parseCardIdentifier("https://example.codecks.io/card/12g"), { accountSeq: 42, cardCode: "12g" });
assert.deepEqual(parseCardIdentifier("11111111-1111-4111-8111-111111111111"), { cardId: "11111111-1111-4111-8111-111111111111" });
assert.deepEqual(parseCardIdentifier(387), parseCardIdentifier("387"), "bare numbers retain short-code semantics");
assert.deepEqual(parseCardIdentifier("seq:2481"), { accountSeq: 2481 });
assert.deepEqual(buildReusableCardRefs(2481), { cardRef: "$45j", accountSeqRef: "seq:2481" });

assert.equal(normalizeCardReferencesForUserText("**$123**"), "$123");
assert.equal(normalizeCardReferencesForUserText("*$2sr*"), "$2sr");
assert.equal(normalizeCardReferencesForUserText("_$155_"), "$155");
assert.equal(normalizeCardReferencesForUserText("~~$2v4~~"), "$2v4");
assert.equal(normalizeCardReferencesForUserText("Inline `$155` ref"), "Inline $155 ref");
assert.equal(normalizeCardReferencesForUserText("# $155"), "# $155");
assert.equal(normalizeCardReferencesForUserText("* $2v4"), "* $2v4");
assert.equal(
  normalizeCardReferencesForUserText(["```", "`$2v4`", "**$2sr**", "```"].join("\n")),
  ["$2v4", "$2sr"].join("\n"),
);

console.log("card reference normalization test passed");
