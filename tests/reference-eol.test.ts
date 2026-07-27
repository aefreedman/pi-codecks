import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const referencePath = "references/cg-changelog/codecks-workflow.md";
const attributes = readFileSync(path.join(root, ".gitattributes"), "utf8");
const bytes = readFileSync(path.join(root, referencePath));
const git = (args: string[], input?: Buffer): string =>
  execFileSync("git", args, { cwd: root, input, encoding: "utf8" }).trim();

assert.match(attributes, /^references\/\*\* text eol=lf$/m);
assert.equal(bytes.includes(0x0d), false, `${referencePath} must materialize with LF line endings`);
assert.equal(git(["hash-object", "--stdin"], bytes), git(["rev-parse", `HEAD:${referencePath}`]));

console.log("reference EOL test passed");
