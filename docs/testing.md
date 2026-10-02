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

`npm test` runs unit, fixture, registration, schema-lifecycle, rendering, transport, and package-metadata tests. Built-in 1Password coverage uses an inert fake manager to prove the exact `op run --no-masking -- <current Node child>` path, executable override validation, sanitization, and no-fallback behavior; it never contacts 1Password or Codecks. These checks use local fakes and must not contact Codecks even when credentials happen to exist in the caller's environment. The repository-only external-provider launcher has an injected-fetch test that verifies normal credential-provider selection and one fixed `_root.account.id` identity query without opening a socket. Profile/session, Bearer-header, signing/storage isolation, preview identity, and safe error tests use synthetic `cdxat_`/`cdxut_` tokens only.

`npm run pack:validate` checks the npm dry-run manifest against the public allow-list, verifies required Pi resources, rejects private/local paths, and scans packed text for high-confidence sensitive-content patterns.

`npm run pack:smoke` creates a tarball in an operating-system temporary directory, removes Codecks variables from the child environment, installs the tarball into a neutral temporary project in offline mode, and verifies the source entrypoint, skills, prompt assets, and direct Codecks tool registration. The temporary files are removed afterward.

Public GitHub Actions run only these safe checks. Forked pull requests never receive Codecks secrets.

### Frozen conversation producer comparisons

The conversation structured-output suite compares current producers with byte-exact snapshots in `tests/fixtures/conversations-baseline/`. Each snapshot is checked against its recorded Git blob hash before imports are redirected to the current canonical infrastructure in a temporary directory. The original commit is provenance only: tests do not call Git or require its history. Shallow checkouts and deleted feature branches are supported. These historical fixtures are repository-only and excluded from the npm artifact; do not regenerate them from current production code or update their hashes to make a regression pass.

### Isolated real Pi-host lifecycle smoke

Run `npm run test:pi-host-smoke` to exercise the **installed Pi SDK's real** `AgentSessionRuntime` and the package's edited `index.ts` extension, not a manually emitted extension callback. The script creates in-memory Pi settings and sessions plus a temporary agent directory, loads only the checkout extension and an inline event observer, and registers a deterministic local model provider via `ModelRuntime.registerProvider`. Seven actual prompt turns call the registered `codecks_profile_select` tool through Pi, then complete on real `agent_settled` events. It confirms task-scoped PERSONAL restoration, session-scoped PERSONAL persistence, and `session_start` resets on `startup`, in-memory `newSession()` and in-memory `fork()`. It refuses all network fetches and asserts none occurred; synthetic profile strings are never resolved as Codecks credentials. Extension loader/runtime errors and 15-second per-operation timeouts fail the smoke; sessions, environment and temporary files are cleaned up. This test intentionally does **not** cover persisted-file `switchSession()`/resume, a real Pi CLI user session, or an in-flight Codecks request at profile selection. Run it separately from `npm test`; it does not require live credentials or Codecks access.

### Credential-efficiency evidence

`card-get-tool.test.ts` compares equivalent full-card retrieval using an injected credential provider and mocked Codecks transport. With reuse disabled:

| Cards | Individual credential resolutions / HTTP attempts | Sequential batches (maximum 25) |
| --- | --- | --- |
| 17 | 17 / 17 | 1 / 1 |
| 28 | 28 / 28 | 2 / 2 |
| 37 | 37 / 37 | 2 / 2 |

These are client credential-resolution and Codecks-fetch counts, not measured 1Password internal HTTP counts or proof of live API support. The state-machine suite separately verifies enabled in-flight coalescing, TTL, cancellation, bounded cooldown, configuration changes, and late-completion precedence. Provider tests use fresh subprocesses to confirm independent process-local lifetimes. The inert fake-`op` fixture drives the actual bundled adapter, asserting helper execution rather than merely accepting an error string; transport tests distinguish its trusted envelope from identical third-party bytes. The bounded-reader suite checks exact limits, absent/misleading Content-Length, abort, stalled cancellation, and timeout cleanup.

### Cooperating-orchestrator scenario (manual guidance check)

This scenario checks the instructions in the card-operations reference, not package-enforced agent behavior:

1. Assign a private configuration the public workflow label `credential-scope-1`; schedule one batch (or one necessary single read), leaving later groups and parent verification unscheduled.
2. Substitute a safe child `credential_rate_limited` result. Verify the example workflow stops future same-label groups, including fresh children and parent verification, while retaining earlier successes and already-dispatched outcomes. Report unknown provider retry timing; do not interpret local backoff as a reset estimate.
3. Repeat with `credential_helper_unavailable`: stop and diagnose rather than blindly retry, but do not create or claim rate-limit evidence. Confirm the report contains no token, reference, account identity, private digest, or raw diagnostic.

Package cooldown and cache tests cannot establish that arbitrary deployed agents obey these instructions. There is no cross-process circuit breaker; cooperating parents remain responsible for scheduling.

## Optional external-provider live validation

`npm run validate:external-provider-live` is a repository-only launcher for optional, separately authorized maintainer work or a trusted adapter wrapper. It is not normal package validation or public-CI work. It reads configuration only from the process environment and makes one fixed authenticated exact-read identity query only when **both** `CODECKS_CREDENTIAL_PROVIDER=external-helper` and the non-secret acknowledgement `PI_CODECKS_ALLOW_LIVE_VALIDATION=1` match exactly. Any missing or different value returns the fixed `invalid_configuration` category before it invokes a helper or fetch; the launcher never selects or falls back to the ambient `environment` provider, even if Codecks tokens exist. It accepts no request, model, or command-line configuration surface. Its only stdout is one redacted JSON line with fixed `status`, `category`, and `durationMs`; `durationMs` is clamped to `0..60000`. HTTP `401` reports `authentication_rejected`; `403` reports launcher `unavailable` rather than expiry or absent identity; regular tools retain structured forbidden/scope errors. A missing/incompatible `_root.account.id` or root reports `malformed_response`. It never prints caught errors, stacks, account/profile/helper paths, tokens, references, API bodies, or vendor diagnostics. It exits `0` only for `authenticated`.

