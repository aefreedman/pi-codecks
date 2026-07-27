import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const referencePath = "references/cg-changelog/codecks-workflow.md";
const compatibilityReferencePath = "compatibility/legacy-reference-v1/references/cg-changelog/codecks-workflow.md";
const attributes = readFileSync(path.join(root, ".gitattributes"), "utf8");
const bytes = readFileSync(path.join(root, referencePath));
const compatibilityBytes = readFileSync(path.join(root, compatibilityReferencePath));
const git = (args: string[], input?: Buffer): string =>
  execFileSync("git", args, { cwd: root, input, encoding: "utf8" }).trim();

assert.match(attributes, /^references\/\*\* text eol=lf$/m);
assert.match(attributes, /^compatibility\/legacy-reference-v1\/\*\* text eol=lf$/m);
assert.equal(bytes.includes(0x0d), false, `${referencePath} must materialize with LF line endings`);
assert.equal(git(["hash-object", "--stdin"], bytes), git(["rev-parse", `HEAD:${referencePath}`]));
assert.equal(compatibilityBytes.includes(0x0d), false, `${compatibilityReferencePath} must materialize with LF line endings`);
assert.equal(git(["hash-object", "--stdin"], compatibilityBytes), git(["rev-parse", `HEAD:${compatibilityReferencePath}`]));
assert.equal(createHash("sha256").update(compatibilityBytes).digest("hex"), "d13a65e9b8815cdd3a8a877d1b75929a4a1cdb4d79dfdd01ee6072da6675cb9b");

console.log("reference EOL test passed");
