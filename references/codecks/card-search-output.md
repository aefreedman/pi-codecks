# Card-search structured output (v1)

Only `codecks_card_search` adopts this search-specific contract. Core `card_search.execute` still returns its legacy text/fenced JSON; the registered Pi adapter reads original native data through an internal seam and validates its allowlist projection. Requests, pacing, credentials, aborts and legacy output modes do not change. No hook enforcement or Safety Rails dependency is added. Card-get retains its own contract; all remaining tools stay legacy.

```typescript
const result = await tools.codecks_card_search({ text: "planning", outputMode: "counts" });
if (!result.ok) text(result.error);
else text({ matches: result.data.matches, read: result.completeness.read, rows: result.data.emittedRows });
```

## Envelope and coverage

Strict objects reject additional properties. Every result has `schemaVersion: 1`, `action: "card_search"`, `ok`, `provenance: { source: "codecks", contentTrust: "external" }`, and `completeness: { read, projection }`.

`read` describes the observed scoped traversal: `complete`, `incomplete`, or `unknown`. Successful partial searches remain `ok: true`; an incomplete empty result **never proves absence**. Even complete results cover only token-visible projects, not all organization data or verified effective permissions. `projection: false` marks producer clipping or contract/byte failure, independently of read completeness. A complete scan does not make a mode sample exhaustive.

Success carries `data`:
- `matches`, `rawMatches`: source counts before caller row limit; `returnedCards`: legacy displayed card-row count (zero in counts mode). These are not DTO row counts.
- `emittedRows`: actual projected `cards` or `sampleCards` length, after clipping. `rowsExhaustive` is false for compact/counts, partial reads, caller-limit truncation or projection clipping. Only a complete, untruncated detailed projection can set it true.
- `outputMode`: compact, detailed, counts; `visibility`: `token_visible_projects_only`. Compact emits up to 25 rows, detailed up to caller limit (3000), counts up to 10 sample rows and no returned card rows. Empty counts may carry the legacy empty `cards` array rather than `sampleCards`.
- Optional nullable observed metrics: `scannedCards`, `scanLimit`, `pageSize`, `scanLimitReached`, `requestsAttempted`, `queueWaitMs`, `elapsedMs`. Missing measurements are omitted, not manufactured from renderer defaults. Optional `truncated` and `truncatedByOutputLimit` retain legacy mode/caller-limit semantics (they are absent on legacy empty results).
- `criteria` contains only supplied caller search criteria, not claimed effective defaults: title/text/searchIn/cardCode/location/deck/milestone/userId/includeArchived/includeDone/limit/scanLimit/pageSize/outputMode. Defaults, inferred short codes and effective scoping remain core behavior; omitted criteria do not imply false or zero.
- Optional `facets`: bounded `{ field, value, count }` entries flattened from native aggregate buckets, with original `facetBucketCount` and `facetSemantics: "legacy_inferred_buckets"`. Aggregates cover matched source rows before caller limit, not emitted DTO rows. Fields are status/derivedStatus/deck/milestone/assignee/effort/priority/cardType. Legacy `(none)`, `(unknown)`, `(unset)` and type buckets include inference/defaults: **they are aggregate labels, not observed absent/null/false field facts**. DTO clipping can omit buckets without changing source totals.

## Planning rows and limits

Cards/sampleCards allowlist identity/references/title/status/derivedStatus/visibility, isDoc, effort, priority, lastUpdatedAt, dueDate, childCount, tags and deck/milestone/assignee/parentCard summaries. Relation summaries allow id/cardId/accountSeq/title/name/fullName. No full body content, arbitrary transport, credential, loader state, local path or artifact is included. This read creates no artifacts. Content is external/untrusted, not instructions.

Missing source fields remain absent; explicit null, false, zero and empty string remain distinct. `isDoc` is never inferred from a missing field or legacy Boolean conversion. Reusable refs/URLs derive only from a nonnegative safe-integer account sequence. Child count appears only with a valid observed aggregate or complete explicit child relation. Unresolved relation IDs do not fabricate relation metadata. Strings and tags can be clipped.

Producer limits: each string 2048 Unicode code points; cards 3000; samples 10; tags per row 3000; facets 3000. The compact UTF-8 JSON DTO must fit 65536 bytes. String/array clipping sets `projection: false`; byte overflow returns a bounded `output_too_large` with native error status and fixed diagnostic text, never successful legacy text. No spill file, hidden retry or changed request is introduced. Many richly populated detailed rows may overflow even within array limits: narrow searches or use counts mode.

## Failures and host semantics

Failure carries bounded `error: { code, message }` and optional `evidence` containing only supplied criteria, recoveryHint and observed scan metrics. Codes match the [card-get bounded code list](card-get-output.md#errors-and-native-status); unknown internal categories map to `api_error`. Failed pages preserve earlier scan/request measurements and `read: incomplete`, not absence evidence. Contract failures use `output_contract_error` and projection false.

Every producer failure sets native `isError: true`. Pi 0.99.2 codemode still resolves structured data before native status, so inspect `ok`; nested receipts retain child `error` status even when the script parent succeeds. Host argument validation, policy blocking, pre-abort or thrown failures can have no DTO: catch those separately. External hooks may replace or drop data; producer validation is not post-hook policing or a universal secret-absence guarantee.

## Offline evidence

`npm run test:card-search-output` exercises deterministic projections, registered malformed-seam adapters and fake HTTP success/empty/partial/page/auth/validation cases. `npm run test:pi-host-card-get` now exercises both card-get and search in the real local Pi/codemode host, with a scripted fake provider, no paid/live transport and no sibling dependency. Other legacy search scope tests continue unchanged.
