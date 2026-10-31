# tools/practice-and-review/

When something a person is learning (a flashcard, a drill, a passage, a move to practise) should come back for review, and what is due now. The person recalls an item and grades it; the tool works out the next time it is due. Ported from the pure scheduling logic of bitfield-packages `spaced-repetition` (the scheduler, the fold of a grade history into a due queue, and the next-state builder).

The tool carries mechanism only. Every number that shapes the spacing is the person's policy, handed in on each run: the starting ease, the ease floor, the gap after the first and the second success, the recall quality below which an item lapses, and a map from each grade word to a recall quality between 0 and 1. The grade is an open word the policy defines, so a number scale or new words need no code change. There is no default policy; a missing one is refused with the field's name. A grade the policy does not list counts as a total lapse and the answer says `grade_in_policy: false`.

The tool keeps nothing. The caller keeps the returned `state` (or, when `prompt_id` and `schedule_id` are given, the returned `record`) with the item and hands it back as `prior`; a prior with none of the three numbers (written before scheduling) is a new item. The policy is `policy`, or the first of `rows` whose kind is `policy_kind`. A due time is folded from the grades every time, so the grades are the only record.

`tool:practice` keeps the cards. It is one tool with the operations `add`, `due`, `grade`, `cards`, `remove` and `remind`, over the person's own records through the records door: a card (`record:practice-cards`), each grade given (`record:practice-grades`) and the spacing policy (`record:practice-policy`, read only). A due time is never stored: each card's standing is folded from its grades by the schedule below, so the grades are the only record. `remind` answers how many cards are due and a sentence and sends nothing; the daily reminder is a wake or a workflow that runs it and tells the person. Which record types, the default deck, the mastery scale and every sentence are DATA in `read-data/practice-cards.json`.

## Files

| File | Purpose |
|------|---------|
| `read-data/review-schedule.mjs` | The engine: `checkPolicy`, `policyFromRows`, `priorFromRecord`, `scheduleNextReview` (one step of the SM-2 family), `nextScheduleRecord`, `foldReviewHistory` (a grade history, oldest first, folded through the step) and `dueQueueFromResponses`. Pure; every time is an argument. |
| `do-work/schedule-next-review.mjs` | `tool:schedule-next-review`: the next state and due time from one grade. |
| `do-work/list-what-is-due.mjs` | `tool:list-what-is-due`: every item with whether it is due now, when it is next due and its state, due items first. |
| `read-data/practice-cards.mjs` | `practice`: the cards, grades, due list and reminder over the records door; the review schedule does the timing. |
| `read-data/practice-cards.json` | The record types, the default deck and policy id, the mastery scale and the sentences. |
| `part.json` | The engine file is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/practice-cards.test.mjs` | `tool:practice` against the stand-in records door: add keeps progress, grades push a card out and a miss brings it back, mastery, cards and due and remove and remind, the policy as a record or a request and no default, refused requests, and the row's rights and packed files. |
| `test/practice-and-review.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `checkPolicy` | `(policy) -> policy` | Refuses a missing or partial policy with every field that is wrong. |
| `scheduleNextReview` | `({prior?, grade, reviewedAtMs, policy}) -> {state, dueAtMs, lapsed, quality, grade_in_policy}` | One review: ease moves by the grade's quality, the first two gaps are the policy's, later gaps grow by ease, a lapse resets to the first gap. |
| `foldReviewHistory` | `(responses, policy) -> {state, dueAtMs} or null` | Grades in any order, folded oldest first; null when there are none. |
| `dueQueueFromResponses` | `({prompts, responses, nowMs, policy, learner?}) -> standing[]` | Each item with `is_due`, `due_at`, `state` and `review_count`; never-reviewed items are due at once. |

Both scripts read the run's input as JSON on standard input and print the result as JSON on the last line.

## What was not carried

Carried as generic mechanism: the next-record builder (`nextScheduleRecord`, with the old tests) and the policy reader (`policyFromRows`), with the record kind named by the person instead of fixed. Not carried: the old record type names (`review-prompt`, `review-schedule`, `review-response-request`), the grade-button labels and the workflow action that submitted a response; they belong to the old engine and its screen. Which records hold the items and grades, and how a screen draws the buttons from the policy's grade words, are the person's records and the screen's. Two behaviours differ from the old code on purpose: a time that is not a time is refused (the old code read it as the year 1970), and a prior with some but not all of its three numbers is refused (the old code treated it as a new item). A prior with none of them is a new item, as before.

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` (the tool rows), Trillion's deploy (it bundles the files a row names), `test/practice-and-review.test.mjs`.
