# Codecks dynamic tool-loading results

## Decision

The balanced condition is the supported production candidate. The final fresh-process GPT-5.6 run passed all 42 condition/case trials, preserved the required safety and selection behavior, and reduced the initial provider tool serialization by 85.23% relative to the untouched legacy provider baseline (and 88.35% relative to the safety-hardened all-active condition).

This evidence authorizes the package default, not any Codecks mutation. All live account checks were read-only and every package-exposed mutation was blocked before execution by the eval guard.

## Run

- Date: 2026-07-25
- Model: `openai-codex/gpt-5.6-luna:low`
- Pi: 0.82.1
- Conditions: all-active, balanced, loader-only
- Cases per condition: 14
- Trials per case: 1
- Final result: 42/42 passed
- Raw provider captures: deleted after each trial
- Account fixtures: supplied only through environment variables and not recorded here

## Outcome evidence

Each condition passed 14/14 cases. Structured get/search, formatted retrieval, milestone and Run reads, velocity reporting, resolvable discovery, and bounded missing-effort preview reached the intended public capability. Mutation-selection and negative cases completed without a Codecks mutation call. The final matrix mixes directed exact-tool contract cases with implicit/contextual user-like prompts for formatted presentation, milestone lookup, velocity, resolvable discovery, follow-up preparation, effort preview, and ambiguous conversations.

Outcome checks require the intended successful tool call, no tool or assistant error, and a final assistant outcome. They do not independently judge the prose quality of the returned summary.

## Selection evidence

Every loader count and exact activation-set check passed. Balanced kept `codecks_card_get` and `codecks_card_search` immediate, used one loader call for deferred cases, and activated only the requested capability or the reviewed resolvable discovery/reply pair. No case activated more than four tools. Raw fallback, deprecated alias, debug, ambiguous discovery, and non-Codecks controls passed their exclusions.

## Safety and context evidence

- No mutation tool was called in any final trial.
- The guard covered all registered card, milestone, Run, bulk, effort, status, priority, attachment, parent, raw-dispatch, and conversation writers.
- Unit coverage separately passed missing/foreign provenance, foreign loader/tool collisions, authenticated loader-result restoration, additive activation, compaction-safe mutation descriptions, and startup/reload/resume/fork restoration.
- The untouched pre-loader baseline remains frozen at 39 tools. The current all-active condition has 40 tools after the unreleased deck updater and now includes sink-authorization schema/guidance; it is measured separately below.
- Balanced deferred definitions omitted prompt snippets/guidelines while the loader retained universal policy and active definitions retained direct-use safety.

## Efficiency evidence

### Deterministic harness metadata

| Condition | Initial package tools | Complete serialized metadata chars | Reduction from untouched |
|---|---:|---:|---:|
| untouched legacy baseline | 39 | 38,478 | 0% |
| all-active (current sink-authorized schemas) | 40 | 53,369 | -38.70% |
| balanced | 3 | 6,408 | 83.35% |
| loader-only | 1 | 2,312 | 93.99% |

### Final provider traces

These recorded live traces predate the unreleased deck updater and sink-authorization schema additions and were not rerun; they remain historical loader evidence rather than measurements of the current 40-tool metadata.

| Condition | Initial provider tools | Initial serialized tool chars | Reduction from untouched | Provider requests (14 cases) | Mean wall time | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| untouched legacy baseline | 39 | 21,144 | 0% | — | — | — | — | — | — |
| all-active (safety-hardened descriptions) | 39 | 26,824 | -26.86% | 23 | 9,279 ms | 63,329 | 1,584 | 99,840 | 0 |
| balanced | 3 | 3,124 | 85.23% | 33 | 9,536 ms | 52,840 | 2,012 | 7,680 | 0 |
| loader-only | 1 | 817 | 96.14% | 35 | 9,425 ms | 40,356 | 1,931 | 0 | 0 |

Balanced added 10 provider requests across the 14-case matrix (0.71 per case) and 257 ms mean wall time relative to the safety-hardened all-active condition. Loader-only saved more initial context and happened to average 111 ms faster than balanced in this single-trial matrix, but added another two requests while imposing loader turns on immediate structured retrieval/search. The small wall-time difference is not statistically meaningful; the workflow tradeoff still supports balanced rather than loader-only as the default.

Token/cache fields are reported independently because provider cache accounting is not interchangeable with uncached input. The single-trial matrix is strong deterministic/behavioral pilot evidence, not a latency benchmark or statistical performance claim.

## Limits

- Live retrieval used one authorized configured account and one fixture value per required domain.
- No live card, milestone, Run, bulk, effort, status, priority, attachment, parent, or conversation mutation was authorized or attempted.
- Current mutation behavior is supported by exhaustive mocked final-dispatch sink tests (including direct confirmation and mismatch/replay zero-fetch assertions), not by a production write account.
- One model/trial per case was used; repeat trials are appropriate before a release if broader variance evidence is desired.
