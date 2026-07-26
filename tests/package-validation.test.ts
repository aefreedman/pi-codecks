import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath: string): string => readFileSync(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(read("package.json"));

assert.notEqual(packageJson.private, true, "publish-ready package must not be marked private");
assert.equal(packageJson.name, "@aefree/pi-codecks");
assert.equal(packageJson.license, "MIT");
assert.equal(packageJson.publishConfig?.access, "public");
assert.equal(packageJson.publishConfig?.provenance, true);
assert.equal(packageJson.publishConfig?.registry, "https://registry.npmjs.org/");
assert.match(packageJson.engines?.node ?? "", /^>=\d+/);
assert.match(packageJson.repository?.url ?? "", /^git\+https:\/\/github\.com\/aefreedman\/pi-codecks\.git$/);
assert.equal(packageJson.bugs?.url, "https://github.com/aefreedman/pi-codecks/issues");
assert.equal(packageJson.homepage, "https://github.com/aefreedman/pi-codecks#readme");
for (const keyword of ["pi-package", "codecks", "project-management"]) {
  assert.ok(packageJson.keywords?.includes(keyword), `expected package keyword: ${keyword}`);
}

assert.deepEqual(packageJson.pi?.extensions, ["./index.ts"]);
assert.deepEqual(packageJson.pi?.skills, ["./skills"]);
assert.deepEqual(packageJson.pi?.prompts, ["./prompts"]);
for (const registration of ["index.ts", "skills", "prompts"]) {
  assert.ok(existsSync(path.join(root, registration)), `missing Pi registration target: ${registration}`);
}

const expectedFiles = ["index.ts", "src/", "skills/", "prompts/", "docs/", "references/", "compatibility/", "README.md", "CHANGELOG.md", "LICENSE"];
assert.deepEqual(packageJson.files, expectedFiles);
for (const forbidden of ["tests/", "scripts/", ".github/", "docs/plans/", "todos/", ".pi/"]) {
  assert.equal(packageJson.files.includes(forbidden), false, `package allow-list must exclude ${forbidden}`);
}

assert.equal(packageJson.scripts?.test, "npm run test:unit");
assert.match(packageJson.scripts?.["test:integration"] ?? "", /codecks-tool-validation\.ts/);
assert.equal(packageJson.scripts?.["test:all"], "npm run test:unit && npm run test:integration");
assert.doesNotMatch(packageJson.scripts?.test ?? "", /integration|CODECKS_/i);
assert.doesNotMatch(packageJson.scripts?.["test:unit"] ?? "", /codecks-tool-validation|CODECKS_/i);
assert.match(packageJson.scripts?.["pack:validate"] ?? "", /validate-pack-manifest/);
assert.match(packageJson.scripts?.["pack:smoke"] ?? "", /packed-tarball-smoke/);
assert.equal(packageJson.devDependencies?.tsx, "4.23.1");
assert.match(packageJson.scripts?.["test:unit"] ?? "", /codecks-mutation-dispatch\.test\.ts/);
assert.doesNotMatch(packageJson.scripts?.["test:unit"] ?? "", /codecks-mutation-authorization/);
assert.equal(packageJson.dependencies?.["@aefree/pi-workflow"], "^0.1.0");
assert.equal(packageJson.dependencies?.["@aefree/pi-capability-registry"], "^0.1.0");
assert.equal(packageJson.bundledDependencies, undefined, "Decomposition packages must be co-installed instead of copied into pi-codecks tarballs.");
assert.ok(existsSync(path.join(root, "references/cg-changelog/codecks-workflow.md")), "missing mapped Codecks changelog reference");
assert.equal(existsSync(path.join(root, "src/mutation-authorization.ts")), false, "mutation authorization module must not be packaged");
assert.equal(existsSync(path.join(root, "tests/codecks-mutation-authorization.test.ts")), false, "obsolete mutation authorization tests must stay removed");

const publicCi = read(".github/workflows/ci.yml");
const integrationWorkflow = read(".github/workflows/integration.yml");
const publishWorkflow = read(".github/workflows/publish.yml");
const workflows = [publicCi, integrationWorkflow, publishWorkflow];
assert.match(publicCi, /pull_request:/);
assert.match(publicCi, /npm test/);
assert.match(publicCi, /pack:validate/);
assert.match(publicCi, /pack:smoke/);
assert.doesNotMatch(publicCi, /CODECKS_|test:integration|secrets\./);
assert.match(publicCi, /timeout-minutes:/);
for (const workflow of workflows) {
  assert.doesNotMatch(workflow, /uses:\s+[^\s#]+@v\d+\b/, "third-party Actions must use reviewed full commit SHAs");
  for (const match of workflow.matchAll(/uses:\s+[^\s#]+@([^\s#]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/, `Action pin must be a full commit SHA: ${match[0]}`);
  }
}
assert.match(integrationWorkflow, /workflow_dispatch:/);
assert.match(integrationWorkflow, /environment: codecks-integration/);
assert.match(integrationWorkflow, /concurrency:/);
assert.match(integrationWorkflow, /if:\s+github\.ref == 'refs\/heads\/main'/);
assert.match(integrationWorkflow, /ref:\s+refs\/heads\/main/);
assert.match(integrationWorkflow, /timeout-minutes:/);
assert.match(integrationWorkflow, /npm run test:integration/);
assert.doesNotMatch(integrationWorkflow, /pull_request:|\bpush:/);
assert.match(publishWorkflow, /release:/);
assert.match(publishWorkflow, /environment: npm/);
assert.match(publishWorkflow, /id-token: write/);
assert.match(publishWorkflow, /concurrency:/);
assert.match(publishWorkflow, /timeout-minutes:/);
assert.match(publishWorkflow, /npm publish --access public --provenance/);
assert.doesNotMatch(publishWorkflow, /NPM_TOKEN|CODECKS_/);
assert.ok(existsSync(path.join(root, ".github/dependabot.yml")), "missing Dependabot configuration");
assert.ok(existsSync(path.join(root, ".github/pull_request_template.md")), "missing pull-request template");
assert.match(read(".gitignore"), /^\.env$/m);
assert.match(read("SECURITY.md"), /security\/advisories\/new/);

for (const requiredDoc of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "docs/testing.md", "docs/release.md"]) {
  assert.ok(existsSync(path.join(root, requiredDoc)), `missing public documentation: ${requiredDoc}`);
}

const readme = read("README.md");
const contributing = read("CONTRIBUTING.md");
const testing = read("docs/testing.md");
const release = read("docs/release.md");
const packageFacingDocs = [
  readme,
  contributing,
  read("SECURITY.md"),
  testing,
  release,
  read("skills/using-codecks/SKILL.md"),
  read("skills/codecks-velocity-reporting/SKILL.md"),
].join("\n");
const mutationRuntimeSurface = [
  read("index.ts"),
  read("src/codecks-core.ts"),
  read("src/codecks-tool-loading.ts"),
  read("src/codecks-workflow-provider.ts"),
  readme,
  read("skills/using-codecks/SKILL.md"),
].join("\n");
assert.doesNotMatch(mutationRuntimeSurface, /authorizationToken|workflow_authorize_mutation|mutation-authorization|authorizationProvenance|ctx\.ui\.confirm/);

assert.match(readme, /pi install npm:@aefree\/pi-codecks/);
assert.match(readme, /npm ci && npm test/);
assert.match(testing, /credential-free/i);
assert.match(testing, /npm run test:integration/);
assert.match(testing, /CODECKS_TEST_DECK/);
assert.match(contributing, /fork|pull request/i);
assert.match(release, /trusted publishing/i);
assert.match(release, /npm publish --dry-run --access public/);
assert.doesNotMatch(packageFacingDocs, /TOKEN_OP_REF|TOKEN_REF/);
assert.doesNotMatch(packageFacingDocs, /[A-Za-z]:[\\/]Users[\\/][^\\/\s]+/);
assert.doesNotMatch(packageFacingDocs, /\/(?:Users|home)\/[^/\s]+/);
assert.doesNotMatch(packageFacingDocs, /docs[\\/]plans|todos[\\/]/i);

console.log("package validation test passed");
