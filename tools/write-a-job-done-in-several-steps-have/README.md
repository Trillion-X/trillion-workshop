# tools/write-a-job-done-in-several-steps-have/

Write a job done in several steps, have my AI, agents and tools answer each step, and keep every answer.

## What runs here

`tool:run-workflow-definition` (`tool-rows.json`, kit `kits/run-workflow-definition.json`) runs a person's workflow on the workflow engine in one call. Give it engine definitions and a `workflow_id`, or a recipe (or the person's `record:workflow-recipe` row with its `record:workflow-step` rows), the run's input and the answers known so far. It returns the run: `paused` with `waiting` naming the steps that have no answer yet, `completed`, or `failed` with the engine's own words. Nothing is kept: the caller keeps the answers and calls again with them.

- `read-data/run-a-workflow.mjs`: `runWorkflow` (the tool), `runAWorkflow` (a recipe or its rows, run), `workflowEngine` (the built engine, `tools/build-engine-modules-for-web-hosts/built-stored-bytes/workflow-engine`), `kitOf` (the kit a run carries, chosen before the engine runs, never inside it).
- `read-data/workflows.mjs`: the older version's `src/workflows.mjs`, moved whole (`moved-from.json`), with its imports pointed at this repository and its stores, sources and engine given to `makeWorkflows`. `definitionOf` makes a recipe a definition: each step an ask (named `ai`, or the tool the step runs), then a `<step>#checks` check step holding its checks, joined by `always` edges; a recipe holding its own `definition` runs as that definition. An ask named `agent:<id>` is handed to that agent by the ask `makeWorkflows` gives the engine; `runWorkflow` has no such host, so it lists that ask in `waiting` like any other.
- The engine runner is `tools/run-a-workflow-definition-on-the-workflow-engine-in-one-call`.

Checks run on the engine (`crates/workflow-core/src/executor/checks.rs`): subset-of, covers, mentioned-in, excludes-words, distinct-at-least, exists, lane-jobs. A check of another kind (cites-resolve, differs-from, field-in, fields-present, slotted-runs) is waiting for the engine: the run fails at that check step and names the kind.

## Test

```
node --test tools/write-a-job-done-in-several-steps-have/test/run-a-workflow.test.mjs
```

## The older version's files

The rest of the older version's files for this job are in `from-an-older-version/`: the bytes of commit b6ae0ebf81, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here.
