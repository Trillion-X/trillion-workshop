# tools/plan-tasks-and-todo-lists

Tasks, and the calendar task lists a person keeps. A task is one kind of work: a `calendar-task` record whose `assignees` are the record ids of whoever may take it. An assignee may be a person, an AI, a workflow, a raccoon or anything else that has a record; nothing here asks what kind of thing an id names. An empty `assignees` list means anyone may take the task. Handing a task on is the `hand-on` move: it changes the assignees and gives the task back to waiting, nothing more.

The task rows read no store. The caller reads the records a move needs and hands them in as `input.records`; each write a row makes comes back as `keep`, and the caller keeps it conditioned on the value it read. Of two callers that read the same waiting task, only the first write is kept.

## Files

| File | Purpose |
|------|---------|
| `task-moves.json` | DATA: the task rules. States: To do, In progress, Waiting, Done, Broken, Not needed (Done, Broken and Not needed are terminal). `read_as` maps the words "Not started" to To do and "Blocked" to Waiting. Transitions, each `{ action, from, to, when, set, clear }`, cover take, release, hand-on, finish, fail, stuck, unstuck, withdraw, wait, resume, edit and plan. Priorities rank urgent, high, medium, low; the stale-take time is 120 minutes (the `taken_minutes` value of the take and release rows). |
| `task-moves.mjs` | The task rows: `giveATask`, `seeTasks`, `takeATask`, `changeATask`, `finishATask`, `seeWhoCanTakeWork`, and the functions they share (`taskRules`, `moveFor`, `movedTask`, `signalsOf`, `checkOutcome`, `checkContinuation`, `requestedOutcome`, `prepareProducedTask`). |
| `run-a-task-move.mjs` | The one caller for addressed operations: `readFor` reads the records a move needs, `runTaskMove` runs the row with `tools:run` and keeps its writes with one `records:write`. A record changed meanwhile answers `{ kept: false, reason: 'changed' }`. |
| `tool-rows.json` | The six task rows (below) and the row `tool:sort-mail-into-built-in-task-lists`. |
| `kits/` | One kit per task row, each with a worked example that the row answers. |
| `ports/task-lifecycle.json` | The port record for `task-moves.mjs`: what was kept from the AI job module, what changed, and the tests that prove it. |
| `calendar-tasks.json` | DATA: the task list's fields. A task keeps `assignees` (tags of record ids), `sent_by`, `taken_by`, `taken_at`, `outcome` and `result` as well as its own words. Status offers the task states above and settles Done, Broken and Not needed. Steps are the rows paired with `parent_id` through `children`; `progress` is their settled share. The planning switch is `plan_automatically`. |
| `calendar-tasks.mjs` | The Calendar task owner: the list's reads and writes, and the workflow check a task linked to a workflow must pass before it is settled. |
| `calendar-task-messages.mjs` | `classifyMessage(message, rows)`: the built-in list a mail message becomes a task in, by the `email_split` rows. |
| `sort-mail-into-task-lists.mjs` | `sortMailIntoTaskLists({ messages })`: each message's built-in list and the count per list. |
| `schedule-calendar/` under `parts/ui/show/` | `schedule-planner.mjs` (`planSchedule`, `dayOverrideOf`), its `.json` and `schedule-placement.mjs`. |
| `moved-from.json` | Where each brought-in file came from, with the identity of its bytes. |
| `part.json` | `task-moves.mjs`, `task-moves.json` and `run-a-task-move.mjs` are public. |
| `test/` | `task-moves.test.mjs` (the task rules, every row run as the container runs it, the races and the handoff), `task-moves-stores.test.mjs` (the same answers on PGlite and on a folder of JSON files), `run-a-task-move.test.mjs` (the caller over a fake account), `task-fields-match-task-moves.test.mjs` (the list holds the fields and states the rows use), and the calendar tests. |
| `README.md` | This file. |

## Rows

| Row | Input | Answer |
|-----|-------|--------|
| `tool:see-who-can-take-work` | `{ can?, live_only?, records }` | `{ who: [{ id, type, value, live, seen_at, busy }] }`: live first, then the stored `order` |
| `tool:give-a-task` | `{ as, key?, title?, description?, outcome?, priority?, assignees?, source?, obligations?, acceptance?, records }` | `{ task_id, status: written \| already-there, task }` |
| `tool:see-tasks` | `{ id }` or `{ status?, sent_by?, taken_by?, assignee?, limit?, records }` | `{ tasks, more }`, newest first |
| `tool:take-a-task` | `{ as, id?, only_mine?, records }` | `{ taken, tried, task_id?, reason?, task? }` |
| `tool:change-a-task` | `{ as, id, action, ... }`; action is one of the rules' actions, `hand-on` and `remove` included | `{ task_id, moved, from, to, reason?, task }` |
| `tool:finish-a-task` | `{ as, id, taken_at, result, check, summary?, records }` | `{ task_id, moved, from, to, reason?, task }` |

`as`, `sent_by`, `taken_by`, `assignee` and every assignee are record ids (`<kind>:<name>`). A task id is `record:calendar-task:<key>`.

## Handoff

`hand-on` is a change of assignees. From In progress, the taker hands the task on: `assignees` (required) name who may take it next, the task goes back to To do, and `taken_by` and `taken_at` are cleared. From To do, the giver or a named assignee may change the assignees while it waits. Nothing else moves with the handoff: no new task is made, and the task keeps its outcome, acceptance and checks.

## Settling

A task is settled (Done, Broken or Not needed) only when:

- its `source_id` is `workflow:<slug>`, and that workflow's latest run verdict has passed (the capability-check row `workflow-run-<slug>` in `everything-still-working`).

A task's steps are not a gate. Steps and the time slices a task is planned into are both child rows (`parent_id`); the share of settled steps is the task's `progress`, which the Lists owner works out on every read. The lane-job link (`job_link`) and the list's `needs_linked_records_to_set` mark were removed with the AI job concept: the mark was not implemented by the engine on trillion-rust origin/main, so it refused nothing.
