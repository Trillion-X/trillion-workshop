# tools/see-what-is-being-worked-on

The screens that show everything being worked on, by every AI and every person, as one live tree: old trillion's `parts/work-map/` (`show/work-map-screen.tsx` and its join in `read-data/`), `parts/workflow-canvas/` and the message task canvas (`message-task-canvas.mjs`), whose own READMEs are in `work-map/` and `workflow-canvas/`. The screens need the workspace and a browser; the row runs the part that needs neither, the join that turns the answers already read into the tree.

## Files

| File | Purpose |
|------|---------|
| `do-work/join-work-map.mjs` | `joinWorkMap({ answers, from? })` → `{ nodes, lines, counts }`: `read-data/join-records.mjs` (`joinRecords`, then `branchOf` for `from`) over the sources in `read-data/work-map-sources.json`, with the rows left out of the cards (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:join-what-is-being-worked-on-into-a-tree`, with a sample run where a goal holds a goal, a decision and the job an AI took for it |
| `README.md` | This file |

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
