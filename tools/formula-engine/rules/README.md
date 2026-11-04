# rules/

Filter rules as DATA: a person's rule tree compiles to one composition-ast binding, and the formula engine's row evaluator runs it.

## Files

| File | Purpose |
|------|---------|
| `rule-operators.json` | Every comparison and group combinator as DATA: id, label, chip text, icon, `input` shape, `applies_to` field kinds, and the binding template (`each`, `parts`, `negate`, `param_case`) |
| `compile-rules.mjs` | Rule tree -> binding by filling templates; reports unfinished rules; names no field or operator |
| `evaluate-over-rows.mjs` | Loads `../built-stored-bytes/evaluate-over-rows` from caller-supplied wasm bytes; `filterRows(rows, binding)`, or `replaceRows`/`patchRows`/`filter` for a host that owns the table |
| `evaluation-guards.mjs` / `evaluation-guards.json` | The guards every evaluation passes in `evaluate-over-rows.mjs`: max depth, max parts, cycles, regex pattern length and repeat counts, work (rows x binding weight, the budget that holds where the clock stops while code runs, a Worker) and wall time between row slices (a formula past it is paused for `slow_ms`). Refusals are `Error` with `code: 'formula_guard'`, `guard`, `limit` |
| `filter-records.mjs` | `createRecordFilter({operators, wasmBytes})` -> `(records, tree, fields) => records`: one-call filtering of a list a host already holds; reads only the fields the rules name |
| `index-records.mjs` | `createRecordIndex({operators})` -> `(records, fields) => {decide(tree)}`: decides a tree over a held list with per-field bit-set columns (value -> records) built once; answers exactly what the evaluator answers, or `null` for a comparison it does not recognise |
| `index-records.test.mjs` | The index against the real evaluator on 2,000 random trees (three-state and/or/not, unknown values); a one-tag and a two-rule pick over 23,663 records each under 200 ms |
| `rules.test.mjs` | and/or/not, nested groups, ranges, multi-select, transcript contains, unfinished rules, patches, record filtering, all through the real wasm |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| rule tree group | `{kind:"group", combinator, negate, rules:[node]}` | AND/OR group, optionally negated, nestable |
| rule | `{kind:"rule", field, operator, params}` | params: `{values}`, `{value}`, `{text}`, `{min?,max?}` or `{}` by operator `input` |
| field descriptor | `{id, kind, path?}` | `kind` selects the operators (`applies_to`); `path` defaults to `[id]` |
| `createRecordFilter({operators, wasmBytes})` | `-> (records, tree, fields:{id,kind,value(record)}[]) => records` | Filter a held list (a schedule's posts) with the evaluator |
| `ruleVocabulary(operatorData)` | `-> {operators, combinators, operatorsFor(kind), firstCombinator}` | Lookups over the DATA |
| `resolveRule(rule, fieldsById, vocabulary)` | `-> {field, operator, params, fieldParams} \| null` | The one decision of which rules count (shared by the compiler and the index) |
| `createRecordIndex({operators})` | `-> (records, fields) => {decide(tree): records \| null}` | Instant filtering of a held list; null hands the tree back to the evaluator |
| `compileRules(tree, {fields, vocabulary})` | `-> {binding \| null, reads, incomplete}` | Null binding = every row |
| `emptyRuleGroup(vocabulary)` | `-> group` | Starting tree |
| `loadRowEvaluator(wasmBytes)` | `-> {replaceRows, patchRows, filter, filterRows, evaluate}` | Evaluator in any JS host |

## Adding a comparison

Add one row to `rule-operators.json` with a binding template over existing ops-core operators (`op:core.*`). No code changes: the compiler fills markers `{"$field":"path"}` and `{"$param":"name"}`, and the UI lists the row for every field kind in `applies_to`.

A comparison with `field_params: ["text"]` treats that parameter as another field ID of the same rule kind. `{"$field_param":"text"}` fills its path; both fields are validated and retained in the evaluator input. Unknown or unlike-kind references leave an incomplete rule. `matches_field` uses existing core operators to compare exact non-null values, including case, so a mandatory public List rule can compare current content with its reviewed snapshot. `at_least_field` compares numbers or dates through the existing maximum and equality operators, so a shared copy can require its read-time clock to have reached the row's date. Missing operands never pass either comparison.

## Tests

```bash
node --test packages/formula-engine/rules/rules.test.mjs packages/formula-engine/rules/index-records.test.mjs
```

## Why an index beside the evaluator

The evaluator reads every row for every question: about 400 ms for 23,663 records in a page. A tag, kind or project pick is a set question, so the index answers it from bit sets read once per list (a few milliseconds). It recognises only the set-shaped templates (`in_list`, `index_of >= 0`, `is_empty`, joined by `op:core.and`/`op:core.or`/`op:core.not`) and hands anything else back, so the evaluator stays the meaning of every comparison.

## Dependencies

**Depends on:** `../built-stored-bytes/evaluate-over-rows` (built by `../evaluate-over-rows/build.mjs`).

**Depended on by:** `packages/ui/show/rule-filter` (builder UI), the Expansion Library's in-page filtering (`dev/media-workspace/library-page-filter.mjs`, the index), `packages/ui/show/record-views`, the Expansion Library filter worker (`dev/media-workspace/library-facts-worker.mjs`), the Schedule filter in the page (`dev/media-workspace/record-filter-loader.ts`), and retention rules (`dev/media-workspace/retention-rules.mjs`).
