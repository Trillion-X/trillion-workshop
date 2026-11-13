# tools/see-what-my-ais-did

What every AI connected to a person's account did, kept so the person can see it on the AI activity screen and their AIs can read what other AIs did: `activity.mjs`, moved from old trillion's `src/activity.mjs`. Which tool calls leave a row and how each reads is DATA, `activity-marks.json`, brought in byte for byte (`moved-from.json`).

## Files

| File | Purpose |
|------|---------|
| `activity.mjs` | Activity rows from tool calls (`activityRow`, `unmarkedActivityRow`), what a person's access keeps (`keptActivityRow`), keeping and reading them in generations (`keepActivity`, `readActivity`) and the trace of one item |
| `activity-marks.json` | Which calls leave a row, their labels, where each row's item, title, uses and for are found, and when an answered call still failed |
| `do-work/keep-and-read-activity.mjs` | `keepAndReadActivity({ calls, access?, read? })`: the calls handed in, kept in an in-memory SQLite store and read back newest first (what `tool-rows.json` runs) |
| `moved-from.json` | Where `activity-marks.json` came from, with the identity of its bytes |
| `tool-rows.json` | The row `tool:list-what-my-ais-did`, with a sample run that reads back the one call that failed |

## The row

`activity.mjs` imports `./execution-context.mjs`, which is in `tools/keep-and-wake-ai-sessions-on-this-computer/src/` with its own imports, so the row lays this folder beside that one in the run (`/opt/activity/src`) instead of keeping a second copy. It keeps nothing after the run, writes no file and sends nothing. Tracing one item and drawing each app by its sign-in picture stay with the screen.

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/activity-screen.tsx` | The screen: AI activity (and the Errors tool's list of what failed) (`tool:screen-activity, tool:errors`) |
| `show/activity-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
| `web/src/workspace/activity-trace-screen.tsx` | The screen: How one thing happened (`tool:screen-activity-trace`) |
| `show/activity-trace-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
