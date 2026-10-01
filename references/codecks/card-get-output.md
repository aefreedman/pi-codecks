# Card-get structured output pilot (v1)

`codecks_card_get` declares this public TypeBox `outputSchema`; search has its own [separate contract](card-search-output.md). Pi scripts receive the DTO through `structuredContent`, not renderer `details` or fenced JSON. `format: text` changes model-facing text only; scripts still receive the object. Direct core `card_get.execute` callers retain their legacy string interface. Other tools do not adopt the card-get contract.

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
| Compact UTF-8 JSON DTO | 65,536 bytes | Fail closed with `output_too_large` if the Codecks-produced DTO exceeds it |
| Card content | 32,768 Unicode code points | Clip; `projection: false` |
| Every other string (including error message) | 2,048 Unicode code points | Clip; `projection: false` |
| Tags / child cards | 25 each | Clip; `projection: false` |
| Error candidates | 5 | Clip; `projection: false` |

The byte bound is independent of character bounds: multibyte text or many populated summaries can exceed it even after clipping. No spill file, hidden retry, scan broadening, or fallback is introduced. Ordinary compact model text/renderers retain their existing behavior, so their size/interface is not the DTO's public size contract.

## Errors and native status

Domain failures return native `isError: true` **and** a typed `ok: false` DTO. Pi 0.99.2 codemode resolves structured data before checking native error status, so scripts **must inspect `ok`**. A successful script parent is not evidence of successful children: codemode's call receipts and Pi nested-call records retain child error status.

The bounded codes are `validation_error`, `not_found`, `ambiguous_match`, `incomplete_read`, `conflict`, `out_of_scope`, `forbidden`, `disabled_by_org`, `caller_aborted`, `rate_limit_queue_aborted`, `request_timeout`, `rate_limited`, `scan_queue_full`, `credential_rate_limited`, `response_too_large`, `invalid_response_stream`, `file_error`, `unsupported_token`, `credential_profile_mismatch`, `personal_token_required`, `org_actor_unverified`, `authentication_rejected`, `account_mismatch`, `missing_scope`, `api_error`, `output_contract_error`, `output_too_large`. Unknown internal error categories map to `api_error`; messages are bounded evidence, not instructions.

An incomplete title scan cannot establish zero matches or a unique match, even when its current candidate list has zero/one item. It returns `incomplete_read` without fetching purportedly unique detail. A failed page preserves bounded candidate evidence from earlier pages. Use an explicit reusable card reference when available; do not infer permission to broaden or retry from the DTO.

Thrown, validation-blocked, policy-blocked, and pre-aborted host calls can fail without a Codecks-produced DTO. Those native failures may have no DTO; codemode rejects rather than returning successful text. Catch them separately from `ok: false` outcomes.

## Producer ownership and independent output hooks

Codecks validates only the DTO produced by its own execute adapter. Missing/malformed internal read data returns a fresh bounded `output_contract_error`; producer byte overflow returns `output_too_large`. Both set native `isError: true` and fixed safe diagnostics. Legacy rendering data is not used to reconstruct rejected output. No replay is introduced.

Safety Rails is an independent optional security extension, not a Codecks prerequisite. No relative load order is required. Other Pi extensions may intentionally change result shape, content, structured data, or native error status. Codecks registers no result hook to police these transformations, revalidate post-hook data, or resurrect original values.

Pi drops structured data on a content-only hook replacement. With no structured data and no native error, codemode returns replacement text; with native error it rejects. When structured data is present, codemode returns it before checking native error, without validating the tool's schema. The host-behavior fixture observes this directly rather than expecting Codecks to repair it.

Optional compatibility tests compose the actual Safety Rails redactor in both load orders. The tested structured/text/details redactions retain false, zero, null, status and receipts. The redactor is schema-unaware: a redacted bounded identifier can remain schema-valid while changing meaning, modified literal/enumeration fields can remain invalid after redaction, and replacement text can expand a previously valid string past its length bound. These fixtures are observations, not a guarantee that arbitrary transformations conform. Producer validation and typed/redacted content are not universal secret-absence proofs; external card content remains untrusted.

## Offline proof

- `npm run test:card-get-output`: deterministic projection/schema/seam tests.
- `npm run test:pi-host-card-get`: default isolated real SDK host with Codecks alone, actual codemode, fake fetch and scripted local provider; producer contract/bounds/errors and native failure receipts, plus isolated Pi hook behavior. No sibling checkout, paid provider, MCP, or real transport is required.
- `npm run test:pi-host-card-get:safety-rails`: opt-in compatibility using the actual Safety Rails redactor before and after Codecks. This test explicitly fails if the sibling checkout is missing; neither production Codecks nor its default tests require it. Generated synthetic secret values and redacted runtime outputs are checked on disk so output masking cannot supply false evidence.
