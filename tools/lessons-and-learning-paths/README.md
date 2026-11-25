# tools/lessons-and-learning-paths/

Where a learner stands on a track of ordered steps, and the keep rows that accept an evaluation of a step. A track, its steps, a learner's progress state, evaluation receipts and evidence are plain records the caller reads from its own store and hands over; nothing here reads storage or the clock. Ported from bitfield-packages `learning-progress` (its read-data and do-work logic) and the pure step-to-path projection of `learning-path`. The two Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## What the old packages became

| Old package | Decision | What happened |
|---|---|---|
| `learning-progress` | Ported | `read-data/read-learning-progress.ts` and `do-work/build-evaluation-writes.ts` are `do-work/learning-progress.mjs`; its tests are in `test/`. The engine write glue (`accept-evaluation-target.ts`) is not carried: the tool plans the writes and the caller makes them. |
| `learning-path` | Ported in part | The step-to-path projection (`projectProgressToPath`) is the `path` field of each view. The rail screen model and surface stay screens. |
| `learning-progress` | Ported | `read-data/read-learning-progress.ts` and `do-work/build-evaluation-writes.ts` are `do-work/learning-progress.mjs`; its tests are in `test/`. The engine write glue (`accept-evaluation-target.ts`) is not carried: the tool plans the writes and the caller makes them. |
| `learning-path` | Ported in part, rest carried | The step-to-path projection (`projectProgressToPath`) is the `path` field of each view. The rail screen model, the builder and the surface are carried byte for byte in `from-bitfield-packages/learning-path/` (see below). |
| `learning-mastery-protocol` | Absorbed | Its lifecycle (a map of which phase may follow which) is what `move-records-through-declared-states` answers. The descriptor panel stays a screen. |
| `course-lesson` | Moved | `packages/course-lesson/show/CourseLessonSurface.tsx` moved byte for byte from bitfield-packages d926b7adb (the receipt names the unedited file); only its ui import path changed, then the video player and the Mark done control were added (see `web/course-lesson-screen-mount.tsx`). It is the screen of `tool:show-the-courses-a-learner-is-on`, mounted by `web/course-lesson-screen-mount.tsx`, which reads one `record:lesson` row (`read-data/lesson-input.mjs` maps its title, summary, body, do_now, primary_resource_id and resources to the page). The retired package entry `mount-course-lesson.tsx` and the vitest test `CourseLessonSurface.test.tsx` are not carried: the mount module takes the entry's place and this repository has no vitest runner. |
| `learning-home` | Screen | It only draws a surface; no logic to carry. |
| `course-lesson` | Screens | It only draws a surface; no logic to carry. |
| `learning-home` | Screen, carried | The Learn screen (a Lessons view and an embedded Path view that places the lesson and path surfaces it is handed) is `show/mount-learning-home.tsx`, moved byte for byte (`from-bitfield-packages/moved-from.json`); its heading names no course, since the caller gives the title. Its imports still name the old package set's shared parts, so it is not wired into a tool row yet. |

## Files