Do not run it from public CI or with production credentials. Configure an absolute trusted helper path as described in the [external helper protocol](external-credential-helper-protocol.md); deterministic tests use only injected fake fetch and helper implementations, never a live request. The coverage includes direct/map-resolved account IDs, missing/incompatible structures, unresolved references, and HTTP authentication/permission rejects.

## Explicit live integration validation

Run live validation only when you control the target account and understand which checks can mutate data:

```bash
npm run test:integration
```

The local command has three configuration outcomes:

1. **Credentials absent:** reports `skipped` and exits successfully. This is not live evidence.
2. **Credentials present, `CODECKS_TEST_DECK` absent:** runs read-only validation and reports that mutation coverage is disabled.
3. **Credentials and `CODECKS_TEST_DECK` present:** runs mutation coverage in the explicitly selected disposable fixture deck, temporarily updates and restores that deck's description, and attempts safe cleanup.

Provide a current token through trusted launcher configuration plus `CODECKS_ACCOUNT` (required account assertion), using the documented provider/profile settings. The integration script's `CODECKS_TEST_PROFILE` may choose a test profile, but its personal-user checks require PERSONAL; do not run them with ORG. Use separate trusted `CODECKS_PROFILE_ORG_ONEPASSWORD_REFERENCE` and `CODECKS_PROFILE_PERSONAL_ONEPASSWORD_REFERENCE` for the two items, each with a `credential` field. Live coverage requires checking both profile references for presence in the current trusted launcher and recording the actual result; never infer coverage from configuration alone. Never retrieve/print credentials or references, place them in repository files or shell history, or run old ambient Codecks tools to validate a modified checkout. Resolve the exact `Test` deck separately for each profile before any authorized mutation; do not mutate another deck.

Additional optional settings enable narrowly scoped checks:

- `CODECKS_TEST_VISION_BOARD_CARD`
- `CODECKS_TEST_ATTACHMENT_PATH`
- `CODECKS_TEST_RUN`

The optional live integration script applies conservative request-rate and timeout bounds. Run it only with an authorized disposable fixture in the exact test deck and the matching profile. A missing credential causes a local skip, not validation success. Before any write, confirm the deck and account; after a definite rejection, do not guess payload fields or switch identities. An ambiguous dispatch outcome requires exact target reconciliation, never an automatic replay. Structured errors report bounded HTTP status, safe validation paths and mutation certainty without raw responses, credential references or headers. ORG shared actor-dependent operations and single-card named-user Hand append/remove have narrowly scoped Test-deck readback evidence; the authenticated API-token principal is never substituted with a human assignee. Hand append requires a complete, uniquely ordered target baseline and a recheck immediately before dispatch; a concurrent user edit after the recheck cannot be excluded. ORG create-time `putOnHand` remains guarded because it does not establish a named target. The old uncertain-comment outcome was never replayed, and readback at the time cannot retrospectively prove a definite rejection.

Credential-free regressions cover ORG decked unassigned and assigned deckless creation, rejection of unassigned deckless records, PERSONAL self-assignment defaults, named-human Hand reads/writes and direct-dispatch guards, incomplete/drifting Hand order, safe errors and no replay. The real Pi-host lifecycle smoke is separate and never contacts Codecks. Do not treat synthetic tests as proof of authorization for other accounts or token scopes.
`npm run test:all` runs unit checks and then invokes the integration command. Because absent credentials produce a local skip, `test:all` alone does not prove that live validation ran; inspect its reported outcome.

## Focused local bulk-clear validation

`npm run test:integration:bulk-clear` requires PERSONAL (`CODECKS_TEST_PROFILE=PERSONAL` and its configured credential) because it queries `loggedInUser`, assigns its creator and restores that assignment. It is not an ORG actor-semantics test. `npm run test:integration:bulk-clear` exercises the local package's bulk-update preview/apply path and reads back milestone, effort, priority, tags, and assignee removal. Deck and combined deck/assignee removal are unavailable and are not dispatched; credential-free tests verify their whole-batch rejection before network access. It requires explicit `CODECKS_TEST_DECK=Test` and `CODECKS_TEST_MILESTONE` selecting an existing milestone for temporary fixture membership, and uses the package's configured credential provider. It is never part of credential-free `npm test`.

The test creates one uniquely named fixture assigned to the authenticated creator and keeps it in Test. Cleanup restores its creator assignment, clears its milestone, and marks it Done; it does not delete the card. The script reports the fixture reference and cleanup outcome. It stops on failed readback or an uncertain write rather than replaying it; inspect the reported fixture and artifact before another run. Credential failures stop subsequent requests, including cleanup. Other-user note visibility is not tested.

## Protected GitHub workflow

The separate integration workflow runs automatically after pushes to `main` and remains available through manual dispatch from `main`. It checks out `main` explicitly and uses a protected `codecks-integration` environment containing credentials for a dedicated limited CI user and disposable fixture deck. Configure the environment without a reviewer gate and retain its deployment-branch policy limited to `main`; repository YAML is not a substitute for that external protection. Missing configuration fails before the test starts. Concurrency prevents two mutation runs from using the shared fixture at once.

Public pull-request CI and the publish workflow do not receive Codecks credentials or run live validation. Before release, verify that the independent integration run for the exact `main` commit completed with mutation-enabled success.
