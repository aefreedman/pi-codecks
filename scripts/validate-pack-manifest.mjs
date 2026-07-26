import { readFileSync } from "node:fs";
import path from "node:path";

import { pack, packageRoot } from "./package-archive.mjs";

const requiredFiles = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "docs/resolvable-inbox-heuristics.md",
  "docs/release.md",
  "docs/testing.md",
  "index.ts",
  "package.json",
  "prompts/codecks-inbox.md",
  "references/cg-changelog/codecks-workflow.md",
  "compatibility/legacy-reference-v1/references/cg-changelog/codecks-workflow.md",
  "skills/codecks-velocity-reporting/SKILL.md",
  "skills/using-codecks/SKILL.md",
  "src/codecks-core.ts",
  "src/pi-tool-compat.ts",
  "src/velocity-report.ts",
];

const allowedExact = new Set(["CHANGELOG.md", "LICENSE", "README.md", "index.ts", "package.json"]);
const allowedPrefixes = ["docs/", "prompts/", "references/", "compatibility/", "skills/", "src/"];
const forbiddenPathPatterns = [
  { label: "test source", pattern: /^tests\// },
  { label: "packaging script", pattern: /^scripts\// },
  { label: "GitHub metadata", pattern: /^\.github\// },
  { label: "private plan", pattern: /(^|\/)docs\/plans\//i },
  { label: "workspace todo", pattern: /(^|\/)todos\//i },
  { label: "local Pi state", pattern: /(^|\/)\.pi\//i },
  { label: "dependency tree", pattern: /(^|\/)node_modules\//i },
  { label: "generated tarball", pattern: /\.tgz$/i },
  { label: "environment file", pattern: /(^|\/)\.env(?:\.|$)/i },
  { label: "private key file", pattern: /\.(?:key|pem|p12|pfx)$/i },
];

const forbiddenContentPatterns = [
  { label: "private key material", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { label: "Windows user-profile path", pattern: /[A-Za-z]:[\\/]Users[\\/](?![<{])[^\\/\s]+/ },
  { label: "Unix user-profile path", pattern: /\/(?:Users|home)\/(?![<{])[^/\s]+/ },
  { label: "private planning path", pattern: /(?:^|[\\/])docs[\\/]plans[\\/]/im },
];

const result = pack({ dryRun: true });
const files = result.files.map((entry) => String(entry.path).replaceAll("\\", "/")).sort();
const errors = [];

for (const required of requiredFiles) {
  if (!files.includes(required)) {
    errors.push(`missing required package file: ${required}`);
  }
}

for (const file of files) {
  if (!allowedExact.has(file) && !allowedPrefixes.some((prefix) => file.startsWith(prefix))) {
    errors.push(`file is outside the public allow-list: ${file}`);
  }
  for (const { label, pattern } of forbiddenPathPatterns) {
    if (pattern.test(file)) errors.push(`${label} must not be packed: ${file}`);
  }

  const absolutePath = path.join(packageRoot, ...file.split("/"));
  let content;
  try {
    content = readFileSync(absolutePath, "utf8");
  } catch {
    continue;
  }
  for (const { label, pattern } of forbiddenContentPatterns) {
    if (pattern.test(content)) {
      errors.push(`${label} found in packed file: ${file}`);
    }
  }
}

if (errors.length > 0) {
  console.error("Packed manifest validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Packed manifest validation passed (${files.length} intentional public files).`);
}
