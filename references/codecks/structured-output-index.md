# Structured output contracts

42 specialized tools provide producer-validated, closed versioned success/error DTOs through Pi `outputSchema`/`structuredContent`. Seven tools are deliberately excluded below; no established tool is pending. Legacy core text/JSON calls, input schemas, activation, defaults/aliases and renderers remain unchanged. Native failures set `isError:true`; codemode may resolve an `ok:false` DTO, so inspect `ok` before using data. Without a DTO, blocked/native failures may reject instead.

## Domain contracts and limits

- [Card get](card-get-output.md), [search](card-search-output.md), [batch](card-get-batch-output.md): accepted single-card contracts remain unchanged. Batch retains input order/duplicates and deduplicated requests; found/missing/failed/unqueried/projection_error are distinct. Each embedded card is limited to 65,536 compact UTF-8 bytes; complete batch to 2,097,152 bytes (2 MiB). Overflow never drops items, spills, retries or splits implicitly.
- [Remaining cards](cards-domain-output.md): 65,536-byte reads/single writes; 2-MiB bulk receipts. Board DTOs contain metadata, not optional raw payload. Bulk keeps every indexed outcome, full valid fingerprints and genuine artifacts. Bounded fallback exposes `omittedEvidence`, `omittedEvidenceCount` and `metricsSummary` with explicit native-metrics/derived-event-count provenance; omitted requested fields are not claimed as exact requests.
- [Entities](entities-domain-output.md): 65,536-byte outputs. Token-visible extracted entities and sampled users are not exhaustive directories; source completeness remains unverified.
- [Conversations](conversations-domain-output.md): 65,536-byte reads and 16,384-byte write receipts. Thread content is external/untrusted; actionable inbox results are heuristic recent scans, not exact unread/subscription state. Missing relation/detail observations cannot prove absence.
- [Reports](reports-domain-output.md): 65,536-byte Run DTOs; 262,144-byte file/report DTOs. Finish observations stay distinct from calculated/current statistics. Cache/report receipts expose bounded facts and genuinely written workspace-relative artifacts, not raw caches or provider/filesystem internals.

Limits are inclusive compact JSON UTF-8 byte ceilings, independent of Pi's printed-output/context budget. String/array clipping marks projection incomplete. Missing, null, false and zero remain distinct facts; reusable references require valid original identities and are never clipped into substitutes. Read success, source completeness, emission and projection completeness are separate; complete-empty, partial and failed evidence must not be conflated.

## Effects and consumer boundaries

Mutation acknowledgment is not readback. Receipts preserve definitive rejection, definitely-unsent/not-dispatched and indeterminate/possibly-applied effects according to domain vocabulary. Hand readback/drift, bulk fingerprints/per-record outcomes and file phases remain native operation evidence. Projection/serialization errors after a send do not prove nothing changed. No receipt authorizes replay; reconcile target, effect, artifact and existing readback evidence before any separately authorized next operation. Later report-file failure retains earlier genuinely written artifacts, never invents unwritten ones.

Producers capture allowlisted native operation facts, not parsed rendered text, private details/rawResult or arbitrary transport payloads. Registration invokes exactly one canonical operation with unchanged requests, 40-per-five-second pacing, cooldown/scan queue, cancellation, three ALS scopes, operation credential memoization and ORG/PERSONAL restrictions. No new requests/readbacks/retries or limiter/cache owner are introduced.

Validation ends at the Codecks execute adapter. Pi and foreign hooks own later composition and may change status/shape or remove DTOs; there is no post-hook enforcement or Safety Rails/load-order requirement. Native SDK final events and direct/codemode/non-codemode nested consumers receive DTOs; ordinary toolResult transcript messages do not persist a separate structuredContent field. SDK JSON-event conversion is tested; JSON CLI and RPC wire consumers are not tested. These are synthetic offline guarantees, not live Codecks/credential-provider evidence.

## Exact established roster

| Tool | Disposition | Contract owner / exclusion reason |
| --- | --- | --- |
| `codecks_card_get` | migrated | cards |
| `codecks_card_search` | migrated | cards |
| `codecks_card_get_batch` | migrated | cards |
| `codecks_card_list_missing_effort` | migrated | cards |
| `codecks_card_list_done_within_timeframe` | migrated | cards |
| `codecks_card_get_vision_board` | migrated | cards |
| `codecks_card_create` | migrated | cards |
| `codecks_card_set_parent` | migrated | cards |
| `codecks_card_update_run` | migrated | cards |
| `codecks_card_add_attachment` | migrated | cards |
| `codecks_card_update` | migrated | cards |
| `codecks_card_update_status` | migrated | cards |
| `codecks_card_add_to_hand` | migrated | cards |
| `codecks_card_remove_from_hand` | migrated | cards |
| `codecks_card_update_effort` | migrated | cards |
| `codecks_card_update_priority` | migrated | cards |
| `codecks_card_bulk_create` | migrated | cards |
| `codecks_card_bulk_update` | migrated | cards |
| `codecks_deck_get` | migrated | entities |
| `codecks_deck_update` | migrated | entities |
| `codecks_milestone_list` | migrated | entities |
| `codecks_milestone_get` | migrated | entities |
| `codecks_milestone_update` | migrated | entities |
| `codecks_run_list` | migrated | entities |
| `codecks_run_get` | migrated | entities |
| `codecks_run_update` | migrated | entities |
| `codecks_user_lookup` | migrated | entities |
| `codecks_card_add_comment` | migrated | conversations |
| `codecks_card_add_review` | migrated | conversations |
| `codecks_card_add_blocker` | migrated | conversations |
| `codecks_card_add_block` | migrated | conversations |
| `codecks_card_reply_resolvable` | migrated | conversations |
| `codecks_card_edit_resolvable_entry` | migrated | conversations |
| `codecks_card_close_resolvable` | migrated | conversations |
| `codecks_card_reopen_resolvable` | migrated | conversations |
| `codecks_card_list_resolvables` | migrated | conversations |
| `codecks_list_open_resolvable_cards` | migrated | conversations |
| `codecks_list_logged_in_user_actionable_resolvables` | migrated | conversations |
| `codecks_velocity_observations_update` | migrated | reports |
| `codecks_velocity_report` | migrated | reports |
| `codecks_run_delivered_effort` | migrated | reports |
| `codecks_run_average_effort` | migrated | reports |
| `codecks_card_get_formatted` | excluded | Presentation-specific wrapper |
| `codecks_query` | excluded | Arbitrary raw query fallback |
| `codecks_dispatch` | excluded | Arbitrary raw dispatch fallback |
| `codecks_debug_logged_in_user_resolvable_participation` | excluded | Optional diagnostic/private-schema probe |
| `codecks_debug_logged_in_user_resolvables` | excluded | Optional diagnostic/private-schema probe |
| `codecks_profile_select` | excluded | Profile/auth selection outside domain contracts |
| `codecks_tool_search` | excluded | Discovery/activation outside domain contracts |

Excluded tools retain their existing availability/behavior and are not counted as migrations. All schema/projector/seam contributions are explicitly checked by the package inventory; every migrated domain contribution has direct synthetic behavioral coverage.
