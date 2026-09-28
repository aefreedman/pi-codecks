import assert from "node:assert/strict";
import { classifyDeckDescriptionReadback, isExactTestDeck } from "./integration-deck-safety.ts";

const baseline = Object.freeze({ id: "synthetic-deck", accountSeq: 2, title: "Test" as const, description: "original description" });
assert.equal(isExactTestDeck(baseline, baseline.id), true);
assert.equal(isExactTestDeck({ ...baseline, title: "Production" }, baseline.id), false);
assert.equal(isExactTestDeck({ ...baseline, description: undefined }, baseline.id), false);
assert.equal(isExactTestDeck(baseline, "other-deck"), false);
assert.equal(classifyDeckDescriptionReadback(baseline, { ...baseline }, "unique temporary"), "baseline", "predispatch failure needs no restoration");
assert.equal(classifyDeckDescriptionReadback(baseline, { ...baseline, description: "unique temporary" }, "unique temporary"), "temporary", "only this run's exact temporary description can be restored");
for (const observed of [
  undefined,
  { ...baseline, id: "other-deck" },
  { ...baseline, title: "Other" },
  { ...baseline, accountSeq: 3 },
  { ...baseline, description: "concurrent edit" },
  { ...baseline, description: undefined },
]) {
  assert.equal(classifyDeckDescriptionReadback(baseline, observed, "unique temporary"), "unsafe");
}
assert.equal(baseline.description, "original description", "baseline is immutable throughout readback classification");
console.log("Integration Test-deck baseline and readback safety tests passed");
