# tools/hand-work-to-ais/

This folder held a person's AI job handoff. Tasks replaced it: the task module, its rules, its six rows, their kits and tests live in `tools/plan-tasks-and-todo-lists`, where one kind of work (a `calendar-task`, whose `assignees` are record ids of anyone) covers what a job was. Handing work on is the `hand-on` move there. The AI job module (`read-data/ai-work.mjs`), its rules (`read-data/ai-work.json`), its six rows (`tool-rows.json`, now empty), its kits, its port and its tests were removed by that change.

## What remains here

| File | Purpose |
|------|---------|
| `agent-open-work-page.mjs` | The open-work page for an agent (kept; it is not part of the task module). |
| `packages/` | The agent packages this folder carries (kept). |
| `moved-from.json` | Where the files moved here came from, with their identities (kept). |
| `part.json` | No public files; it keeps the job-run screen offer (`tool:screen-job-run`). |
| `web/src/workspace/job-run.tsx` | The job-run screen. It still reads `ai-job` records and is not yet rewired to tasks. |
| `show/job-run-mount.tsx` | Its mount entry. |
| `test/` | The tests that remain: agent cards, legacy rows, job-run, hand-off reads and notification upgrades. |
| `tool-rows.json` | Empty: the six rows moved to `tools/plan-tasks-and-todo-lists/tool-rows.json`. |

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/job-run.tsx` | The screen: One job as the person watches it run (also drawn under the message box by the web client, which imports this file) (`tool:screen-job-run`) |
| `show/job-run-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
