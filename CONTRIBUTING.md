# Contributing to Pi Codecks

Thank you for improving `pi-codecks`.

## Development setup

Use Node.js 20 or newer and install the locked development dependencies:

```bash
npm ci
npm test
```

`npm test` is the required public contribution path. It is deterministic, credential-free, and must never contact Codecks. Pull requests from forks do not receive or require repository secrets.

Before opening a pull request, also validate the public package:

```bash
npm run pack:validate
npm run pack:smoke
npm run pack:dry-run
```

These commands verify the package allow-list and install a generated tarball in a neutral temporary project. Review the dry-run manifest for unexpected tests, local state, generated archives, or private material.

## Live integration validation

Live validation is maintainer-controlled and is not part of public CI. Do not add credentials to tests, fixtures, issue reports, pull requests, workflow files, or command output.

Maintainers may run `npm run test:integration` explicitly with environment-provided Codecks credentials. Without credentials the local script reports a skip. With credentials but no `CODECKS_TEST_DECK`, it remains read-only. Mutation coverage requires an explicitly configured disposable fixture deck that contains no production work. See [Testing](docs/testing.md).

Changes to Codecks query or dispatch shapes need live maintainer validation before release, but contributors are not expected to provide that evidence from forks.

## Pull requests

- Keep changes focused and describe user-visible behavior and credential-free test evidence.
- Add or update unit coverage without making network requests.
- Keep unreleased user-visible changes under `## Unreleased` in `CHANGELOG.md`; do not bump the package version for ordinary pull requests.
- Do not commit generated tarballs, environment files, tokens, account data, private API responses, local paths, or private planning material.
- Keep package-facing documentation safe for public distribution.
- Do not weaken the explicit boundary between public-safe tests and opt-in live integration tests.

By contributing, you agree that your contribution is provided under the repository's MIT license.
