# tools/ask-questions-sort-answers-follow-up/

Asks people questions and decides from their answers. It owns what a form is (its questions and the question types), how a form's answers are checked, how answers are scored into a segment with its follow-up, and how forms, answers and decisions are kept as the person's own records. Eight Workshop tools: `tool:make-quiz-questions`, `tool:check-form-answers`, `tool:score-answers-and-pick-segment` run in the deployed tool container with no records; `tool:save-a-form`, `tool:submit-form-answers`, `tool:read-form-results`, `tool:read-answer-progress`, `tool:read-latest-answers-as-lines` run in the container and reach the person's records through the records door (`tools/records-door`). Ported from bitfield-packages `packages/ask-questions-sort-answers-follow-up`; nothing here is imported by the Worker.

Other folders that take answers from people (a request form, a booking form) import the form checker from here (`do-work/check-answers.mjs`, `read-data/*`, listed in `part.json`) instead of keeping their own, so a form's shape and the checking of its answers have one home.

## Files

Marked: **copied** from the package unchanged but for its import paths, **changed** (and why), **seam** (new, at the Workshop edge).

| File | Purpose | From |
|------|---------|------|
| `read-data/validate-answer.ts` | Coerces an answer to its type and checks it against rules (required, min/max as length or value, pattern, message). | copied |
| `read-data/evidence-reference.ts` | The wrapper a file or recording answer arrives in, checked without reading its body. | copied |
| `read-data/question-descriptor.ts` | Question, question-type and form shapes, `indexCapabilities`, and `FALLBACK_INPUT_COMPONENT_KEY`. | changed: the fallback key lives here, not in the screen inputs |
| `read-data/question-input-contract.ts` | The option shape and input props (types only). | copied |
| `read-data/question-suggestions.ts` | Suggestions and options read from a named feed by path. | copied |
| `read-data/fill-screen-model.ts` | `buildFillScreenModel`: every question's type rules with its own laid over them, each answer's verdict, all valid, first invalid. | copied |
| `read-data/read-forms-data.ts` | Decodes question-type rows and form (`question-sequence`) records, defensively. | copied |
| `read-data/builder-model.ts` | Immutable edits of a draft form: add, remove, update, move a question, set the title. | copied |
| `read-data/score-and-segment.ts` | `evaluateRule`, `scoreAnswers`, `assignSegment`, `decide`: points and segments from rule rows. | copied |
| `read-data/follow-up-sequences.ts` | `selectFollowUpSequence`, `readFollowUpSequences`: each segment's follow-up steps. | copied |
| `read-data/read-decide-config.ts` | Decodes score rules, segment rules and follow-up sequences, scoped to one form when asked. | copied |
| `read-data/fold-answer-facts.ts` | Folds answer facts back into one session per (form, respondent, submission), latest answer wins. | copied |
| `read-data/session-progress-rows.ts` | Turns folded sessions into ordered rows by a caller-given field map. | copied |
| `read-data/progress-model.ts` | One respondent's rows, trend series and latest row. | copied |
| `read-data/results-model.ts` | Segment assignments into result rows and a count per segment. | copied |
| `read-data/synthesis-answer-lines.ts` | The latest answers as prose lines, each labelled with its question. | copied |
| `read-data/synthesis-result.ts` | Keys and reads a saved synthesis result by (form, key). | copied |
| `read-data/record-rows.ts` | `DoorRecord`, `RecordWrite`, and `payloadRows`: door records as the payload-wrapped rows the readers take. | seam |
| `do-work/answer-fact-writes.ts` | One answer-fact record per answered question (`answer-fact:<form>:<respondent>[:submission:<id>]:<question>`). | changed: a door record `{ id, type, value }` where the package built an engine write-batch entry |
| `do-work/segment-assignment-writes.ts` | The decision as one segment-assignment record. | changed: as above |
| `do-work/process-submission.ts` | `buildProcessSubmission`: the answers, the decision and the selected follow-up, to be written together. | changed: `writes` for the engine `request`; the sender is gone |
| `do-work/save-question-sequence.ts` | A draft form as one `question-sequence` record. | changed: as above |
| `do-work/run-after-saved-actions.ts` | Resolves each question's after-saved hand-off (owner, action, input with `$answer.*`, `$run.*`, `$now`, `$uuid` filled in) and passes it on. | changed: the caller passes the dispatch; the old engine's default is gone |
| `do-work/generate-questions.mjs` | Fill-in-the-blank questions from text. | seam (before this port) |
| `do-work/check-answers.mjs` | The form answer check's command, and `registry`/`checkAnswers` for other tools. | seam; `registry` exported by this port |
| `do-work/score-answers-and-pick-a-segment.mjs` | The scoring command. | seam (before this port) |
| `do-work/forms-on-the-records-door.mjs` | The five records-door tools: `saveForm`, `submitFormAnswers`, `readFormResults`, `readAnswerProgress`, `readAnswerLines`. | seam |
| `data/question-types.json` | The question-type rows (text, long text, number, rating, choice, evidence reference) with their rules and coercion. | seam (before this port) |
| `records.json` | The three container-only tool rows. | seam |
| `tool-rows.json` | Lists `records.json` into the Workshop and holds the five records-door rows. | seam |
| `test/` | 26 test files carried from the package (see below) and `forms-on-the-records-door.test.mjs`, which runs the five records-door rows against the fake door. | carried and seam |

