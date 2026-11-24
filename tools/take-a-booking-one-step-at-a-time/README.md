# tools/take-a-booking-one-step-at-a-time/

The one-question-at-a-time path of a booking page: the email first, then each question of the page in order, then a slot, then a confirm. A page is data, its questions in position order. This folder holds the rules of that path and no question text, no product word and no calendar call.

- **Each step is one answer.** A caller saves each answer as its own row as it is given. `nextStepOf` says where a booking waits; `lastStepReachedOf` says the last step it answered, which is the drop-off point of a booking that was left.
- **Optional questions are still asked.** An optional question with an empty answer is answered; an unanswered one is the next step.
- **Refusals do not echo the value.** `checkAnswer` names the rule that failed, never the value given, so an email is not repeated in an error.
- **A question is a form question.** Its type, options (one pick or several, an other option asking for the person's own words), rules and what it is about are the form owner's question descriptor (`tools/ask-questions-sort-answers-follow-up`), checked by that owner's checker. A question that names no type is a written answer.
- **A question can be about an earlier answer.** `askedStep` fills `{name}` in its prompt from the answer it reads (for example the stroke picked) and says what the answer is about, so the caller keeps that with the answer.

## Files

| File | Purpose |
|------|---------|
| `read-data/booking-steps.mjs` | `stepsOf`, `nextStepOf`, `askedStep`, `lastStepReachedOf`, `checkAnswer`. Pure; no I/O. |
| `test/booking-steps.test.mjs` | Step order, the next and drop-off steps, each answer's accept and refuse cases. |

## Key Types / Functions

| Function | Shape | Role |
|---|---|---|
| `stepsOf(page)` | `{ questions: [{ position, prompt, required?, question? }] }` -> steps `email`, `question:<position>`..., `slot`, `confirm` | The page's steps in order; each question step carries its descriptor (`question`). Refuses a page whose questions are malformed, repeat a position or id, or name a type the form owner does not have. |
| `nextStepOf(page, progress)` | `progress: { email, answers: { [position]: value }, slot }` -> step | The step a booking waits at; a required question waits until its answer passes its check. |
| `askedStep(page, step, progress)` | -> step with `prompt` filled and `about` | The question as it is asked now. |
| `lastStepReachedOf(page, progress)` | same -> step key or null | The drop-off step. |
| `checkAnswer(step, value)` | -> `{ ok: true, value, text? }` or `{ ok: false, reason }` | Checks an email, a question's answer (a written answer trimmed, picks as `{ picked, other? }`, with `text` in words) or a slot (returned as a UTC ISO instant). |

## Dependencies

**Depends on:** `tools/ask-questions-sort-answers-follow-up` (the question types, the descriptor decoder, the answer check, `resolveAbout` and `answerText`). **Depended on by:** the booking page server code of each site that runs a page; the site reads the page's questions from its own rows.
