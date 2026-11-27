# tools/see-what-is-being-worked-on

The screens that show everything being worked on, by every AI and every person, as one live tree: old trillion's `tools/work-map/` (`show/work-map-screen.tsx` and its join in `read-data/`), `tools/workflow-canvas/` and the message task canvas (`message-task-canvas.mjs`), whose own READMEs are in `work-map/` and `workflow-canvas/`. The screens need the workspace and a browser; the row runs the part that needs neither, the join that turns the answers already read into the tree.

## Files

| File | Purpose |
|------|---------|
| `do-work/join-work-map.mjs` | `joinWorkMap({ answers, from? })` → `{ nodes, lines, counts }`: `read-data/join-records.mjs` (`joinRecords`, then `branchOf` for `from`) over the sources in `read-data/work-map-sources.json`, with the rows left out of the cards (what `what-this-tool-does-and-how-to-run-it.json` runs) |
| `what-this-tool-does-and-how-to-run-it.json` | The row `tool:join-what-is-being-worked-on-into-a-tree`, with a sample run where a goal holds a goal, a decision and the job an AI took for it |
| `README.md` | This file |
| `test/message-task-canvas.test.mjs` | The message task canvas projection. Moved byte for byte from trillion-apps `web/test/`. |
| `test/message-tasks.test.mjs` | Message tasks filtered by the formula engine's rules. Moved byte for byte. |

## The row

`tool:join-what-is-being-worked-on-into-a-tree` reads nothing from the person's store: the caller gives what each read answered. Reading those answers, drawing the board, table and timeline and grouping message tasks stay with the screens. `message-task-canvas.mjs` still imports `./work-title.mjs`, which is not in this folder; the row does not load it.

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/ai-work-screen.tsx` | The screen: AI work: who handed what to which AI (`tool:screen-ai-work`) |
| `show/ai-work-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
| `web/src/workspace/message-task-canvas-screen.tsx` | The screen: The tasks every message was broken into (`tool:screen-message-task-canvas`) |
| `show/message-task-canvas-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |

## Task page

`task-page/` draws a pursuit's task page (Now and History) from that pursuit's own task tables, read on each request by `readTaskPage(runSql)`; its mount is `task-page/show/mount-task-page.tsx`. `tool:serve-the-task-pages` shows those pages on this computer: a kept session the door serves as a page on its loopback address, signed in with the person's own sign-in. See `task-page/README.md`.
