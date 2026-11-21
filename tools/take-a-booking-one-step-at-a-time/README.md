# tools/take-a-booking-one-step-at-a-time/

The one-question-at-a-time path of a booking page: the email first, then each question of the page in order, then a slot, then a confirm. A page is data, its questions in position order. This folder holds the rules of that path and no question text, no product word and no calendar call.

- **Each step is one answer.** A caller saves each answer as its own row as it is given. `nextStepOf` says where a booking waits; `lastStepReachedOf` says the last step it answered, which is the drop-off point of a booking that was left.
- **Optional questions are still asked.** An optional question with an empty answer is answered; an unanswered one is the next step.
- **Refusals do not echo the value.** `checkAnswer` names the rule that failed, never the value given, so an email is not repeated in an error.

## Files

| File | Purpose |
|------|---------|
| `read-data/booking-steps.mjs` | `stepsOf`, `nextStepOf`, `lastStepReachedOf`, `checkAnswer`. Pure; no I/O. |
| `test/booking-steps.test.mjs` | Step order, the next and drop-off steps, each answer's accept and refuse cases. |

## Key Types / Functions

| Function | Shape | Role |
|---|---|---|
| `stepsOf(page)` | `{ questions: [{ position, prompt, required? }] }` -> steps `email`, `question:<position>`..., `slot`, `confirm` | The page's steps in order; refuses a page whose questions are malformed or repeat a position. |
| `nextStepOf(page, progress)` | `progress: { email, answers: { [position]: text }, slot }` -> step | The step a booking waits at. |
| `lastStepReachedOf(page, progress)` | same -> step key or null | The drop-off step. |
| `checkAnswer(step, value)` | -> `{ ok: true, value }` or `{ ok: false, reason }` | Trims and checks an email, a text answer or a slot (returned as a UTC ISO instant). |

## Dependencies

**Depends on:** nothing. **Depended on by:** the booking page server code of each site that runs a page; the site reads the page's questions from its own rows.