| File | Purpose |
|------|---------|
| `do-work/learning-progress.mjs` | The engine: pure functions over the records handed in. |
| `do-work/work-out-where-a-learner-stands.mjs` | `tool:work-out-where-a-learner-stands`: per track, the steps in order, percent finished, the step to do next, the latest evaluation, recent evidence and the path. |
| `do-work/plan-an-evaluation-write.mjs` | `tool:plan-an-evaluation-write`: the receipt and next progress state to write for an evaluation, or idempotent with no keep rows, or a refusal with the reason. |
| `web/course-lesson-screen-mount.tsx` | The lesson page as a screen module: reads the lesson row and the learner's done row, plays the lesson's video when its field is named, and writes the done row on Mark done. |
| `web/course-list-screen-mount.tsx` | The course list as a screen module (`tool:list-the-courses-a-learner-is-on`): each course's lessons as complete, active or locked, opening a lesson in the lesson screen. |
| `web/learner-home-screen-mount.tsx` | The learner's home as a screen module: the lesson to resume (its still, place and the course's progress, one Resume press), the next lessons, each course's progress and the courses not open yet; Start on the first lesson when nothing is done; skeleton rows while loading and one sentence with Try again when the read fails. `sections` (heading, resume, up_next, courses) draws only those parts, so a home row can be an arrangement of one row per part that each person, or their AI, rearranges (`screen-arrangement-of::<row>`); the parts of one home share one read. Its row names the lesson fields (`video_field`, `length_field`), the catalog entry a lesson opens (`open_lesson`, braces filled), the plans entry (`open_plans`) and the host values it takes (`first_name`, `closed_courses`). |
| `read-data/learner-home.mjs` | The home's pure read over the course list's own: which lesson to resume, what comes next, each course's progress; `learner-home-words.json` holds its words. Tests: `test/learner-home.test.mjs`. |
| `read-data/lesson-input.mjs` | What the lesson page is given for one lesson row, including its video when the caller names the video field. |
| `read-data/lesson-done.mjs` | The done row's type, id and value, and the finished lessons read back from those rows. |
| `read-data/courses-of-a-learner.mjs` | The learning page's read (complete, active, locked), shared by the do-work script and the course list screen. |
| `packages/course-lesson/show/` | The lesson page, moved from bitfield-packages (receipt: `moved-from.json`). |
| `part.json` | The engine file is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/lessons-and-learning-paths.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. Fixtures are a made-up bakery course. |
| `show/mount-learning-home.tsx` | The Learn screen carried from `learning-home` (see the table above); `from-bitfield-packages/moved-from.json` is its receipt. |
| `do-work/courses.ts` | `tool:read-a-course` and `tool:read-a-lesson`: the answers are the props of `show/Course.tsx` and `show/Lesson.tsx`. Table names are one block (`SOURCE`); a caller may rename a table to a plain identifier. A YouTube address becomes its privacy-enhanced embed address; a stored recording gets `files_base_url`; words are cut into passages by pauses and sentence ends only. |
| `do-work/progress.ts` | `tool:read-a-learners-done-lessons` and `tool:mark-a-lesson-done`: one done row per learner, course and lesson; marking twice adds no second row; a lesson of another course is refused. The learner is named by the trusted caller, never by an argument a browser chooses. |
| `show/Course.tsx` | The course screen: title, description, a host-given `action`, progress, and the lessons in order as links with a done mark. Pure `View(props)`. |
| `show/Lesson.tsx` | The lesson screen: a YouTube recording in the shared `LiveFrame`, a stored recording in the shared player (a video element with its controls and captions), the transcript reader, Mark done, and the lessons before and after. Pure `View(props)`; playback time, seek and presses come from the host. |
| `show/TranscriptReader.tsx` | The words of a recording, each marked as the recording reaches it, a speaker per passage, a press on a speaker filtering to that speaker, a press on a word seeking. Edit controls (naming a speaker, splitting a passage) are drawn only when `viewer.isOwner` is true. |
| `test/courses.test.ts`, `test/screens.test.ts` | The reads over a fake row reader, and the screens drawn to markup. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `learningProgressViews` | `({tracks, steps, states, evidence, evaluationReceipts, presentations}, learnerId?) -> View[]` | One view per track, ordered by track label. The percent is counted from the steps; a stored percent or status is ignored. |
| `validateEvaluationReceipt` | `(receipt) -> receipt` | Throws a TypeError naming the part that is unsound. |
| `buildEvaluationWritePlan` | `({receipt, expectedStateRevision}, currentState) -> {receiptRef, stateRef, receipt, state}` | The next state: revision + 1; a step is finished only when the receipt's `decision.completed` is true. Refuses a stale revision or another learner's state. |
| `acceptEvaluation` | `({receipt, expectedStateRevision, storedReceipt}, currentState) -> {idempotent, keep, ...}` | The same receipt twice is accepted with no keep rows; a different receipt under the same id is refused. |
| `evaluationReceiptRef` / `progressStateRef` | `(id) / (learnerId, trackId) -> string` | The references a state keeps for its receipts, and the state's own address. |

