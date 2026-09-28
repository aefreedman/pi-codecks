# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities through [GitHub's private security-advisory form](https://github.com/aefreedman/pi-codecks/security/advisories/new). Do not open a public issue containing exploit details, credentials, private Codecks data, or raw API responses. If private advisories are temporarily unavailable, open a public issue containing only a request for a private contact channel and no sensitive details.

Include only the minimum reproduction information needed. Redact tokens, authorization headers, cookies, account-specific identifiers, user data, and local filesystem paths. Maintainers will acknowledge the report, assess affected versions, and coordinate a fix and disclosure when appropriate.

For ordinary bugs without sensitive details, use the public issue tracker.

## Credential and data handling

`pi-codecks` resolves credentials through its internal provider boundary. The default `environment` provider reads environment variables supplied before Pi starts. This compatibility path is ambient within the Pi process: unrelated same-process extensions or subprocesses may inherit its token. It is not an isolation boundary. Repository files, examples, fixtures, screenshots, logs, and workflow definitions must never contain live credentials or private account data. See [Configuration and migration](README.md#configuration) for the user-facing provider choice.

- Use a dedicated non-production account and disposable fixture scope for live integration validation.
- Keep live tests outside public pull-request CI.
- Store GitHub Actions integration values as protected environment secrets.
- Never paste raw Codecks responses into public reports; provide a minimal redacted shape instead.
- If a credential may have been exposed, revoke or rotate it before sharing further details.

The environment provider rejects unresolved profile secret-reference placeholders. Resolve secrets before launch, then pass the resulting value through the supported environment variables.

Users may explicitly select the built-in `CODECKS_CREDENTIAL_PROVIDER=onepassword` provider with trusted `CODECKS_PROFILE_ORG_ONEPASSWORD_REFERENCE` and `CODECKS_PROFILE_PERSONAL_ONEPASSWORD_REFERENCE` (separate items, each with a `credential` field) and process-only `OP_SERVICE_ACCOUNT_TOKEN`. A configured profile-specific reference overrides the legacy global `PI_CODECKS_ONEPASSWORD_REFERENCE`, retained for single-profile ORG setups; PERSONAL cannot inherit the global ORG reference. It resolves either the optional absolute `PI_CODECKS_ONEPASSWORD_OP_EXECUTABLE` override or one unambiguous canonical executable from non-empty startup `PATH` entries, then uses a fixed `op run --no-masking -- <current Node child>` protocol. The reference, Codecks credentials, conflicting 1Password session/Connect/service-account variables, and Node injection variables are removed before invoking `op`; provider failures never fall back to ambient Codecks tokens. `--no-masking` is deliberately required only for the private bounded protocol, not public output. This does not isolate trusted extensions or same-user processes.

Users may alternatively select `CODECKS_CREDENTIAL_PROVIDER=external-helper` with an absolute trusted `.js`/`.mjs` `CODECKS_CREDENTIAL_HELPER_MODULE`. The package runs that module through the current Node executable without a shell or caller/model-selected arguments; its bounded versioned stdin/stdout exchange and adapter-author requirements are documented in [the external helper protocol](docs/external-credential-helper-protocol.md). Global/profile Codecks direct-token and secret-reference variables plus profile/provider/helper selectors are removed case-insensitively from the helper's inherited environment. Helper stdout/stderr, paths, manager references, and credentials are never included in public errors or tool results. A selected helper is authoritative: invalid configuration, malformed output, nonzero exit, timeout, cancellation, or launch failure fails closed and never falls back to an ambient token. This reduces accidental Codecks-token inheritance; it does not isolate trusted extensions or same-user processes.

The helper path and manager configuration are trusted launcher settings, not model-facing input or authorization. Agent-facing `codecks_profile_select` accepts only ORG/PERSONAL and task/session scope on explicit user intent; it never accepts a token or reference, escalates on errors, or grants tracker-write authority. New/resumed/forked sessions reset selection to the configured startup profile (ORG by default), while in-flight operations retain their original profile. The built-in 1Password provider alone offers opt-in process-local reuse, disabled by default and limited to five minutes and 64 identities; it stores no credentials on disk and cannot guarantee JavaScript memory zeroization. Its 60-second rate-limit suppression is local backoff, not a provider reset estimate. Generation-specific 401 eviction does not replay requests. Third-party helpers retain operation-only credential lifetime. `pi-codecks` is not a secret broker and does not promise helper discovery, cross-process caching, refresh/lease handling, automatic 401 retry, isolation from malicious extensions, or protection from same-user process inspection.

Codecks transport uses `Authorization: Bearer` rather than legacy `X-Auth-Token`. Unknown token formats fail closed. Codecks credentials are sent to Codecks upload-signing requests, not signed storage destinations. A configured account subdomain remains required and is asserted with `X-Account`; live token-derived account URL behavior is not yet established. HTTP 403 permission/scope failures do not cause fallback or credential eviction. Structured diagnostics redact credentials, references and Authorization headers. Organization-only actor-dependent writes are conservatively rejected before dispatch until verified live. Search/report completeness is limited to token-visible projects; observation refresh cannot safely merge unmeasured permission snapshots.

The optional `validate:external-provider-live` launcher is separately authorized live work, not a general credential check. It fails closed before helper execution or fetch unless the process has both exact `CODECKS_CREDENTIAL_PROVIDER=external-helper` and non-secret `PI_CODECKS_ALLOW_LIVE_VALIDATION=1`. It never permits the `environment` provider or ambient-token fallback. Do not set the acknowledgement in public CI; use only separately authorized non-production credentials.

## Supported versions

Until the first npm publication, security fixes are applied to the latest code on the default branch. After publication, the latest released version will receive security fixes; older releases may be asked to upgrade.