## Records the door tools keep

| Type | Written by | Read by |
|------|------------|---------|
| `question-sequence` (a form) | save-a-form | submit-form-answers, read-latest-answers-as-lines |
| `answer-fact` | submit-form-answers | read-answer-progress, read-latest-answers-as-lines |
| `segment-assignment` | submit-form-answers | read-form-results |
| `owner-action-request` | submit-form-answers, one per question whose `afterSaved` names an owner and action | the owner named |
| `score-rule`, `segment-rule`, `follow-up-sequence` | the person (rows that decide the segment) | submit-form-answers |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `buildFillScreenModel` | `(questions, registry, answers, { revealErrors? }) => { rows, allValid, firstInvalidId }` | Checks a whole form. |
| `decide` | `(answers, scoreRules, segmentRules) => { score, breakdown, byLabel, segmentId }` | Scores and picks a segment. |
| `buildProcessSubmission` | `(formId, respondentId, answers, config, decidedAt, submissionId?) => { writes, decision, followUp }` | The records to write together. |
| `foldAnswerFacts` | `(rows, { formId?, respondentId?, submissionId? }) => FoldedSession[]` | Sessions from answer facts. |
| `generateQuestions` | `(text, { max?, sourceRef? }) => question[]` | Deterministic cloze questions with stable ids. |
| `checkAnswers`, `registry` | the tools' work and the question-type rows | Exported for tests and for folders that take answers through a form. |

## Invariants

- No question type, weight, threshold or segment is named in code: each is a row the caller or `data/question-types.json` supplies.
- A refused submission writes nothing; an accepted one writes answers and decision in one write.

## Left behind

- `show/` (the fill, builder, results, progress and synthesis surfaces and their mounts, with 7 test files of 40 cases) and the browser respondent-identity resolver `read-data/current-respondent.ts` (signed-in session through the old engine's door, then a per-device id in browser storage; 16 tests): for the screens. Here the respondent id is an input.
- `read-data/read-producer-message.ts` (polls an old-engine AI producer's reply by address) and `do-work/submit-answers.ts` (sent the write-batch): old engine only.
- `things-to-store-and-run.json`, `built-stored-bytes/`, `.bitfield-entry-scope/`, `reference-adaptation-contract.json`: old engine packaging. The package test `a-caller-can-author-one-set-of-questions.test.mjs` compared two write paths (the builder and a declared owner action) in that file; there is one write path here, `save-a-form`.
- One case of `fold-answer-facts.test.ts` fed the facts to another package's measure (`progression-evaluator`, not in the Workshop).

## Dependencies

**Depends on:** Node 24 in the tool container; `tools/records-door` for the five records-door tools.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's container executor, Trillion's `test/business-tools.test.mjs`, and the folders that import the form checker through `part.json`.
