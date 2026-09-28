import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// Boot the real integration script with a configured PERSONAL profile but no credentials.
// It must reach the intentional local skip without evaluating undefined profile helpers or making requests.
const isolated = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./codecks-tool-validation.ts", import.meta.url))], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  encoding: "utf8",
  timeout: 20000,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    CODECKS_PROFILE: "PERSONAL",
    CODECKS_TEST_DECK: "Test",
  },
});
assert.equal(isolated.status, 0, `PERSONAL integration harness startup must skip safely without credentials: ${isolated.stderr}`);
assert.match(isolated.stdout, /Codecks credentials missing/);
console.log("Integration PERSONAL startup and Test-deck safety tests passed");
