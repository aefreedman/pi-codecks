import assert from "node:assert/strict";

import { __test } from "../src/opencode-codecks.ts";

const { normalizeCardReferencesForUserText } = __test;

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
