# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's private security-advisory feature for this repository. Do not open a public issue containing exploit details, credentials, private Codecks data, or raw API responses.

Include only the minimum reproduction information needed. Redact tokens, authorization headers, cookies, account-specific identifiers, user data, and local filesystem paths. Maintainers will acknowledge the report, assess affected versions, and coordinate a fix and disclosure when appropriate.

For ordinary bugs without sensitive details, use the public issue tracker.

## Credential and data handling

`pi-codecks` expects credentials through environment variables supplied before Pi starts. Repository files, examples, fixtures, screenshots, logs, and workflow definitions must never contain live credentials or private account data.

- Use a dedicated non-production account and disposable fixture scope for live integration validation.
- Keep live tests outside public pull-request CI.
- Store GitHub Actions integration values as protected environment secrets.
- Never paste raw Codecks responses into public reports; provide a minimal redacted shape instead.
- If a credential may have been exposed, revoke or rotate it before sharing further details.

The package rejects unresolved secret-reference placeholders. Resolve secrets through an explicit secret integration, then pass the resulting value through the supported environment variables.

## Supported versions

Until the first npm publication, security fixes are applied to the latest code on the default branch. After publication, the latest released version will receive security fixes; older releases may be asked to upgrade.
