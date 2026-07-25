# Codecks dynamic tool-loading eval

This package-local behavioral eval compares `all-active`, `balanced`, and `loader-only` in **fresh Pi 0.82 JSON subprocesses**. It is not a skill eval: sessions, skills, prompt templates, built-in tools, discovered extensions, and context files are disabled.

## Safety boundary

`mutation-guard.ts` blocks every package-exposed Codecks mutation at Pi's `tool_call` event, before the registered Codecks tool can execute or issue a network request. This includes `codecks_dispatch` because it can write. The matrix contains mutation-selection and fixture/preflight cases only; it does not authorize any live Codecks write.

Read-only cases use the account configured in the caller's environment. Run them only against an account where ordinary read access is authorized. Do not place credentials, fixture data, or provider captures in this directory.

## Matrix and measurements

`cases.json` is the committed source of truth. Each case declares its expected outcome, exact permitted loader activation set, maximum loader/tool behavior, execution class, and category-specific pass criteria. It covers immediate card retrieval/search, formatted presentation, milestone and Run reads, velocity, resolvable discovery, reviewed reply-pair selection, bulk-effort preview, mutation selection without execution, ambiguous discovery, raw fallback, no-operation, and non-Codecks negative controls.

The runner separately records outcome/tool checks, exact activation, mutation safety, initial provider tool serialization, provider request count, native deferred-tool markers when present, and wall time. `baseline.json` preserves the untouched 39-tool metadata measurement and deterministic harness measurements for all three implemented conditions.

## Run

Live runs require an explicit GPT-5.6 Codex family model. The runner rejects all other providers/models and creates a new Pi JSON subprocess for every condition/case/trial. Supply account-local read fixtures through `CODECKS_EVAL_CARD_ID`, `CODECKS_EVAL_CARD_TITLE`, `CODECKS_EVAL_MILESTONE`, and `CODECKS_EVAL_RUN_ID`; only selected cases require each value. Keep these values in the environment rather than committing account data.

```bash
npx tsx evals/tool-loading/run-eval.ts --dry-run
npx tsx evals/tool-loading/run-eval.ts --model openai-codex/gpt-5.6-luna --condition balanced
npx tsx evals/tool-loading/run-eval.ts --model openai-codex/gpt-5.6-terra:medium --cases immediate-structured-card-get,follow-up-reply-selection --trials 2
```

`--keep` retains raw provider payload captures in the system temporary directory; they are deleted by default. Sanitized summaries are written beneath ignored `results/`. `--include-events` adds only event type/tool-name crumbs to that summary.

A live runner requires the worktree-local Pi peer dependency on the `0.82.x` line. `--dry-run` validates the committed eval contract without contacting a model or requiring that peer dependency.
