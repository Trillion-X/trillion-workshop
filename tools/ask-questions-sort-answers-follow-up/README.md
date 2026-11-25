# tools/ask-questions-sort-answers-follow-up/

Asks people questions and decides from their answers. It owns what a form is (its questions and the question types), how a form's answers are checked, how answers are scored into a segment with its follow-up, and what a form's answers decide. Eight Workshop tools run in the deployed tool container. `tool:make-quiz-questions`, `tool:check-form-answers`, `tool:score-answers-and-pick-segment` work from their input. The other five are functions of their input too: each is given the person's form rows it reads as `rows` ({ id, type, value }, read by the caller from wherever the person keeps them) and answers the rows it makes as `keep`, which the caller writes to the person's own database. None reaches a database. `tool:save-a-form` answers a form as one `question-sequence` row; `tool:submit-form-answers` answers the answer facts, the segment decision and one owner-action request per hand-off, together; `tool:read-form-results`, `tool:read-answer-progress` and `tool:read-latest-answers-as-lines` read the rows they are given.

Other folders that take answers from people (a request form, a booking form) import the form checker from here (`do-work/check-answers.mjs`, `read-data/*`, listed in `part.json`) instead of keeping their own, so a form's shape and the checking of its answers have one home.

## Files

Marked: **copied** from the package unchanged but for its import paths, **changed** (and why), **seam** (new, at the Workshop edge).

