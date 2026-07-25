# Codecks dynamic tool-loading results

## Decision

The balanced condition is the supported production candidate. The final fresh-process GPT-5.6 run passed all 42 condition/case trials, preserved the required safety and selection behavior, and reduced the initial provider tool serialization by 85.23% relative to all-active.

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
- All-active reproduced the untouched 39-tool metadata measurement exactly.
- Balanced deferred definitions omitted prompt snippets/guidelines while the loader retained universal policy and active definitions retained direct-use safety.

## Efficiency evidence

### Deterministic harness metadata

| Condition | Initial package tools | Complete serialized metadata chars | Reduction from untouched |
|---|---:|---:|---:|
| all-active | 39 | 38,478 | 0% |
| balanced | 3 | 6,095 | 84.16% |
| loader-only | 1 | 1,999 | 94.80% |

### Final provider traces

| Condition | Initial provider tools | Initial serialized tool chars | Reduction vs all-active | Provider requests (14 cases) | Mean wall time | Input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| all-active | 39 | 21,144 | 0% | 23 | 8,833 ms | 51,193 | 1,503 | 95,744 | 0 |
| balanced | 3 | 3,124 | 85.23% | 33 | 9,243 ms | 52,714 | 1,969 | 7,680 | 0 |
| loader-only | 1 | 817 | 96.14% | 35 | 9,328 ms | 40,364 | 1,890 | 0 | 0 |

Balanced added 10 provider requests across the 14-case matrix (0.71 per case) and 409 ms mean wall time relative to all-active. Loader-only saved more initial context but added another two requests and 85 ms mean wall time over balanced while imposing loader turns on immediate structured retrieval/search. This supports balanced rather than loader-only as the default.

Token/cache fields are reported independently because provider cache accounting is not interchangeable with uncached input. The single-trial matrix is strong deterministic/behavioral pilot evidence, not a latency benchmark or statistical performance claim.

## Limits

- Live retrieval used one authorized configured account and one fixture value per required domain.
- No live card, milestone, Run, bulk, effort, status, priority, attachment, parent, or conversation mutation was authorized or attempted.
- Mutation behavior is supported by selection traces, the pre-network guard, unit fixtures, and existing core/schema checks rather than a production write account.
- One model/trial per case was used; repeat trials are appropriate before a release if broader variance evidence is desired.
