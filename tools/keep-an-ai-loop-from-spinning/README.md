# tools/keep-an-ai-loop-from-spinning/

Keeps a model that works a job in a loop from spinning. After each tool call it answers whether to nudge the model, give the job back, or go on.

- **The same call again is a repeat.** A call is counted by its name and its arguments in canonical form (key order never matters); any different call ends the run of repeats. `repeat_nudge_after` repeats earn one nudge, said once per run of repeats; `repeat_give_back_after` repeats give the job back.
- **Failures count only in a row.** `error_budget` failing calls in a row give the job back with the reason said, never retried silently; one success clears them.
- **A malformed call is the model's slip, not the tool's failure.** Arguments that were not JSON, or a tool the loop may not call, never count against the budget and do not break a run of repeats.
- **Every number and every word is data** (`read-data/loop-guards.json`); nothing here names a tool or a model.

## Files

| Path | What it is |
|---|---|
| `read-data/loop-guards.mjs` | `makeLoopGuard(rules)`: the guard, moved from old trillion `src/loop-guards.mjs` unchanged. |
| `read-data/loop-guards.json` | The shipped rules and words (old trillion `src/own-ais.json` `loop_guards`). |
| `do-work/check-a-run-of-calls.mjs` | `tool:check-a-model-loops-calls`: a run of calls through one guard, each answer said. |
| `test/loop-guards.test.mjs` | The guard's assertions, moved from old trillion `test/own-ais-loop-guards.test.mjs`, and the row's. |