Each tool script reads the run's input as JSON on standard input and prints its result as JSON on its last line.

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` (the tool rows), `test/lessons-and-learning-paths.test.mjs`.

## The learning-mastery-protocol screen

The descriptor panel the table above says "stays a screen" is here, byte for byte from the package at its last commit (`from-bitfield-packages-learning-mastery-protocol/moved-from.json` is its receipt). The selected descriptor supplies the phases, fields, lifecycle transitions, action targets and payloads, labels, defaults and the owner surfaces to embed; the panel accepts a progression change only through an accepted evaluator receipt and never calls an evaluator, a media provider, a scheduler or a content retriever itself.

| File | Purpose |
|------|---------|
| `show/LearningMasteryProtocolPanel.tsx`, `show/mount-learning-mastery-protocol.tsx`, `reference-grounded-screen-contract.md` | The panel, its mount and its reference contract. |
| `read-data/read-learning-mastery.ts`, `read-data/learning-mastery-types.ts` | Reads the descriptor and its types. |
| `do-work/run-protocol-action.ts` | Runs one protocol action the descriptor names (calls the retired package runtime). |
| `read-data/learning-mastery-protocol-boundary.json` | The package's boundary file (its capability, record contracts and input descriptors) kept as data. |
| `__tests__/protocol-descriptor-required.test.ts` | Three cases, run by `npm test`. `__tests__/protocol-fixture.ts` is its fixture; `LearningMasteryProtocolPanel.test.tsx` is not in `npm test`'s glob; `run-protocol-action.test.ts.held` is held (the retired runtime). |

The data layer and `tools/ui` are not in this tree, so the panel does not load here and no tool row opens it yet.

## The learning page

`do-work/show-the-courses-a-learner-is-on.mjs` is `tool:show-the-courses-a-learner-is-on`, the learning page's own read: each course as its lessons in order, with how many are done, the lesson the learner is on now (active), the rest (locked) and each lesson's words. Ported from old trillion `src/community-activity.mjs` `coursesFor` (the path statuses from `src/community-logic/project-progress-to-path.ts`). A lesson's interactive module is marked `interactive` but not carried, since the old module was shared only inside one relay. Tested in `test/show-the-courses-a-learner-is-on.test.mjs`.


## Carried from learning-path

`from-bitfield-packages/learning-path/` holds the package `learning-path` under its own paths, byte for byte, with `moved-from.json`: the Path screen (`show/mount-learning-path.tsx`, `show/LearningPathSurface.tsx`), its screen model (`read-data/learning-path-screen-model.ts`), the builder that joins sources into one path (`read-data/build-from-sources.ts`), the package's records (`things-to-store-and-run.json`) and its tests, which import vitest and so are held (names end in `.held`). The step-to-path projection (`projectProgressToPath`) is the leaf in `tools/community-logic/`, which the builder now imports. The screen's data layer still calls the old package runtime, so it opens no screen until it is swapped for the records door.
## The original package files (prepared restore)

`from-bitfield-packages/moved-from.json`: the Learning progress screen (`show/LearningProgressSurface.tsx`, `mount-learning-progress.tsx`), the original TypeScript readers and writers of `learning-progress` (`read-data/read-learning-progress.ts`, `learning-progress-types.ts`, `do-work/build-evaluation-writes.ts`, `accept-evaluation-target.ts`) and the package's tests, byte for byte. `do-work/learning-progress.mjs` above is a port of the readers and the write plan into JavaScript; it stays because the rows run it, and the TypeScript originals now sit beside it for the lead to decide which owns the tools. What is held: the screen and `accept-evaluation-target.ts` use the retired package runtime, and three tests are held (`.held`).
