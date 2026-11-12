# tools/plan-tasks-and-todo-lists

Calendar tasks and to-do lists: named task lists with counts, tasks scheduled onto a day or time, and mail turned into tasks. The Calendar task owner (`calendar-tasks.mjs`) loads and is tested here over a list store handed in (`tools/keep-lists-of-rows`); it has no row yet, since a row would reach the person's task list through the records door. The row runs the part that is pure: which built-in list (calendar, email or other) each email becomes a task in.

## Files

| File | Purpose |
|------|---------|
| `calendar-tasks.mjs` | The Calendar task owner from Trillion-X/trillion src/calendar-tasks.mjs (moved in a9ee258, #76). Only its import paths changed: wall time, zone drift and quiet hours are `tools/run-work-later-or-on-a-repeat/do-work`'s, the operation identity is `tools/shared-code/src/typed-operation-contract.mjs`, the day override is `parts/ui/show/schedule-calendar/schedule-planner.mjs` here |
| `parts/ui/show/schedule-calendar/` | `schedule-planner.mjs` (`planSchedule`, `dayOverrideOf`), its `.json` and `schedule-placement.mjs`, moved byte for byte by `move-rows/trillion-calendar-tasks-schedule-planner.json` |
| `test/` | `calendar-tasks.test.mjs`, `calendar-tasks-amie.test.mjs` and `schedule-calendar-planner.test.mjs`, moved with the planner (import paths only) |
| `calendar-task-messages.mjs` | `classifyMessage(message, rows)`: the built-in list a mail message becomes a todo in, by the `email_split` rows (brought in byte for byte, `moved-from.json`) |
| `calendar-tasks.json` | DATA: the task list's fields, colours, priorities, working hours, preferences, `email_split` rows and words (brought in byte for byte, `moved-from.json`) |
| `sort-mail-into-task-lists.mjs` | `sortMailIntoTaskLists({ messages })`: each message's built-in list and the count per list (what `tool-rows.json` runs) |
| `moved-from.json` | Where each brought-in file came from, with the identity of its bytes |
| `tool-rows.json` | The row `tool:sort-mail-into-built-in-task-lists`, with a sample run that sends an invitation to the calendar list |
| `README.md` | This file |

A task is settled only when the work it is linked to is finished: a task whose `source_id` is `workflow:<slug>` needs that workflow's run verdict to have passed, and a task whose description names an AI job (`ai-job:<key>`, written there by the lane launcher) needs that job done with a result (`calendar-tasks.json` `job_link`; the owner reads the job records through `options.jobs`).
