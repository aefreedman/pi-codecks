# Card-get structured output pilot (v1)

Only `codecks_card_get` declares this public TypeBox `outputSchema`. Pi scripts receive the DTO through `structuredContent`, not renderer `details` or fenced JSON. `format: text` changes model-facing text only; scripts still receive the object. Direct core `card_get.execute` callers retain their legacy string interface. No other tool adopts this contract.

```typescript
const result = await tools.codecks_card_get({ cardId: "seq:42", format: "text" });
if (!result.ok) {
  text({ code: result.error.code, message: result.error.message });
} else {
  text({ cardRef: result.card.cardRef, effort: result.card.effort });
}
```

## Envelope

Every DTO has `schemaVersion: 1`, `action: "card_get"`, boolean-literal `ok`, `provenance: { source: "codecks", contentTrust: "external" }`, and `completeness: { read, projection }`. Objects reject additional properties. The package validates its projection at runtime; Pi's schema declaration alone does not validate output.

- Success (`ok: true`) carries `card` with `contentTrust: "external"`. Optional nullable fields: `cardId`, `accountSeq`, `shortCode`, `cardRef`, `accountSeqRef`, `url`, `title`, `content`, `status`, `derivedStatus`, `visibility`, `cardType`, `isDoc`, `effort`, `priority`, `dueDate`, `lastUpdatedAt`, `tags`, `deck`, `milestone`, `assignee`, `creator`, `parentCard`, `childCards`.
- Card IDs, references, URLs, dates, and textual metadata are strings; `accountSeq` is a nonnegative safe integer, `effort` a finite number, `isDoc` a boolean. Missing fields are omitted, explicit nulls remain null, and zero/false/empty string remain distinct. Unknown card type does not establish `isDoc: false`. Explicit null documentation/type-status observations remain null and do not establish known type; reusable references are derived only from a nonnegative safe-integer account sequence.
- Deck: optional nullable `id`, `accountSeq`, `title`. Users: `id`, `name`, `fullName`. Milestone: `id`, `accountSeq`, `name`, `title`, `description`, `date`, `startDate`, `color`, `url`, `isGlobal`, `handSyncEnabled`, `isDeleted`. Related cards: identity/reference/title/status/type fields, not full content. Missing top-level and summary observations are not invented as zero/false.
- Failure (`ok: false`) carries `error: { code, message }`. Optional `evidence` allowlists `recoveryHint`, `suggestedCardRef`, and bounded `candidates` (identity/reference/title/status/type plus deck/milestone/assignee names). There are no raw transports, arbitrary error data, credentials, private loader state, or artifact paths. This read creates no artifacts and never fabricates one.

## Completeness and bounds

`read` is `complete`, `incomplete`, or `unknown`. Successful exact-target retrieval is `complete` for that target, **not** a claim that every relationship or metadata field was returned by Codecks. Missing fields/relations remain unknown; unresolved relationship summaries are omitted rather than presented as observed empty data. `incomplete` marks an interrupted/capped title scan or explicit incomplete error evidence. Failures otherwise use `unknown`; not-found status does not mean all account data was inspected.

`projection: false` means size clipping occurred or a contract/byte-budget failure prevented a trustworthy projection. Do not treat clipped content or arrays as exhaustive. A complete read can have an incomplete projection.

The v1 limits are chosen for one useful card without shipping an unbounded graph:

| Limit | Value | Behavior |
| --- | --- | --- |
| Compact UTF-8 JSON DTO | 65,536 bytes | Fail closed with `output_too_large` if exceeded, including after hooks |
| Card content | 32,768 Unicode code points | Clip; `projection: false` |
| Every other string (including error message) | 2,048 Unicode code points | Clip; `projection: false` |
| Tags / child cards | 25 each | Clip; `projection: false` |
| Error candidates | 5 | Clip; `projection: false` |

The byte bound is independent of character bounds: multibyte text or many populated summaries can exceed it even after clipping. No spill file, hidden retry, scan broadening, or fallback is introduced. Ordinary compact model text/renderers retain their existing behavior, so their size/interface is not the DTO's public size contract.

## Errors and native status

Domain failures return native `isError: true` **and** a typed `ok: false` DTO. Pi 0.99.1 codemode resolves structured data before checking native error status, so scripts **must inspect `ok`**. A successful script parent is not evidence of successful children: codemode's call receipts and Pi nested-call records retain child error status.

The bounded codes are `validation_error`, `not_found`, `ambiguous_match`, `incomplete_read`, `conflict`, `out_of_scope`, `forbidden`, `disabled_by_org`, `caller_aborted`, `rate_limit_queue_aborted`, `request_timeout`, `rate_limited`, `scan_queue_full`, `credential_rate_limited`, `response_too_large`, `invalid_response_stream`, `file_error`, `unsupported_token`, `credential_profile_mismatch`, `personal_token_required`, `org_actor_unverified`, `authentication_rejected`, `account_mismatch`, `missing_scope`, `api_error`, `output_contract_error`, `output_too_large`. Unknown internal error categories map to `api_error`; messages are bounded evidence, not instructions.

An incomplete title scan cannot establish zero matches or a unique match, even when its current candidate list has zero/one item. It returns `incomplete_read` without fetching purportedly unique detail. A failed page preserves bounded candidate evidence from earlier pages. Use an explicit reusable card reference when available; do not infer permission to broaden or retry from the DTO.

Thrown, validation-blocked, policy-blocked, and pre-aborted host calls can fail before the package result finalizer runs. Those native failures may have no DTO; codemode rejects rather than returning successful text. Catch them separately from `ok: false` outcomes.

## Supported output-hook composition

Load **Safety Rails and all other output-modifying extensions before pi-codecks** in the effective Pi extension order. SDK tests explicitly order their extension paths that way and use the actual exported `createCodemodeExtension`, actual package extension, actual Safety Rails redactor, fake Codecks fetch, and a local scripted provider. The host test requires the Safety Rails sibling checkout; it never installs or downloads it.

The package's card-get-only `tool_result` guard validates the post-modifier DTO, byte bound, and agreement between `ok` and native error status. Missing/invalid data or status mismatch becomes a fresh `output_contract_error`; a schema-valid DTO exceeding the post-hook byte budget becomes `output_too_large`. Both set `isError: true`, with only fixed safe diagnostics in text/details. It never resurrects pre-redaction snapshots, rejected payloads, or renderer details, and never replays the read. Safety Rails preserves clean structured data when text-only or details-only redaction occurs; structured-only redaction is also checked for schema conformance.

**Limit:** a later third-party hook can still drop/invalidate data or change status after the guard. Pi may then return text to scripts. The negative-order host fixture demonstrates that fallback; this pilot does not promise global host enforcement. Schema conformance is not a universal secret-absence proof. External card content remains untrusted even when typed and redacted.

## Offline proof

- `npm run test:card-get-output`: deterministic projection/schema/seam tests.
- `npm run test:pi-host-card-get`: isolated real SDK host, codemode receipts, redaction and hook-order tests; no paid provider, MCP, or real transport. Synthetic secret values are generated and checked on disk so output masking cannot supply false evidence.