| File | Purpose | From |
|------|---------|------|
| `read-data/validate-answer.ts` | Coerces an answer to its type and checks it against rules (required, min/max as length, value or number of picks, pattern, message). A `picks` answer (`{ picked, other? }`) is checked against the question's own options: one pick or several, and the other option's words. | changed: picks |
| `read-data/evidence-reference.ts` | The wrapper a file or recording answer arrives in, checked without reading its body. | copied |
| `read-data/question-descriptor.ts` | Question, question-type and form shapes, `indexCapabilities`, and `FALLBACK_INPUT_COMPONENT_KEY`. A question may be asked only when its rules hold: `showWhen` and `hideWhen` are formula-engine rule trees (tools/formula-engine) read over the answers so far by `answerFacts` (a picks answer gives its picked list) and `isAsked` (given the engine's `holds`; a question with rules and no engine is refused, never guessed). A question may allow several picks (`multiple`), name an other option (`other`), carry `help`, and be `about` an earlier answer: `resolveAbout` fills `{name}` in its label from that answer and says what the answer is about; `answerText` writes an answer in words. | changed: the fallback key lives here, not in the screen inputs; picks, about |
| `read-data/question-input-contract.ts` | The option shape and input props (types only). | copied |
| `read-data/question-suggestions.ts` | Suggestions and options read from a named feed by path. | copied |
| `read-data/fill-screen-model.ts` | `buildFillScreenModel`: every question's type rules with its own laid over them, each answer's verdict, all valid, first invalid. Given the engine's `holds`, a question not asked now has no row and is not checked. | copied |
| `read-data/read-forms-data.ts` | Decodes question-type rows and form (`question-sequence`) records, defensively. | copied |
| `read-data/builder-model.ts` | Immutable edits of a draft form: add, remove, update, move a question, set the title. | copied |
| `read-data/score-and-segment.ts` | `evaluateRule`, `scoreAnswers`, `assignSegment`, `decide`: points and segments from rule rows. | copied |
| `read-data/follow-up-sequences.ts` | `selectFollowUpSequence`, `readFollowUpSequences`: each segment's follow-up steps. | copied |
| `read-data/read-decide-config.ts` | Decodes score rules, segment rules and follow-up sequences, scoped to one form when asked. | copied |
| `read-data/fold-answer-facts.ts` | Folds answer facts back into one session per (form, respondent, submission), latest answer wins. | copied |
| `read-data/session-progress-rows.ts` | Turns folded sessions into ordered rows by a caller-given field map. | copied |
| `read-data/progress-model.ts` | One respondent's rows, trend series and latest row. | copied |
| `read-data/results-model.ts` | Segment assignments into result rows and a count per segment. | copied |
| `read-data/answers-over-time.mjs` | `answersOverTime`: one person's sittings of one form in time order, each with its segment and which way it moved, each question as a series (one per question and per thing it was about), what changed between the last two sittings and the latest segment's follow-up. `latestStandingOf`: a count per segment and each person's latest segment, the one before and the move, newest first. Segments rank by their rules' `min`. Pure, browser-safe. | seam |
| `read-data/answers-over-time-words.json` | Every word of the two screens below, each replaceable by a screen row's `words`. | seam |
| `web/answers-over-time-screen-mount.tsx` | A members-page screen module: where the person stands now (segment, meaning, move, Answer it again at the row's `answer_at`), what to do next, what changed since last time (before and now; a numeric question as its trend), each sitting on a timeline, and every answer behind one fold per question. Reads the form, the person's facts and assignments (by id prefix), segment rules and follow-ups through the records door; whose rows a person may read is the site door's rule. | seam |
| `web/latest-standing-screen-mount.tsx` | A members-page screen module for a form's owner: a tile per segment with how many stand in it now, then one row per person (segment, move, times answered, last date) opening that person's answers over time. | seam |
| `read-data/synthesis-answer-lines.ts` | The latest answers as prose lines, each labelled with its question. | copied |
| `read-data/synthesis-result.ts` | Keys and reads a saved synthesis result by (form, key). | copied |
| `read-data/record-rows.ts` | `KeptRow`, `RecordWrite`, and `payloadRows`: kept rows as the payload-wrapped rows the readers take. | seam |
| `read-data/kept-rows.mjs` | `givenRows(input)` and `readRows(rows, kind, { id, formId, respondentId })`: the rows a call is given, checked, and those of one kind matching the value's `formId` and `respondentId`, by id order. |
| `do-work/answer-fact-writes.ts` | One answer-fact record per answered question (`answer-fact:<form>:<respondent>[:submission:<id>]:<question>`), with what it is `about` when the question is about an earlier answer, so the same question about another thing is its own series. | changed: a kept row `{ id, type, value }` where the package built an engine write-batch entry; about |
| `do-work/segment-assignment-writes.ts` | The decision as one segment-assignment record. | changed: as above |
| `do-work/process-submission.ts` | `buildProcessSubmission`: the answers, the decision and the selected follow-up, to be written together. | changed: `writes` for the engine `request`; the sender is gone |
| `do-work/save-question-sequence.ts` | A draft form as one `question-sequence` record. | changed: as above |
| `do-work/run-after-saved-actions.ts` | Resolves each question's after-saved hand-off (owner, action, input with `$answer.*`, `$run.*`, `$now`, `$uuid` filled in) and passes it on. | changed: the caller passes the dispatch; the old engine's default is gone |
| `do-work/generate-questions.mjs` | Fill-in-the-blank questions from text. | seam (before this port) |
| `do-work/check-answers.mjs` | The form answer check's command, and `registry`/`checkAnswers` for other tools. | seam; `registry` exported by this port |
| `do-work/rule-engine.mjs` | The formula engine loaded once in Node, `holds` for the questions asked only when their rules hold; every tool row packs the engine's built files (and `query-and-change-list-rows/src/formula-engine.mjs`, which `list-aggregates.mjs` imports). | seam |
| `do-work/score-answers-and-pick-a-segment.mjs` | The scoring command. | seam (before this port) |
| `do-work/form-tools.mjs` | The five form tools: `saveForm`, `submitFormAnswers`, `readFormResults`, `readAnswerProgress`, `readAnswerLines`; each is `fn(input)`, given `rows` and answering `keep`. | seam |
| `data/question-types.json` | The question-type rows (text, long text, number, rating, choice, picks, link, evidence reference) with their rules and coercion. | seam (before this port) |
| `records.json` | The three container-only tool rows. | seam |
| `tool-rows.json` | Lists `records.json` into the Workshop and holds the five form rows (each runs on `tools/workflows/do-work/run-a-function.mjs`, with no door and no held value). | seam |
| `test/` | 29 test files (`answers-over-time.test.mjs` for the sittings, series, changes and standing) (`picks-and-about.test.ts` for picks, links and about; `show-when.test.ts` for questions asked only when their rules hold) carried from the package (see below) and `form-tools.test.mjs`, which runs the five tools over one stand-in for the person's rows (given as `rows`, taking each `keep`) and each shipped row as the engine runs it. | carried and seam |

## Rows the form tools make and read

One kind per row (`type`); `id` is the row's name and `value` the row. Made by the tool named (answered as `keep`); read by the tools named (given as `rows`).

| Kind | Made by | Read by |
|------|-------------|------------------------|
| `question-sequence` (a form) | save-a-form | submit-form-answers, read-latest-answers-as-lines |
| `answer-fact` | submit-form-answers | read-answer-progress, read-latest-answers-as-lines |
| `segment-assignment` | submit-form-answers | read-form-results |
| `owner-action-request` | submit-form-answers, one per question whose `afterSaved` names an owner and action | its owner |
| `score-rule`, `segment-rule`, `follow-up-sequence` | the person (rows that decide the segment, kept in their own database) | submit-form-answers |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `buildFillScreenModel` | `(questions, registry, answers, { revealErrors? }) => { rows, allValid, firstInvalidId }` | Checks a whole form. |
| `decide` | `(answers, scoreRules, segmentRules) => { score, breakdown, byLabel, segmentId }` | Scores and picks a segment. |
| `buildProcessSubmission` | `(formId, respondentId, answers, config, decidedAt, submissionId?) => { writes, decision, followUp }` | The rows to keep together. |
| `foldAnswerFacts` | `(rows, { formId?, respondentId?, submissionId? }) => FoldedSession[]` | Sessions from answer facts. |
| `generateQuestions` | `(text, { max?, sourceRef? }) => question[]` | Deterministic cloze questions with stable ids. |
| `checkAnswers`, `registry` | the tools' work and the question-type rows | Exported for tests and for folders that take answers through a form. |

## Invariants

- No question type, weight, threshold or segment is named in code: each is a row the caller or `data/question-types.json` supplies.
- A refused submission answers the first answer to fix and nothing to keep; an accepted one answers its answer facts, decision and hand-off requests together in `keep`, for the caller to write together.
- No tool here is handed a records door, a database or a held value; each is a function of its input.

## Left behind

- `show/` (the fill, builder, results, progress and synthesis surfaces and their mounts, with 7 test files of 40 cases) and the browser respondent-identity resolver `read-data/current-respondent.ts` (signed-in session through the old engine's door, then a per-device id in browser storage; 16 tests): for the screens. Here the respondent id is an input.
- `read-data/read-producer-message.ts` (polls an old-engine AI producer's reply by address) and `do-work/submit-answers.ts` (sent the write-batch): old engine only.
- `things-to-store-and-run.json`, `built-stored-bytes/`, `.bitfield-entry-scope/`, `reference-adaptation-contract.json`: old engine packaging. The package test `a-caller-can-author-one-set-of-questions.test.mjs` compared two write paths (the builder and a declared owner action) in that file; there is one write path here, `save-a-form`.
- One case of `fold-answer-facts.test.ts` fed the facts to another package's measure (`progression-evaluator`, not in the Workshop).

## Dependencies

**Depends on:** Node 24 in the tool container; `tools/workflows/do-work/run-a-function.mjs`, which runs each form tool's export with its input; `tools/query-and-change-list-rows/src/list-aggregates.mjs` and `tools/formula-engine`, which the scoring and results readers import.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's container executor, Trillion's `test/business-tools.test.mjs`, and the folders that import the form checker through `part.json`.
