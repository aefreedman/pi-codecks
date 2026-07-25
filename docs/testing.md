# Testing Pi Codecks

The test surface is intentionally split so public validation is credential-free while live Codecks validation remains explicit and maintainer-controlled.

## Public-safe checks

From a clean checkout:

```bash
npm ci
npm test
npm run pack:validate
npm run pack:smoke
npm run pack:dry-run
```

`npm test` runs unit, fixture, registration, schema-lifecycle, rendering, transport, and package-metadata tests. These checks use local fakes and must not contact Codecks even when credentials happen to exist in the caller's environment.

`npm run pack:validate` checks the npm dry-run manifest against the public allow-list, verifies required Pi resources, rejects private/local paths, and scans packed text for high-confidence sensitive-content patterns.

`npm run pack:smoke` creates a tarball in an operating-system temporary directory, removes Codecks variables from the child environment, installs the tarball into a neutral temporary project in offline mode, and verifies the source entrypoint, skills, and prompt assets. The temporary files are removed afterward.

Public GitHub Actions run only these safe checks. Forked pull requests never receive Codecks secrets.

## Explicit live integration validation

Run live validation only when you control the target account and understand which checks can mutate data:

```bash
npm run test:integration
```

The local command has three configuration outcomes:

1. **Credentials absent:** reports `skipped` and exits successfully. This is not live evidence.
2. **Credentials present, `CODECKS_TEST_DECK` absent:** runs read-only validation and reports that mutation coverage is disabled.
3. **Credentials and `CODECKS_TEST_DECK` present:** runs mutation coverage in the explicitly selected disposable fixture deck and attempts safe cleanup.

Provide credentials through `CODECKS_ACCOUNT` plus `CODECKS_TOKEN` (or their documented aliases). Profiles may be selected with `CODECKS_TEST_PROFILE`. Do not put values in repository files or shell history, and never target a production deck.

Additional optional settings enable narrowly scoped checks:

- `CODECKS_TEST_VISION_BOARD_CARD`
- `CODECKS_TEST_ATTACHMENT_PATH`
- `CODECKS_TEST_RUN`

The integration script applies conservative request-rate and timeout bounds. A query/dispatch shape change requires successful live maintainer validation before release.

`npm run test:all` runs unit checks and then invokes the integration command. Because absent credentials produce a local skip, `test:all` alone does not prove that live validation ran; inspect its reported outcome.

## Manual GitHub workflow

The separate integration workflow is available only through manual dispatch and a protected `codecks-integration` environment. It requires protected secrets for the account, token, and disposable fixture deck. Missing configuration fails before the test starts. Concurrency prevents two mutation runs from using the shared fixture at once.

Public CI and the publish workflow do not run this live workflow automatically.
