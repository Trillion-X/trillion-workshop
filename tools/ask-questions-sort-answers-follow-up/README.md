# tools/ask-questions-sort-answers-follow-up/

Asks people questions and decides from their answers: makes quiz questions from text, checks answers against a form's questions, and scores answers into a segment with its follow-up. Three Workshop tools run in the deployed tool container: `tool:make-quiz-questions`, `tool:check-form-answers`, `tool:score-answers-and-pick-segment`. Ported from bitfield-packages `packages/ask-questions-sort-answers-follow-up` (its pure read side and question maker; the screens and the engine write builders were not brought in); nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/validate-answer.ts` | Coerces an answer to its type and checks it against rules (required, min/max as length or value, pattern, message). |
| `read-data/evidence-reference.ts` | The wrapper a file or recording answer arrives in, checked without reading its body. |
| `read-data/question-descriptor.ts` | Question, question-type and form shapes, `indexCapabilities`, and `FALLBACK_INPUT_COMPONENT_KEY` (the input an unknown type falls back to). |
| `read-data/question-input-contract.ts` | The option shape and input props (types only). |
| `read-data/question-suggestions.ts` | Suggestions and options read from a named feed by path. |
| `read-data/fill-screen-model.ts` | `buildFillScreenModel`: every question's type rules with its own laid over them, each answer's verdict, all valid, first invalid. |
| `read-data/score-and-segment.ts` | `evaluateRule`, `scoreAnswers`, `assignSegment`, `decide`: points and segments from rule rows. |
| `read-data/follow-up-sequences.ts` | `selectFollowUpSequence`, `readFollowUpSequences`: each segment's follow-up steps. |
| `data/question-types.json` | The question-type rows (text, long text, number, rating, choice, evidence reference) with their rules and coercion. |
| `do-work/generate-questions.mjs` | Fill-in-the-blank questions from text; its command takes `{ text, max?, source_ref? }`. |
| `do-work/check-answers.mjs` | The form answer check's command: `{ questions, answers }`. |
| `do-work/score-answers-and-pick-a-segment.mjs` | The scoring command: `{ answers, score_rules, segment_rules, follow_ups? }`. |
| `records.json` | The three tool rows. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-question-tools`). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `buildFillScreenModel` | `(questions, registry, answers, { revealErrors? }) => { rows, allValid, firstInvalidId }` | Checks a whole form. |
| `decide` | `(answers, scoreRules, segmentRules) => { score, breakdown, byLabel, segmentId }` | Scores and picks a segment. |
| `generateQuestions` | `(text, { max?, sourceRef? }) => question[]` | Deterministic cloze questions with stable ids. |
| `checkAnswers`, `scoreAnswersAndPickASegment` | the tools' work | Exported for tests. |

## Invariants

- No question type, weight, threshold or segment is named in code: each is a row the caller or `data/question-types.json` supplies.

## Dependencies

**Depends on:** Node 24 in the tool container.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's container executor, Trillion's `test/business-tools.test.mjs`.
