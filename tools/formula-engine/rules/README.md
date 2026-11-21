# rules/

The formula engine's DATA: what a person can put in a filter rule, and the limits every evaluation is held to. The engine (`../crates/formula-engine`) reads both into its build; a request may bring comparison rows of its own.

## Files

| File | Purpose |
|------|---------|
| `rule-operators.json` | Every comparison and group combinator: id, label, chip text, icon, `input` shape, `applies_to` field kinds, and the binding template (`each`, `parts`, `negate`, `param_case`, `param_form`, `field_params`) |
| `variants.json` | The formulas a workflow step with variants runs on, each as text and as the binding compiled from it: `leader` and `choose` (the split rule: run every variant short of `min_runs`, on `explore_share` of the runs the leader and the other variant with the fewest runs, otherwise the leader), `records`, `winner`, `winner_output` and `none_passed`; and the split rule's numbers every step uses unless it gives its own. Compiled by `tools/write-a-job-done-in-several-steps-have/read-data/compile-variant-formulas.mjs`; `test/variants.test.mjs` fails while a text and its binding differ |
| `evaluation-guards.json` | Max depth, max parts, pattern length and repeat counts, work (rows x binding weight, known before a call starts), wall time between row slices (a formula past it is paused for `slow_ms`), and each refusal's words |

## Adding a comparison

Add one row to `rule-operators.json` with a binding template over existing ops-core operators (`op:core.*`), then rebuild the engine (`node tools/build-engine-modules-for-web-hosts/build/build-formula-evaluator.mjs`). The compiler fills markers `{"$field":"path"}`, `{"$param":"name"}` and `{"$field_param":"name"}`; every caller that asks `listComparisons` lists the row for every field kind in `applies_to`.

A comparison with `field_params: ["text"]` treats that parameter as another field ID of the same kind; an unknown or unlike-kind reference leaves the rule unfinished.
