# tools/practice-and-review/

When something a person is learning (a flashcard, a drill, a passage, a move to practise) should come back for review, and what is due now. The person recalls an item and grades it; the tool works out the next time it is due. Ported from the pure scheduling logic of bitfield-packages `spaced-repetition` (the scheduler, the fold of a grade history into a due queue, and the next-state builder).

The tool carries mechanism only. Every number that shapes the spacing is the person's policy, handed in on each run: the starting ease, the ease floor, the gap after the first and the second success, the recall quality below which an item lapses, and a map from each grade word to a recall quality between 0 and 1. The grade is an open word the policy defines, so a number scale or new words need no code change. There is no default policy; a missing one is refused with the field's name. A grade the policy does not list counts as a total lapse and the answer says `grade_in_policy: false`.

The tool keeps nothing. The caller keeps the returned `state` (or, when `prompt_id` and `schedule_id` are given, the returned `record`) with the item and hands it back as `prior`; a prior with none of the three numbers (written before scheduling) is a new item. The policy is `policy`, or the first of `rows` whose kind is `policy_kind`. A due time is folded from the grades every time, so the grades are the only record.

The cards, the grades and the spacing policy are no longer kept by this folder. The record half of `tool:practice` (the operations `add`, `due`, `grade`, `cards`, `remove` and `remind`, over the records door) became `workflow:keep-practice-cards-and-grades` (`tools/workflows/recipes/keep-practice-cards-and-grades.json` and its kit): the person's own store keeps the cards, each grade given and the policy, and the due time is still folded from the grades each time by the schedule below. The words, the mastery number and the default deck the old tool kept as DATA in `read-data/practice-cards.json` are in that recipe's `source` and `steps`. Rule a-tool-is-only-what-the-store-cannot-do.

## Files

| File | Purpose |
|------|---------|
| `read-data/review-schedule.mjs` | The engine: `checkPolicy`, `policyFromRows`, `priorFromRecord`, `scheduleNextReview` (one step of the SM-2 family), `nextScheduleRecord`, `foldReviewHistory` (a grade history, oldest first, folded through the step) and `dueQueueFromResponses`. Pure; every time is an argument. |
| `do-work/schedule-next-review.mjs` | `tool:schedule-next-review`: the next state and due time from one grade. |
| `do-work/list-what-is-due.mjs` | `tool:list-what-is-due`: every item with whether it is due now, when it is next due and its state, due items first. |
| `part.json` | The engine file is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder. |
| `test/practice-and-review.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `checkPolicy` | `(policy) -> policy` | Refuses a missing or partial policy with every field that is wrong. |
| `scheduleNextReview` | `({prior?, grade, reviewedAtMs, policy}) -> {state, dueAtMs, lapsed, quality, grade_in_policy}` | One review: ease moves by the grade's quality, the first two gaps are the policy's, later gaps grow by ease, a lapse resets to the first gap. |
| `foldReviewHistory` | `(responses, policy) -> {state, dueAtMs} or null` | Grades in any order, folded oldest first; null when there are none. |
| `dueQueueFromResponses` | `({prompts, responses, nowMs, policy, learner?}) -> standing[]` | Each item with `is_due`, `due_at`, `state`, `review_count` and `lapse_count` (how many of its grades lapsed, the old practice card's lapses, folded from the grades); never-reviewed items are due at once. |

Both scripts read the run's input as JSON on standard input and print the result as JSON on the last line.

## What was not carried

Carried as generic mechanism: the next-record builder (`nextScheduleRecord`, with the old tests) and the policy reader (`policyFromRows`), with the record kind named by the person instead of fixed. Not carried: the old record type names (`review-prompt`, `review-schedule`, `review-response-request`), the grade-button labels and the workflow action that submitted a response; they belong to the old engine and its screen. Which records hold the items and grades, and how a screen draws the buttons from the policy's grade words, are the person's records and the screen's. Two behaviours differ from the old code on purpose: a time that is not a time is refused (the old code read it as the year 1970), and a prior with some but not all of its three numbers is refused (the old code treated it as a new item). A prior with none of them is a new item, as before.

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` (the tool rows), Trillion's deploy (it bundles the files a row names), `test/practice-and-review.test.mjs`.

