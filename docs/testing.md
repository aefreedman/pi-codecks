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

`npm test` runs unit, fixture, registration, schema-lifecycle, rendering, transport, and package-metadata tests. These checks use local fakes and must not contact Codecks even when credentials happen to exist in the caller's environment. The repository-only external-provider launcher has an injected-fetch test that verifies the normal credential-provider selection and one fixed exact-read identity query without opening a socket.

`npm run pack:validate` checks the npm dry-run manifest against the public allow-list, verifies required Pi resources, rejects private/local paths, and scans packed text for high-confidence sensitive-content patterns.

`npm run pack:smoke` creates a tarball in an operating-system temporary directory, removes Codecks variables from the child environment, installs the tarball into a neutral temporary project in offline mode, and verifies the source entrypoint, skills, prompt assets, and direct Codecks tool registration. The temporary files are removed afterward.

Public GitHub Actions run only these safe checks. Forked pull requests never receive Codecks secrets.

## Optional external-provider live validation

`npm run validate:external-provider-live` is a repository-only launcher for optional, separately authorized maintainer work or a trusted adapter wrapper. It is not normal package validation or public-CI work. It reads configuration only from the process environment and makes one fixed authenticated exact-read identity query only when **both** `CODECKS_CREDENTIAL_PROVIDER=external-helper` and the non-secret acknowledgement `PI_CODECKS_ALLOW_LIVE_VALIDATION=1` match exactly. Any missing or different value returns the fixed `invalid_configuration` category before it invokes a helper or fetch; the launcher never selects or falls back to the ambient `environment` provider, even if Codecks tokens exist. It accepts no request, model, or command-line configuration surface. Its only stdout is one redacted JSON line with fixed `status`, `category`, and `durationMs`; it never prints caught errors, stacks, account/profile/helper paths, tokens, references, API bodies, or vendor diagnostics. It exits `0` only for `authenticated`.

Do not run it from public CI or with production credentials. Configure an absolute trusted helper path as described in the [external helper protocol](external-credential-helper-protocol.md); deterministic tests use only injected fake fetch and helper implementations, never a live request.

## Explicit live integration validation

Run live validation only when you control the target account and understand which checks can mutate data:

```bash
npm run test:integration
```

The local command has three configuration outcomes:

1. **Credentials absent:** reports `skipped` and exits successfully. This is not live evidence.
2. **Credentials present, `CODECKS_TEST_DECK` absent:** runs read-only validation and reports that mutation coverage is disabled.
3. **Credentials and `CODECKS_TEST_DECK` present:** runs mutation coverage in the explicitly selected disposable fixture deck, temporarily updates and restores that deck's description, and attempts safe cleanup.

Provide credentials through `CODECKS_ACCOUNT` plus `CODECKS_TOKEN` (or their documented aliases). Profiles may be selected with `CODECKS_TEST_PROFILE`. Do not put values in repository files or shell history, and never target a production deck.

Additional optional settings enable narrowly scoped checks:

- `CODECKS_TEST_VISION_BOARD_CARD`
- `CODECKS_TEST_ATTACHMENT_PATH`
- `CODECKS_TEST_RUN`

The integration script applies conservative request-rate and timeout bounds. A query/dispatch shape change requires successful live maintainer validation before release.

`npm run test:all` runs unit checks and then invokes the integration command. Because absent credentials produce a local skip, `test:all` alone does not prove that live validation ran; inspect its reported outcome.

## Protected GitHub workflow

The separate integration workflow runs automatically after pushes to `main` and remains available through manual dispatch from `main`. It checks out `main` explicitly and uses a protected `codecks-integration` environment containing credentials for a dedicated limited CI user and disposable fixture deck. Configure the environment without a reviewer gate and retain its deployment-branch policy limited to `main`; repository YAML is not a substitute for that external protection. Missing configuration fails before the test starts. Concurrency prevents two mutation runs from using the shared fixture at once.

Public pull-request CI and the publish workflow do not receive Codecks credentials or run live validation. Before release, verify that the independent integration run for the exact `main` commit completed with mutation-enabled success.
