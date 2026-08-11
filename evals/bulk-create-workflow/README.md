# Bulk-create workflow behavioral eval

This package-owned eval checks whether agents apply the `using-codecks` bulk-create guidance without redundant approval prompts or unnecessary context expansion. It is separate from deterministic `npm test` because it invokes an agent and may incur provider costs.

## Success criteria

1. **Triggering:** report whether `using-codecks` loads for bulk-create planning and result interpretation, independently from workflow correctness; do not load it for unrelated Git work.
2. **Outcome:** distinguish complete success, preview-only scope, and partial outcomes accurately.
3. **Instruction fidelity:** dry-run before apply, accept exact prior authorization for a matching apply, never automatically replay uncertain or rejected records, and continue only definitely-unsent records.
4. **Efficiency:** treat an empty inline `results` array as no exceptional records and avoid reading the temporary artifact after ordinary full success.
5. **Safety:** the eval exposes no live Codecks tools or credentials and performs no tracker mutations.

## Run

```bash
npm run eval:bulk-create-workflow
npm run eval:bulk-create-workflow -- --condition available --trials 3
npm run eval:bulk-create-workflow -- --condition all --trials 3
```

Reports separate workflow, triggering, behavior, efficiency, and infrastructure dimensions. Missing skill activation does not fail an otherwise-correct workflow case because specialized tool descriptions may already provide sufficient guidance; negative controls still require correct non-activation.

Use one trial while changing cases and 3–5 trials before drawing behavioral conclusions. The fixture copy is isolation for file observations, not an OS security sandbox. Raw results and events remain opt-in and must not be committed.
