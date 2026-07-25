# Release Process

`pi-codecks` uses npm trusted publishing with provenance. The GitHub `npm` environment should require maintainer approval, and the npm package must trust this repository's `.github/workflows/publish.yml` workflow. No long-lived `NPM_TOKEN` is used by the workflow.

## Prepare

1. Confirm the intended SemVer change and update `package.json` and `package-lock.json` once for the complete release.
2. Convert `## Unreleased` in `CHANGELOG.md` into a dated version section. Do not create extra version bumps for corrective work before publication.
3. Run the credential-free suite from a clean checkout:

   ```bash
   npm ci
   npm test
   npm run pack:validate
   npm run pack:smoke
   npm run pack:dry-run
   npm publish --dry-run --access public
   ```

4. Manually review the pack manifest and source for secrets, private API responses, private identifiers, machine-specific paths, local state, and generated archives.
5. Run the separate live integration workflow against the protected disposable fixture scope when Codecks API behavior changed. Confirm the workflow reports mutation-enabled success; do not infer live success from a local skip or read-only result.
6. Commit the final release metadata only after review.

## Publish

1. Create a GitHub Release from an annotated tag exactly matching `v<package-version>`.
2. The publish workflow checks out the tag, installs locked dependencies, runs all credential-free tests and package checks, verifies the tag/version match, and fails if that exact package version already exists on npm.
3. The protected `npm` environment approval gates `npm publish --access public --provenance` through trusted publishing.
4. Verify the npm package page, provenance statement, package contents, and a fresh `pi install npm:@aefree/pi-codecks` installation.

The workflow never runs live Codecks tests and receives no Codecks credentials.

## Recovery

Do not rerun publication for a version that npm already contains. Diagnose the workflow first. If published contents are unsafe, follow npm's incident guidance, rotate any exposed credential immediately, and prepare a corrected version rather than rewriting a published artifact.
