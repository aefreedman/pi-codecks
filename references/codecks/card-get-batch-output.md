# Batch card retrieval output (v1)

`codecks_card_get_batch` returns a closed producer-validated `structuredContent` DTO independently of `format: text` or `json`. Direct-core `execute` still returns its existing text/fenced JSON; input aliases, renderers and request behavior are unchanged. Inputs contain 1–25 exact short-code/account-sequence references, with the existing parsing and length rules. Any UUID rejects the batch before querying. The upstream lookup remains deduplicated, with no single-card fanout.

## Shape and meanings

Both variants contain `schemaVersion: 1`, `action: "card_get_batch"`, `provenance: { source: "codecks", contentTrust: "external" }`, `completeness: { read: "complete" | "incomplete" | "unknown", projection: boolean }` and `ok`.

- Success (`ok: true`) requires `data` and has no `error`.
- Failure (`ok: false`) requires bounded `error: { code, message }` and may contain bounded partial `data`. Native `isError` is true too. Scripts must inspect `ok`; a structured error can resolve a codemode promise. Permission/thrown failures without a DTO can reject.
- Data contains `requested`, optional `uniqueReferences`, optional source `found`/`missing`, `projectedFound`, `projectionErrors` and `items`. Source counts include repeated inputs. Failed upstream lookups omit unobserved source counts rather than inventing zeroes.
- One item per valid input stays in original order, including duplicates. `requestedRef` is the existing trimmed input identity, never clipped.

Item variants:

| Status | Fields and evidence |
| --- | --- |
| `found` | `requestedRef`, `status`, `card`: the complete [card-get success DTO](card-get-output.md), not just its card field. |
| `missing` | `requestedRef`, `status`: absence established by a completed lookup. An all-missing completed lookup succeeds. |
| `failed` | `requestedRef`, `status`: the lookup failed after existing operation accounting recorded a dispatched request; not evidence of absence. |
| `unqueried` | `requestedRef`, `status`: failure before dispatch; not evidence of absence. |
| `projection_error` | `requestedRef`, `status`, `error`: the bounded card-get error DTO for a found source card that failed projection/size validation. |

Any projection-error item makes the batch `ok:false`/native error with code `output_contract_error`. Its item may carry `output_too_large`. Source `found` remains unchanged; `projectedFound + projectionErrors = found`. Read completeness remains `complete` after a completed lookup even when projection fails. No item is silently dropped. Ordinary field clipping is explicit `completeness.projection:false`, not an upstream failure.

## Bounds

- At most 25 items; input/reference parsing and the existing 128 UTF-16-code-unit input limit are unchanged.
- Each embedded card-get DTO obeys its existing scalar/array/content limits and **65,536 compact UTF-8 JSON bytes**, including its metadata. Missing, null, false and zero observations and nested absence are retained. Reusable identities must not be clipped; oversized identities produce an explicit projection error.
- The entire batch DTO, including repeated inputs and metadata, is limited to **2,097,152 compact UTF-8 JSON bytes**. The ceiling is inclusive. Overflow returns bounded `output_too_large`; no artifact spill, splitting, retry or extra request follows.
- The current 25-card/per-card bounds leave normal valid projections below the defensive full-batch ceiling. Tests separately exercise the independent full-byte predicate at its exact Unicode boundary; they do not claim a normal valid operation can reach that ceiling.

```javascript
const result = await tools.codecks_card_get_batch({ cardIds: ["seq:0", "seq:1", "seq:0"], format: "text" });
if (!result.ok) { text(result.error); }
if (result.data) {
  for (const item of result.data.items) {
    if (item.status === "found") text({ ref: item.requestedRef, title: item.card.card.title });
    else text({ ref: item.requestedRef, status: item.status });
  }
}
```

## Producer and host boundaries

Projection consumes native operation observations, not rendered text, raw transports or private details. Legacy details remain renderer-owned. Codecks validates its own output only; foreign result hooks can replace/remove structured data and Pi does not revalidate it. There is no security-extension prerequisite.

Offline tests cover direct registration, actual standalone Pi/codemode, non-codemode `ctx.executeTool`, SDK final execution events and JSON event conversion/serialization. JSON CLI and RPC wire clients are not exercised by these tests. The full DTO reaches scripts before their independent printed-output budget. Ordinary tool-result transcript messages do not persist `structuredContent`, and nested DTOs do not become separate transcript entries. No credential, raw query or private artifact reference is part of this public DTO.
