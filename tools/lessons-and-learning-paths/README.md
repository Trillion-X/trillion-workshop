# tools/lessons-and-learning-paths/

Where a learner stands on a track of ordered steps, and the writes that accept an evaluation of a step. A track, its steps, a learner's progress state, evaluation receipts and evidence are plain records the caller reads through the records door and hands over; nothing here reads storage or the clock. Ported from bitfield-packages `learning-progress` (its read-data and do-work logic) and the pure step-to-path projection of `learning-path`. The two Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## What the old packages became

| Old package | Decision | What happened |
|---|---|---|
| `learning-progress` | Ported | `read-data/read-learning-progress.ts` and `do-work/build-evaluation-writes.ts` are `do-work/learning-progress.mjs`; its tests are in `test/`. The engine write glue (`accept-evaluation-target.ts`) is not carried: the tool plans the writes and the caller makes them. |
| `learning-path` | Ported in part | The step-to-path projection (`projectProgressToPath`) is the `path` field of each view. The rail screen model and surface stay screens. |
| `learning-mastery-protocol` | Absorbed | Its lifecycle (a map of which phase may follow which) is what `move-records-through-declared-states` answers. The descriptor panel stays a screen. |
| `course-lesson`, `learning-home` | Screens | They only draw a surface; no logic to carry. |

## Files

| File | Purpose |
|------|---------|
| `do-work/learning-progress.mjs` | The engine: pure functions over the records handed in. |
| `do-work/work-out-where-a-learner-stands.mjs` | `tool:work-out-where-a-learner-stands`: per track, the steps in order, percent finished, the step to do next, the latest evaluation, recent evidence and the path. |
| `do-work/plan-an-evaluation-write.mjs` | `tool:plan-an-evaluation-write`: the receipt and next progress state to write for an evaluation, or idempotent with no writes, or a refusal with the reason. |
| `part.json` | The engine file is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/lessons-and-learning-paths.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. Fixtures are a made-up bakery course. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `learningProgressViews` | `({tracks, steps, states, evidence, evaluationReceipts, presentations}, learnerId?) -> View[]` | One view per track, ordered by track label. The percent is counted from the steps; a stored percent or status is ignored. |
| `validateEvaluationReceipt` | `(receipt) -> receipt` | Throws a TypeError naming the part that is unsound. |
| `buildEvaluationWritePlan` | `({receipt, expectedStateRevision}, currentState) -> {receiptRef, stateRef, receipt, state}` | The next state: revision + 1; a step is finished only when the receipt's `decision.completed` is true. Refuses a stale revision or another learner's state. |
| `acceptEvaluation` | `({receipt, expectedStateRevision, storedReceipt}, currentState) -> {idempotent, writes, ...}` | The same receipt twice is accepted with no writes; a different receipt under the same id is refused. |
| `evaluationReceiptRef` / `progressStateRef` | `(id) / (learnerId, trackId) -> string` | The references a state keeps for its receipts, and the state's own address. |

Each tool script reads the run's input as JSON on standard input and prints its result as JSON on its last line.

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` (the tool rows), `test/lessons-and-learning-paths.test.mjs`.