## Quiz me on saved items

`from-bitfield-packages/quiz-me-on-saved-items/` holds the package that turns a summarized saved item into recall questions and routes the answers into review and progress, moved byte for byte from bitfield-packages (its records, README and conformance test). The records are in the retired engine's shape; turning them into this model is not done.
## Files moved from bitfield-packages (packages/practice-decision-loop)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `tools/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `do-work/build-decision-loop-effects.ts` | builds downstream effect records that other package owners can configure around the same prompt. |
| `do-work/create-decision-prompt.ts` | builds the subject, evidence, attachment, and prompt action input. |
| `do-work/publish-decision-result.ts` | builds and submits judge/comparison/progress action input. |
| `do-work/submit-decision-response.ts` | builds and submits the response action input. |
| `read-data/practice-decision-loop-types.ts` | defines the generic DTO contract. |
| `read-data/read-practice-decision-loop.ts` | turns generic records into prompt-centered state. |
| `show/PracticeDecisionLoopSurface.tsx` | renders the generic question, choices, reason box, and submit action. |
| `show/mount-practice-decision-loop.tsx` | mounts the React surface. |
| `test/practice-decision-loop-scoped-feed.test.ts.held` | A test of the package, held: reads the package boundary file things-to-store-and-run.json (or the package's own data path), which is not carried |
| `test/practice-decision-loop.test.ts.held` | proves the genericity and hostile fixtures. (held: imports react or shared ui parts (tools/ui) that live in apps tools/ui, not in the Workshop) |

### Not carried

- 5 files: generated build output of the retired package runtime (entry scope, built entry bytes); not carried
- 5 files: package README, package.json or ignore file; this folder has its own README
- 2 files: proof evidence of the package (screenshots, proof scripts and notes); not carried
- 1 file: maps package entries to the retired package runtime's entry scope; not carried
- 1 file: the package boundary file: record contracts, actions and surfaces for the retired package runtime (slot workflows, owner targets); not carried

The receipt's `not_carried` names each path.

## Moved out of this folder (rule a-tool-is-only-what-the-store-cannot-do)

The record half of `tool:practice` left this folder for `workflow:keep-practice-cards-and-grades` (tools/workflows). Where each part of `read-data/practice-cards.mjs` and `practice-cards.json` lives now:

| Old part | Now |
|---|---|
| `practice`, its operations `add`, `grade`, `remove`, `cards`, `due`, `remind` | the recipe's `operations` input and `keep` step, in the person's store |
| `cardId` (deck and prompt, BLAKE3, 16 hex) | the recipe's `source.note`: the same id, so existing cards keep it |
| `readAll`, `standings` (cards with grades folded into their standing) | the recipe's `look` and `keep` steps read the store, then `tool:list-what-is-due` (this folder) folds the standing |
| `policyOf` (policy in the request, else the policy record; no default) | the recipe's `input_schema` and `source.note` |
| `masteryOf` (`interval_days / mastered_at_days`, times 1000) | the recipe's `source.note` rule, computed from the state `tool:schedule-next-review` returns |
| `shown` (the card answer shape) | the recipe's `prove` answer |
| `practice-cards.json` (record types, default deck, id prefixes, mastery field and scale, due limit, sentences) | the recipe's `source.note`; the store's own names |
| `test/practice-cards.test.mjs` | the lane proof (old module as oracle over 15 attempts, PostgreSQL (PGlite) and a JSON folder, all equal) |

The scheduling (`review-schedule.mjs`, `tool:schedule-next-review`, `tool:list-what-is-due`) is unchanged, except that `tool:list-what-is-due` now also returns each item's `lapse_count`.

Four things the first tool did that the first move left out are in the recipe again, each proved by its prove step: a daily 09:00 reminder (the recipe's `daily-reminder` wake) and a remind that tells the person once a day through `workflow:tell-the-person` (key `practice:<date>`), the mean mastery in a cards read with mastery 0 for a card that just lapsed, a card added again keeping its `source_ref` unless given null, and an optional `max_cards` cap (the old tool's 2000 was a fixed number; here it is the person's input).
