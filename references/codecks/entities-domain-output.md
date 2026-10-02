# Entity structured output (v1)

The nine Deck, Milestone, Run and user tools return producer-validated structured data independently of their existing presentation format. Legacy direct `execute` remains text/JSON; internal `executePayload` returns `{text,payload}` from one operation. Scripts must inspect `ok`; errors also carry native `isError:true`. Permission/transport failures without a DTO (including the legacy user lookup's thrown failures) can reject instead.

## Reads

Closed tool-specific success envelopes contain `version:1`, the established hyphenated `action`, `ok:true`, `data`, `provenance` and `projection`. Errors replace data/provenance with bounded `error:{code,message}`. The schema owners are `entities-read-output.ts` and `entities-output-helpers.ts`.

- `deck-get`: observed Deck fields, not fallback title/empty description/deleted=false from legacy presentation.
- `milestone-get`: observed Milestone fields; existing deleted lookup restriction remains.
- `milestone-list`: extracted `sourceCount`, pre-slice `filteredCount`, projected `emittedCount`, source-slice `truncated`, and observed milestones.
- `run-list`: the same count distinctions and observed Run fields. No report statistics are exposed.
- `run-get`: observed Run/config fields and card facts, `cardRelation` (`observed` or `unavailable`), and `sourceCardCount` only when the relation was observed. These are hydrated relation observations, not a new exhaustive card scan.
- `user-lookup`: requested recent-card scan limit (not a fabricated observed scan cardinality), candidate/matched/projected emitted counts and deduplicated observed users. Empty samples are successful reads. This is recent-card assignee/creator evidence, not an account directory.

`provenance.exhaustive:false` and `sourceCompleteness:"unverified"` deliberately avoid claiming global/token-visible collection completeness that the existing extraction helpers do not prove. Source counts refer to locally extracted records, not hidden account totals. Projection completeness is separate from source scope and slice truncation. Run name-search preserves its established first-match behavior, not a new uniqueness guarantee.

Absent fields stay absent; explicit null, false, zero and empty strings stay observed facts. Derived reusable Milestone/Run references require positive safe account sequences and matching Codecks URLs. Identities are validated without clipping. No raw transports, renderer summaries, report cache or private error details are public fields.

## Mutations

`deck-update`, `milestone-update` and `run-update` use distinct closed schemas in `entities-write-output.ts`. Success data includes target identity, requested field values, dispatched field names and applicable clear indicators. Deck/Milestone clearing sends an empty description; clearing a Run custom label sends `name:null`. The acknowledgment is **not readback**, an observed content change, or proof of an actual no-op. No-fields validation still dispatches nothing; requesting an existing value still uses the original dispatch.

All mutation outcomes contain `effect`:

- `not_dispatched`: this mutation was not sent (resolution queries may already have occurred).
- `definitely_rejected`: canonical transport supplied definitive rejection evidence.
- `dispatch_returned`: dispatch returned successfully, without independent readback.
- `indeterminate`: the sent mutation's effects are unknown.

`readback:false` and `replaySafe:false` apply throughout. Contract/byte failures after a returned dispatch retain that certainty and a valid bounded observed target. Invalid/missing effect evidence fails conservatively to indeterminate. Output failure never authorizes replay. No new resolution requests, reads, retries or artifacts are added.

## Bounds and producer boundary

`ENTITY_OUTPUT_LIMITS`: 65,536 compact UTF-8 JSON bytes per complete DTO, inclusive; descriptions 32,768 Unicode code points; other presentation strings 2,048; identities 128; entity/card arrays 500; user arrays 5,000. Clipping factual strings/arrays sets `projection.complete:false`; emitted counts reflect projected lists while filtered/matched/source counts remain unchanged. Identity/reference invalidity fails with `output_contract_error`; byte overflow fails with `output_too_large`, without hidden files, requests or splitting. Every object schema is closed; no arbitrary transport fields are accepted.

Producer validation ends at the canonical execute adapter. Foreign result hooks and Pi composition are not policed. Actual host/composition integration is a separate package integration gate; this reference does not claim CLI/RPC/live transport execution.
