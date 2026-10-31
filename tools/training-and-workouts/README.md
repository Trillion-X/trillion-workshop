# tools/training-and-workouts/

A training plan and a workout log as DATA. Reads the plan, reads the progression inputs from it, adapts the next session from adjustments already worked out, reads a workout log (what needs checking, the person's own summary views, export rows, a progress series) and adds to it. Five Workshop tools run in the deployed tool container: `tool:read-my-training-plan`, `tool:read-my-progression-inputs`, `tool:adapt-the-next-training-session`, `tool:read-my-workout-log`, `tool:add-to-my-workout-log`. Ported from bitfield-packages `packages/training-plan` and `packages/workout-log`; nothing here is imported by the Worker.

A person's AI composes the next-session loop: `read-my-progression-inputs` gives the rules and signals, the progress evaluator (`tools/evaluate-progress`, tool `pick-fired-rules`) says which rule's band the measured value falls in and returns its adjustments, and `adapt-the-next-training-session` applies them. This folder does not copy the evaluator. The plan, the log, the rules, the lenses, the units and the words are the person's own records, read at run time; the tool ships none. Nothing is stored by the tool: the log record goes in and the next log record comes out, and the person's AI stores it through the records door.

## Files

| File | Purpose |
|------|---------|
| `read-data/training-plan.mjs` | `decodeTrainingPlan`, `sessionsForWeek`, `trainingPlanSummary`: goals, phases, weeks, sessions with open dose and intensity records. |
| `read-data/progression.mjs` | `decodeProgressionRule(s)`, `decodeLastResult`, `prescriptionFor`, `progressionInputs`, `applyAdjustmentToPrescription`, `applyAdjustments`. |
| `read-data/workout-log.mjs` | The ledger: `readWorkoutLog`, `workoutCompletionRate`, `buildEvidenceAtom`, `buildReviewDecisionAtom`, `buildCorrectionAtom`, `buildRawArtifact`, `appendEvidence`. |
| `do-work/requests.mjs` | `readTrainingPlan`, `readProgressionInputs`, `adaptNextSession`, `readMyWorkoutLog`, `addToWorkoutLog`: the functions the rows run; a request that cannot run throws a sentence saying what to fix. |
| `do-work/run-request.mjs` | The command the rows run: `node do-work/run-request.mjs <function>`, the request as JSON on standard input, `{ result }` or `{ error }` on the last line. |
| `tool-rows.json` | The five rows. |
| `part.json` | No public files: only the container runs this code. |
| `test/` | `training-plan.test.mjs`, `workout-log.test.mjs` (the logic), `rows.test.mjs` (each row's sample run as the container runs it, the loops through the rows, the refusals). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| prescription | `{ id, weekBlockId, title, activity, dose: {}, intensity: {}, scheduledTaskRef? }` | One session. `dose` and `intensity` are open records. |
| stored rule | `{ id, applies_to, condition: { metricRef, min?, max? } or { metricRef, band }, adjustment }` | Read into `{ id, metricRef, band, adjustment, appliesTo?, label? }`; no metric, no rule. |
| adjustment | `{ doseScale?, intensityScale?, note? }` | `doseScale` / `intensityScale` multiply the numbers in dose / intensity (whole stays whole, others round to two places); `note` is kept at `intensity.note`; any other key is ignored. |
| evidence atom | `{ id, observedAt, source, subject, dimensions, links, confidence?, rawArtifactRefs, evidenceRefs }` | One thing observed. A dimension is `{ value, unit?, role?, label? }`. |
| `readWorkoutLog` | `(raw) => { canonicalEvidenceAtoms, reviewQueue, lensOutputs, exportRows, progressSeries, diagnostics, ... }` | The whole reading of a log. |
| lens | `{ id, label, atomQuery: { subjectKinds, dimensionKeys, linkRoles }, output: { kind, primaryMetric? } }` | A person's summary view. Output kinds: `previous-value`, `review-queue`, `progress-summary`, `export-rows`; any other lists the matches. |
| `progressSeries` | `{ metricKey, title, metric, unit?, valueDecimals, points: [{ atomId, timestamp, value }], summary: { total, average, min, max, count } }` | The numeric dimension with the most points, in time order, as plain numbers; the screen draws it. |

## Invariants

- Nothing is edited in place. Confirm, discard, correct, split and merge each ADD an atom that links to the entry (`confirms`, `discards`, `corrects`, `split_from`, `merge_input`). Only a confirmed decision counts. A decision atom (one that confirms or discards) is never an entry; a correction carries values and stays in the reading.
- An entry is in the review queue when its confidence state is not `confirmed`, nothing replaced it and nothing confirmed it. An atom with no confidence is confirmed.
- The ledger's own words are the confidence state `confirmed`, those link roles, and the dimension roles a chart skips (`link`, `status`, `raw`, `note`, `order`, `review_operation`, `correction`). A person's subjects, dimension keys, units, session statuses and lenses are never built in.
- A set's result id is `<session id>:<movement name>` with a two-part session id (`kind:id`); that is the stored shape the set is linked to its session by.
- The tool holds no clock: `observed_at` is required to add. A lens that finds nothing says so; the progress series is null without a numeric dimension, never a made-up one.
- Adding the same atom id twice keeps one; every other key of the log record is kept as given.

## What was not carried

- `show/*` (the plan panel, the log panel, their mounts): screens, left to the screens owner.
- The log's capture descriptors and active-capture state (the description of the form to draw): a screen concern. They stay in the record untouched when a person adds to the log.
- `do-work/workout-log-requests.ts`: the old engine's request builders (`sendRequestToBitfieldTarget`, the slot workflow write). The state builders became `addToWorkoutLog`; writing is the records door.
- `do-work/process-scripts/next-session-cli.ts`: the old engine's process wrapper, with `evaluateProgression` bundled in. The evaluation is `tools/evaluate-progress`.
- The chart's open/high/low/close buckets from the shared UI package: the series is plain numbers.
- The label rewrites for the lens metrics (`confirmed evidence` to `saved entries` and so on): display words.
- `built-stored-bytes`, `.bitfield-entry-scope`, `entry-to-package-data-map.json`, `things-to-store-and-run.json` and the open-load-intent test that read the old manifest from disk: old-engine plumbing. The load-intent cases are carried as synthetic tests.

## Dependencies

**Depends on:** Node 24 in the tool container; nothing else.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names).
