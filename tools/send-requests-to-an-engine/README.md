# Send requests to an engine

This package lets an AI harness (Codex, Claude, or any other) ask one running
app what it can do, find records, and run one declared action — without the
harness getting raw shell or file access.

Plain speak: **it is the messenger between an AI session and a running app.**
The AI says "run this action with this input." This package carries the request.
The running app does the work.

## What this package is NOT

- It is not `local.files`. `local.files` is a native target inside the app.
- It does not choose which app to talk to (caller selects by `--app-id`, or by
  the app-open owner's status file with `--status-file`).
- It never learns a port. A local app is reached over the Unix-domain socket
  its current shell-ready owner publishes in that status file
  (`attachments.forwarding_socket`; older owner files used
  `shell_attachments.forwarding_socket`);
  a remote engine is reached by a declared name in `engine-connections.json`.
  Since 2026-09-09 no customer machine binds a port and no file carries one.
- It does not hold credentials, workflow logic, or package data.
- It cannot run anything the app has not already declared as an action.

## The four tools

| Tool | What it does |
|---|---|
| `list_running_app_actions` | Returns every declared action in the selected running app, including each action's `input_schema` |
| `find_running_app_records` | Finds current records by conditions |
| `call_running_app_action` | Runs exactly one declared action with caller input; optional `timeoutMs` is bounded to 1–600,000 ms and omitted calls retain the 30-second action default |
| `read_running_app_record` | Reads one record by exact address; calibrated absence is `found:false`, never an empty list |

## Owner CLI equivalent

Every tool has a command-line twin when MCP is not exposed in your session:

```bash
node .../send-requests-to-an-engine/do-work/ask-the-running-app-what-it-can-do.mjs \
  actions --app-id trillion --json
```

Long-running declared actions can use MCP `timeoutMs` or CLI `--timeout-ms`; both use the same bounded transport option.

See `how-to-use.md` for the full cookbook and `capability-map.md` for which
package owns each capability you might need.
