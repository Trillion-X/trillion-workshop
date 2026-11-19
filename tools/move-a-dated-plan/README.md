# tools/move-a-dated-plan/

Plans the move of one plan's dated tasks when its start or end moves, as values. A plan of dated stages moves by a named
strategy (shift, absorb, distribute, accordion, shrink) and a lock mode (nothing, finished, started), and a deadline change never
leaves the plan in an impossible shape: the rules refuse loudly.

The store half is `workflow:move-a-dated-plan` (`tools/workflows/recipes/move-a-dated-plan.json` and its kit). It reads the plan's
task rows from the person's own store, calls `planTaskShift` here, and writes each change with its previous values kept as the undo.

## Files

| File | What it is |
|---|---|
| `src/date-shift.mjs` | `shiftStages` (the strategies and their invariants), `planTaskShift` (values in, values out: the plan, the moved tasks and their `changes` with `previous` dates), `shiftChoices`, `dayOf`, `dateOf`, `isDateShiftPath` (the GET route path of the choices). |
| `src/date-shift.json` | The strategies, lock modes and every word, as before. |
| `test/date-shift.test.mjs` | The strategies, invariants, refusals, the choices, and `planTaskShift` (changes, previous dates, dry run, refusals). |

## Moved out (rule a-tool-is-only-what-the-store-cannot-do)

| Old part | Now |
|---|---|
| `plannedTasks` (reading the plan's pages through the Calendar tasks owner, at most 500) | the recipe's `keep` step reads the store |
| `shiftCalendarTasks` (writing each change through `changeCalendarTask`, the undo) | `planTaskShift` plans; the recipe writes and keeps `previous` |
| `handleDateShiftRequest` POST (move) and its refusal | the recipe; the calendar owner still refuses a POST as before |
| `dateShiftTools`, `dateShiftAnnotations` (MCP wrappers over the routes) | removed: the recipe is the one way to move a plan |

The proof is in the lane: the old owner path (`shiftCalendarTasks` through the real local store) against the recipe's writes in
PostgreSQL (PGlite) and a JSON folder: the moved task, the final dates after the started lock, the undo, and the dry run.

The caller `tools/keep-my-calendar-in-my-accounts-own-records-with-its-lists-files/src/native-calendar-owner.mjs` now answers the
GET choices with `shiftChoices()` and keeps its POST refusal.
