# tools/plan-tasks-and-todo-lists

Calendar tasks and to-do lists: named task lists with counts, tasks scheduled onto a day or time, and mail turned into tasks. The Calendar task owner (`calendar-tasks.mjs`) is kept here as it was moved; it needs the records store and the timed-action parts, which this folder does not have. The row runs the part that is pure: which built-in list (calendar, email or other) each email becomes a task in.

## Files

| File | Purpose |
|------|---------|
| `calendar-tasks.mjs` | The Calendar task owner from Trillion-X/trillion src/calendar-tasks.mjs (moved in a9ee258, #76); not run here, its timed-action and planner imports are not in this folder |
| `calendar-task-messages.mjs` | `classifyMessage(message, rows)`: the built-in list a mail message becomes a todo in, by the `email_split` rows (brought in byte for byte, `moved-from.json`) |
| `calendar-tasks.json` | DATA: the task list's fields, colours, priorities, working hours, preferences, `email_split` rows and words (brought in byte for byte, `moved-from.json`) |
| `sort-mail-into-task-lists.mjs` | `sortMailIntoTaskLists({ messages })`: each message's built-in list and the count per list (what `tool-rows.json` runs) |
| `moved-from.json` | Where each brought-in file came from, with the identity of its bytes |
| `tool-rows.json` | The row `tool:sort-mail-into-built-in-task-lists`, with a sample run that sends an invitation to the calendar list |
| `README.md` | This file |
