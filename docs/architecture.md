# Internal architecture

These are internal ownership boundaries, not public package subpath APIs. The extension continues to load through `index.ts`; existing direct consumers retain the exports of `src/codecks-core.ts`.

## Owners

- `index.ts` composes registration, profiles, activation, public references and lifecycle. `src/pi/tool-metadata.ts` defines the established registration order and optional debug selection, not tool implementations.
- `src/pi/tool-catalog.ts` composes each domain contribution exactly once. `tool-definition.ts` describes internal contributions; `register-tools.ts` owns Pi execution, operation scope, rendering and native result adaptation. `input-primitives.ts` owns reusable schema and alias primitives.
- `src/tools/cards/{reads,writes,bulk,helpers,definitions}.ts` owns card retrieval, mutations, bulk preflight/fingerprints/outcomes and local metadata. The existing `card-get-output.ts` and `card-search-output.ts` remain the two native structured projection/schema owners; definitions route to them without reconstructing payloads from text.
- `src/tools/entities/` owns deck, milestone, Run and user operations and metadata. `src/tools/conversations/` owns thread reads, lifecycle writes, optional diagnostics and metadata, including the deprecated blocker alias.
- `src/tools/reports/` owns report/cache entry points, Run statistics and metadata. Existing velocity modules retain cache validation, path containment, atomic writes, numerical calculations and provenance.
- `src/tools/raw.ts` owns raw query/dispatch fallbacks; `raw-definitions.ts` owns their metadata. Identity diagnostics belong to `src/runtime/identity.ts`.
- `src/shared/` contains cohesive cross-domain query, resolution, observation, reference, presentation and result helpers. `src/contracts/common.ts` owns neutral bounded projection and error vocabulary.
- `src/codecks-core.ts` is the established-export facade. Its `__test` object only composes aliases/callbacks to canonical owners; it does not implement domain operations or maintain runtime state.

## Dependency direction and state

Composition imports domain definitions; definitions import operations; operations import local helpers and canonical shared/runtime owners. Domains never import the facade, lifecycle, adapter or another domain. Runtime/shared/contracts never import domains, Pi composition or the facade. Existing cohesive credential-provider, bounded-response, profile, renderer, loading and velocity modules remain their original owners. The local dependency graph is acyclic, including type-only and literal dynamic imports.

`runtime/operation-context.ts` owns operation-scoped abort/profile/workspace, credential memoization and request/progress accounting. `runtime/pacing.ts` owns one process-level physical request gate, server cooldown and bounded account-scan queue. `runtime/credentials.ts` coordinates provider selection using the existing credential caches. `runtime/transport.ts` owns bounded HTTP, pacing, read retry and write uncertainty. Importing a tool creates no request and no per-tool copy of these controls.

Extraction does not change retry policy, API concurrency, authentication, activation or input schemas. All 42 specialized domain tools have producer-native structured contracts; the seven explicitly justified exclusions retain legacy native behavior. All tools retain their legacy direct-core text/JSON interfaces. See the [explicit contract roster](../references/codecks/structured-output-index.md). Bulk certainty and fingerprints, Hand readback/drift, conversation restrictions and absent/null/false/zero observations remain operation-owned behavior, not adapter policy.

## Native operation payload foundation

`CodecksOperationPayload` in `src/pi/tool-definition.ts` is `{ text: string; payload: Record<string, unknown> }`. A definition supplies either the accepted `read(args)` or neutral `executePayload(args)`, never both, and a domain-owned `outputSchema`/`projectOutput(payload)`. The adapter invokes exactly one seam inside the canonical operation scope instead of invoking legacy `execute` as well. `CodecksStructuredOutput` describes the neutral ok/error envelope; `CodecksStructuredReadOutput` remains a compatibility alias. The seam name does not imply read-only behavior, authorization, mutation certainty or replay policy. Mutation producers must preserve dispatched/indeterminate effects even when projection fails.

Batch owns `src/tools/cards/card-get-batch-output.ts`; the narrow `card-get-observation.ts` helper shares existing single-card native observations without changing pilot schemas or legacy normalizers. Found batch items embed the accepted single-card success envelope and its byte/completeness rules. Projection errors are explicit items with single-card errors and a top-level native failure; source counts are not rewritten as missing. The common projector selects object-union literal discriminators before clipping. See [batch contract](../references/codecks/card-get-batch-output.md).

These interfaces add no runtime state, credential owner, request, retry or host-hook enforcement. Existing pilot output modules remain at `src/card-get-output.ts` and `src/card-search-output.ts`. Cards, entities, conversations and reports own separate output/schema projectors. The opt-in shared done-transition callback captures allowlisted observations before legacy defaults during the same scan; default history/velocity callers remain unchanged. Shared interfaces and common hosts/inventories are integration-owned, with no duplicated limiter, ALS or credential/cache owner.

## Validation and packaging

`tests/modular-architecture.test.ts` checks exact export/catalog inventory, owner identities, native-contract routing, raw local failures, dependency direction, singleton context ownership and the complete local import graph. `foundation-seams.test.ts` checks independently captured baseline metadata/schema hashes, shared pacing/context behavior and registration. Domain tests and existing safety regressions provide behavioral coverage; actual offline Pi host/lifecycle and packed-consumer tests validate composition and install layout.

All runtime modules under `src/` and this document are intentionally packed. Tests, packaging scripts, private plans, local state and worker evidence are not package assets. No sibling checkout is required for default validation or consumers. Domain output owners and all linked public contract references ship with the package. This layout does not authorize live mutations.
