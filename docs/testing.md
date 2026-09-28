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

The integration script applies conservative request-rate and timeout bounds. A query/dispatch shape change requires successful live maintainer validation before release. In the approved Test-only organization-comment contract probe, one `resolvables/create` request omitting `userId` returned a generic `api_error`; the client did not retain its HTTP status. A subsequent narrow read found no matching comment, which alone does not prove definite rejection. No replay or cleanup mutation was attempted at that checkpoint, and the ORG thread guard remained in place then. Do not present this historical inconclusive attempt as a Codecks restriction: the API manual allows organization tokens with suitable scopes to write comments. The later bounded experiment below established the Comment actor payload and readback attribution. Subsequent local-only transport improvements record bounded HTTP status, stable API code/path, and mutation attempt certainty where available; `tests/live-error-evidence.ts` allow-lists these fields for authorized harness output rather than forwarding bodies or headers. `http_response` means an HTTP reply was received, not that an action succeeded or was rejected; only explicit 400/401/403 and rate-limited 429 errors are tagged definitely rejected. An absent response remains indeterminate; inspect the exact target rather than replaying it. This change does not retroactively determine the prior probe's status or outcome. In a separately authorized fresh experiment, a new ORG fixture in the exact Test deck received one `resolvables/create` Comment dispatch with `userId` omitted: HTTP 400, one HTTP response, definite rejection, no stable API code/query path or safely renderable field-specific diagnostic. Exact readback found no matching Comment. The new fixture was independently confirmed Done in Test. A later fresh marker with improved bounded error-envelope capture returned HTTP 400 and the safe server explanation `body must have property 'userId'`. Read-only ORG principal queries confirmed `_root.loggedInUser` is a non-human API-token user, identical to the ORG-created card creator and different from its human assignee. One field-driven correction using that authenticated principal as `userId` succeeded; exact Comment readback found one unique marker and an author matching the ORG card creator name. Shared ORG tools now verify this actor before attachment and Comment/Review/Blocker creation, reply, author-owned edit and close/reopen dispatch; direct ORG actor dispatch and implicit own-hand operations remain guarded. In a later bounded Test fixture, ORG attachment signing/upload/registration succeeded and an independent `card.attachments` relation read matched the file name or URL; separate exact thread reads confirmed Review, reply, close/reopen, Blocker and author-owned entry edit with actor attribution. The older inconclusive fixture was read-only reconciled and marked Done without replaying the old comment. The original uncertain fixture was not replayed. The owned Test fixture's open Blocker was later closed once with exact state readback; when a subsequent card read showed `not_started`, it was marked Done once and read back Done. A response without a safe diagnostic must not prompt guessed actor IDs or payload permutations.

Credential-free tests now cover the intended create invariant: ORG decked unassigned and assigned deckless normalize and dispatch, but unassigned plus deckless is rejected; PERSONAL default own-assignee behavior remains. ORG hand *reads* require an explicit human `userId` from `codecks_user_lookup`, and ORG cannot read its nonexistent own hand/bookmarks. `putOnHand` writes remain guarded for ORG because the existing boolean does not identify a human target on the wire. No live deckless create was performed; exact Test-only scope did not authorize a deckless write. Producer-like deck/milestone/run update paths have no local ORG kind prohibition; synthetic tests cover those dispatches without live non-Test mutations. A later bounded ORG-only investigation uniquely resolved active human Aaron through account roles and confirmed the exact Test deck and a five-entry hand baseline. One disposable Test-deck card assigned to Aaron was created with `putOnHand: false`. A third-party-source-informed `handQueue/addCardsToOwner` attempt carrying one card, explicit target `userId`, accountId and sessionId received a definitely rejected HTTP 400 with no safe field-level reason. Exact Aaron `queueEntries(userId)` readback contained no test card and preserved all existing entries/order; the exact fixture was marked Done and independently read back Done. No removal dispatch was needed, and the source-only `handQueue/removeCards` contract was unverified *at that checkpoint*. The user subsequently supplied browser-observed exact action and JSON-body contracts for `handQueue/setCardOrders` (complete current ordered card IDs plus one appended fixture, `draggedCardIds` containing only the fixture, explicit human `userId`, fresh `sessionId`) and `handQueue/removeCards` (only fixture ID, same human target, fresh sessionId). No captured IDs, session/order, cookies, headers or HAR were replayed. With a new uniquely marked Test-deck fixture assigned to Aaron, fresh full active-hand reads found five uniquely ordered entries, a stable immediate recheck, and no existing fixture entry. Exactly one ORG append succeeded; immediate `queueEntries(userId)` readback returned six entries with the new fixture last, all five original IDs in their original relative order, and exact actor/target separation. Exactly one named-target remove succeeded; readback returned the original five entries in the same order and no fixture. The card was then marked Done once with exact Test deck/card/status readback, and a final queue read again matched the original five entries. No unrelated hand entry, bookmark, deck or personal setting was changed. Focused tools now perform complete, bounded active-hand order reads, reject missing target/incomplete or ambiguous order, recheck drift immediately before writing and verify exact readback; raw hand dispatch remains guarded. There is no server-side compare-and-swap: an intervening concurrent user edit after the final recheck remains a residual risk. ORG create `putOnHand` remains separately guarded; do not conflate its unverified target with this verified existing-card queue action.

`npm run test:all` runs unit checks and then invokes the integration command. Because absent credentials produce a local skip, `test:all` alone does not prove that live validation ran; inspect its reported outcome.

## Focused local bulk-clear validation

`npm run test:integration:bulk-clear` requires PERSONAL (`CODECKS_TEST_PROFILE=PERSONAL` and its configured credential) because it queries `loggedInUser`, assigns its creator and restores that assignment. It is not an ORG actor-semantics test. `npm run test:integration:bulk-clear` exercises the local package's bulk-update preview/apply path and reads back milestone, effort, priority, tags, and assignee removal. Deck and combined deck/assignee removal are unavailable and are not dispatched; credential-free tests verify their whole-batch rejection before network access. It requires explicit `CODECKS_TEST_DECK=Test` and `CODECKS_TEST_MILESTONE` selecting an existing milestone for temporary fixture membership, and uses the package's configured credential provider. It is never part of credential-free `npm test`.

The test creates one uniquely named fixture assigned to the authenticated creator and keeps it in Test. Cleanup restores its creator assignment, clears its milestone, and marks it Done; it does not delete the card. The script reports the fixture reference and cleanup outcome. It stops on failed readback or an uncertain write rather than replaying it; inspect the reported fixture and artifact before another run. Credential failures stop subsequent requests, including cleanup. Other-user note visibility is not tested.

## Protected GitHub workflow

The separate integration workflow runs automatically after pushes to `main` and remains available through manual dispatch from `main`. It checks out `main` explicitly and uses a protected `codecks-integration` environment containing credentials for a dedicated limited CI user and disposable fixture deck. Configure the environment without a reviewer gate and retain its deployment-branch policy limited to `main`; repository YAML is not a substitute for that external protection. Missing configuration fails before the test starts. Concurrency prevents two mutation runs from using the shared fixture at once.

Public pull-request CI and the publish workflow do not receive Codecks credentials or run live validation. Before release, verify that the independent integration run for the exact `main` commit completed with mutation-enabled success.
