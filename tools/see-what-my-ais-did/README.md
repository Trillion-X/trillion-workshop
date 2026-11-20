# tools/see-what-my-ais-did

What every AI connected to a person's account did, kept so the person can see it on the AI activity screen and their AIs can read what other AIs did: `activity.mjs`, moved from old trillion's `src/activity.mjs`. Which tool calls leave a row and how each reads is DATA, `activity-marks.json`, brought in byte for byte (`moved-from.json`).

## Files

| File | Purpose |
|------|---------|
| `activity.mjs` | Activity rows from tool calls (`activityRow`, `unmarkedActivityRow`), what a person's access keeps (`keptActivityRow`), keeping and reading them in generations (`keepActivity`, `readActivity`) and the trace of one item |
| `activity-marks.json` | Which calls leave a row, their labels, where each row's item, title, uses and for are found, and when an answered call still failed |
| `do-work/activity-in-database.mjs` | `tool:keep-an-ai-activity-row` (one finished row, or one raw call through the marks) and `tool:read-ai-activity` (newest rows, or one item traced), in the person's own database |
| `do-work/activity-row-from-a-call.mjs` | `rowFromCall(call, access)`: one raw tool call turned into its row by the marks, or why it left none |
| `read-data/activity-generations.mjs` | The rules over the store: checked rows, links, generations (keep and roll), the list read and the trace read |
| `moved-from.json` | Where `activity-marks.json` came from, with the identity of its bytes |
| `tool-rows.json` | The rows `tool:keep-an-ai-activity-row` and `tool:read-ai-activity` |
| `test/activity-trace-bounds.test.mjs` | The bounds on the activity trace. Moved byte for byte from trillion-apps `web/test/`. |

## The row

`activity.mjs` imports `./execution-context.mjs`, which is in `tools/keep-and-wake-ai-sessions-on-this-computer/src/` with its own imports, so the row lays this folder beside that one in the run (`/opt/activity/src`) instead of keeping a second copy. The rows are kept in the person's own database by `tool:keep-an-ai-activity-row` and read by `tool:read-ai-activity`; the old in-memory run (`tool:list-what-my-ais-did`) was retired with its home named here. Tracing one item and drawing each app by its sign-in picture stay with the screen.

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/activity-screen.tsx` | The screen: AI activity (and the Errors tool's list of what failed) (`tool:screen-activity, tool:errors`) |
| `show/activity-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
| `web/src/workspace/activity-trace-screen.tsx` | The screen: How one thing happened (`tool:screen-activity-trace`) |
| `show/activity-trace-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
