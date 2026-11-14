# tools/lessons-and-learning-paths/

Where a learner stands on a track of ordered steps, and the writes that accept an evaluation of a step. A track, its steps, a learner's progress state, evaluation receipts and evidence are plain records the caller reads through the records door and hands over; nothing here reads storage or the clock. Ported from bitfield-packages `learning-progress` (its read-data and do-work logic) and the pure step-to-path projection of `learning-path`. The two Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## What the old packages became

| Old package | Decision | What happened |
|---|---|---|
| `learning-progress` | Ported, screen moved | `read-data/read-learning-progress.ts` and `do-work/build-evaluation-writes.ts` are `do-work/learning-progress.mjs`; its tests are in `test/`. The engine write glue (`accept-evaluation-target.ts`) is not carried: the tool plans the writes and the caller makes them, and `writesNotReadBack` is the check it did after writing (the caller reads both rows back and refuses anything else). The screen (`show/LearningProgressSurface.tsx`), its row types (`read-data/learning-progress-types.ts`) and the rows reader (`read-data/read-learning-progress.ts`, which keeps `readLearningProgressState` and its owner-address filter) moved byte for byte from bitfield-packages d926b7adb, then were edited at the calls listed under "Calls swapped in the progress screen". The package entry `mount-learning-progress.tsx` is not carried: `web/learning-progress-screen-mount.tsx` takes its place. |
| `learning-path` | Ported in part | The step-to-path projection (`projectProgressToPath`) is the `path` field of each view. The rail screen model and surface stay screens. |
| `learning-mastery-protocol` | Absorbed | Its lifecycle (a map of which phase may follow which) is what `move-records-through-declared-states` answers. The descriptor panel stays a screen. |
| `course-lesson` | Moved | `packages/course-lesson/show/CourseLessonSurface.tsx` moved byte for byte from bitfield-packages d926b7adb (the receipt names the unedited file); only its ui import path changed. It is the screen of `tool:show-the-courses-a-learner-is-on`, mounted by `web/course-lesson-screen-mount.tsx`, which reads one `record:lesson` row (`read-data/lesson-input.mjs` maps its title, summary, body, do_now, primary_resource_id and resources to the page). The retired package entry `mount-course-lesson.tsx` and the vitest test `CourseLessonSurface.test.tsx` are not carried: the mount module takes the entry's place and this repository has no vitest runner. |
| `learning-home` | Screen | It only draws a surface; no logic to carry. |

## Files

| File | Purpose |
|------|---------|
| `do-work/learning-progress.mjs` | The engine: pure functions over the records handed in. |
| `do-work/work-out-where-a-learner-stands.mjs` | `tool:work-out-where-a-learner-stands`: per track, the steps in order, percent finished, the step to do next, the latest evaluation, recent evidence and the path. |
| `do-work/plan-an-evaluation-write.mjs` | `tool:plan-an-evaluation-write`: the receipt and next progress state to write for an evaluation, or idempotent with no writes, or a refusal with the reason. |
| `web/course-lesson-screen-mount.tsx` | The lesson page as a screen module: reads the lesson row the input names and draws it. |
| `read-data/lesson-input.mjs` | What the lesson page is given for one lesson row. |
| `packages/course-lesson/show/` | The lesson page, moved from bitfield-packages (receipt: `moved-from.json`). |
| `web/learning-progress-screen-mount.tsx` | The learner progress screen as a screen module: hands the screen the learner and the practice action (a tool) its input names. |
| `packages/learning-progress/show/` | The progress screen (moved) and `use-progress-rows.ts`, which reads its rows through the records door. |
| `packages/learning-progress/read-data/` | The screen's row types and rows reader (moved), `progress-row-types.json` (the list of each kind of row it reads) and `progress-rows.mjs` (gives the owner address to the state and receipt lists only). |
| `test/learning-progress-guards.test.mjs` | Tests for the retired receipt reference, the read-back check and the owner-address lists. |
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
| `namesEvaluationReceipt` | `(refs, evaluationId) -> boolean` | True when a state's references name the receipt, in the form written now or the retired `package::learning-progress::evaluation::` form that states written by the old package hold. The view's latest evaluation and the idempotent check both use it. |
| `writesNotReadBack` | `(writes, readBack) -> string[]` | The refs of the writes whose record did not come back as written; empty means the receipt and the state are both stored as planned. |

Each tool script reads the run's input as JSON on standard input and prints its result as JSON on its last line.

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` (the tool rows), `test/lessons-and-learning-paths.test.mjs`.

## The learning page

`do-work/show-the-courses-a-learner-is-on.mjs` is `tool:show-the-courses-a-learner-is-on`, the learning page's own read: each course as its lessons in order, with how many are done, the lesson the learner is on now (active), the rest (locked) and each lesson's words. Ported from old trillion `src/community-activity.mjs` `coursesFor` (the path statuses from `src/community-logic/project-progress-to-path.ts`). A lesson's interactive module is marked `interactive` but not carried, since the old module was shared only inside one relay. Tested in `test/show-the-courses-a-learner-is-on.test.mjs`.

## Calls swapped in the progress screen

The screen asked the retired Bitfield runtime for its rows and for the practice action. Each call and where it went:

| Old call (file) | Now |
|---|---|
| `useBitfieldData('published-records')` (`LearningProgressSurface.tsx`) | `useProgressRows()` (`show/use-progress-rows.ts`): one `records:list` per kind in `read-data/progress-row-types.json`. |
| `sendRequestToBitfieldTarget({ target, payload })` (`LearningProgressSurface.tsx`) | `runWorkshopTool(practice_action.tool, payload, newRunKey('practice'))`: the screen's input names a tool, not a target. |
| `learningProgressViews` (`read-learning-progress.ts`) | Removed from the moved file: `do-work/learning-progress.mjs` holds the one copy, and the screen imports it. |
| `@/packages/ui/show/*` and `@/packages/learning-progress/*` imports | Relative imports of `tools/ui` and this folder. |
| Owner address filter (`read-learning-progress.ts`, kept as moved) | A progress state and an evaluation receipt count only from rows given the owner address `package::learning-progress::`; `read-data/progress-rows.mjs` gives it to the rows of the two lists marked `owner` and to no other. |
