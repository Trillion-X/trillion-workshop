# tools/write-a-job-done-in-several-steps-have/

Write a job done in several steps, have my AI and tools answer each step, and keep every answer.

## What runs here

`tool:run-workflow-definition` (`what-this-tool-does-and-how-to-run-it.json`, kit `kits/run-workflow-definition.json`) runs a person's workflow on the workflow engine in one call. Give it engine definitions and a `workflow_id`, or a recipe (or the person's `record:workflow-recipe` row with its `record:workflow-step` rows), the run's input and the answers known so far. It returns the run: `paused` with `waiting` naming the steps that have no answer yet, `completed`, or `failed` with the engine's own words. Nothing is kept: the caller keeps the answers and calls again with them.

- `read-data/run-a-workflow.mjs`: `runAsTheTool` (the tool: `{run, woken_by}`, the waking fact given to a woken run as `input.fact` and the event id the engine admitted it under as `input.fact_id`, with `folded` and `last` when later facts folded into it; run by records-door's run-an-export.mjs, so a `tool:` ask runs through the run's own door in the same call and only the other asks wait), `runWorkflow` (the run itself), `runAWorkflow` (a recipe or its rows, run), `workflowEngine` (the built engine, `tools/build-engine-modules-for-web-hosts/built-stored-bytes/workflow-engine`), `kitOf` (the kit a run carries, chosen before the engine runs, never inside it).
- `read-data/workflows.mjs`: the older version's `src/workflows.mjs`, moved whole (`moved-from.json`), with its imports pointed at this repository and its stores, sources and engine given to `makeWorkflows`. `definitionOf` makes a recipe a definition: each step an ask of the tool the step runs or, when it runs none, of the run's own actor (`RUN_ACTOR`, the engine binding `context.actor.user_id`), then, for a step with checks, the steps that judge them (below), joined by edges; a recipe holding its own `definition` runs as that definition.
- The engine runner is `tools/run-a-workflow-definition-on-the-workflow-engine-in-one-call`.
- `read-data/variants.mjs`: a step with `variants` (in ordered steps, or a definition step of kind `variants`): several ways of doing one step, each a `run_tool` or a `do` ask with its own checks, run side by side (`mode: "all"`) or split by what has worked (`mode: "split"`), compared on one `measure` (`{ binding over steps "answer", best: "max" | "min" }`), and kept as one `variant_results` row per variant per run in the pursuit's database the step names (`keep_in`). `then` is one next step or a next step per variant. `definitionOf` compiles it into ordinary engine steps, so the engine has no variants kind:
  - `S#table` makes `variant_results` when it is not there, and in split mode `S#tally` reads the kept runs per variant, `S#lead` names the leader and `S#choose` the variants this run runs (the split rule runs every variant until each has `min_runs` kept runs, then the leader, and on `explore_share` of the runs the leader and the other variant with the fewest runs; the rule and its numbers are formulas and DATA in `tools/formula-engine/rules/variants.json`; a step may give its own numbers in `split`).
  - `S#each` is a parallel loop over the variants run, each its own used definition `S#<variant>`: its ask, its checks as steps (a broken rule or a failed tool gives that variant a failed record; it never stops the others), and its record.
  - `S#compare` answers `{ variants: [{ variant, status, checks_passed, failed_check, measure, duration_ms, cost, tokens, summary }], winner }` with no variant's whole answer in it, so it stays small; `S#keep` writes the rows; `S` itself answers the winner's whole answer, so a later step binds it as any step; `S#none` fails the run, naming each variant's failed check, when none passed; `S#route` leads to the winner's next step for a then map.
  - cost and tokens are null until the engine's step outputs carry them.
- `read-data/variant-results.json`: the SQL those steps run (make the table, tally, keep), one statement each.
- `read-data/compile-variant-formulas.mjs`: writes each formula of `variants.json` as the binding the formula engine compiles its text into (run it after changing a formula's text).

A step's checks run on the engine as ordinary steps, made by `tools/workflows/read-data/check-bindings.mjs` from each check's kind row in `tools/workflows/recipe-check-kinds.json`. The rows hold the bindings, so the engine has no check kind and the one shared evaluator judges them:
- `<step>#checks` is a `return` step whose `held` says, rule by rule, whether each holds.
- Only when one does not, `<step>#wrong` lists the values that break each rule, and `<step>#refused` (a `fail` step) names each failing rule with up to eight of them.
- A kind that looks things up (exists, lane-jobs) first runs a `loop` of `read`s. Its one-step definitions travel in the definition's `uses`.

Every kind with a binding runs, including differs-from, field-in and fields-present. cites-resolve and slotted-runs have no binding row yet, so a recipe naming them is refused when it is made into a definition.

## Test

```
node --test tools/write-a-job-done-in-several-steps-have/test/run-a-workflow.test.mjs
node --test tools/write-a-job-done-in-several-steps-have/test/variants-in-one-step.test.mjs
```

## The older version's files

The older version (commit b6ae0ebf81 of the older repository: `src/workflows.mjs` and its two test files) is adapted into `read-data/workflows.mjs`, and its checks are ported as tests in `test/`. Its bytes are removed from this folder. They stay in Workshop history at a6b9518c1 and in the older repository at b6ae0ebf81. The judgement, with file and line evidence, is the research row `verify-every-port/write-a-job-done-in-several-steps-have`:

- Kept: recipe validity and check refusals (`recipeProblems`), one-call runs, tool asks, waiting asks, and the web route table.
- Retired: the `agent:<id>` ask (commit 0f995f919, Nov 19 2026), and the saved-recipe store layer (commit 951b17e9a, Nov 18 2026, rule K6).
- Not carried here yet, each a calendar task under `record:calendar-task:verify-every-port-write-a-job-done-in-several-steps-have`: persisted runs (resume, stop, snapshot), action checks at save and answer, the saved-workflow catalogue, skill-repository sources, the MCP workflow names that AIs are told to call, and the reader header name.
