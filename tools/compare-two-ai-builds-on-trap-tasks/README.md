# tools/compare-two-ai-builds-on-trap-tasks/

Compares two arms (two builds of an AI's behaviour that differ in one thing, such as two pinned checkouts) on a battery of trap tasks, scoring every task only from the calls its run recorded and its recorded end state, never from what the run said about itself. Both arms are scored over the same denominator, the whole battery: a task an arm has no run for scores 0 and is still counted. Each trap is a row drawn from a waste or failure class seen in production (`src/behavior-evals.json`).

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`: `src/behavior-compare.mjs`, its battery `src/behavior-evals.json`, the command `scripts/compare-arms.mjs` and the test `test/behavior-compare.test.mjs` (`moved-from.json` names each file's source and both identities). The old copies are deleted by the paired Trillion-X/trillion pull request.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:compare-two-ai-builds-on-trap-tasks` | Both traces scored over the carried battery (or one handed in): per arm score, of, ran and classes, and the tasks on which they differ | in a small container, no internet |

## Files

| File | Purpose |
|------|---------|
| `src/behavior-compare.mjs` | `scoreArm`, `compareArms`, `batteryProblems`, `scorerKinds`: the scorers (max_calls, forbids_tool, requires_tool, calls_before, ends_in). |
| `src/behavior-evals.json` | The trap battery: one row per trap. |
| `scripts/compare-arms.mjs` | `node scripts/compare-arms.mjs <arm-a.json> <arm-b.json>` prints the comparison. |
| `do-work/compare-two-builds.mjs` | The row's run: `{ left, right, battery? }` to `compareArms`, with refusals in words. |
| `test/behavior-compare.test.mjs` | The original test: scoring, a self-reported success scores nothing, the script. |
| `test/compare-two-builds.test.mjs` | The row's run and its refusals. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each moved file came from and its identities. |
| `part.json` | Public files. |
