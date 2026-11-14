# How to use send-requests-to-an-engine

## 1. See what the app can do

MCP:
```json
{"tool": "list_running_app_actions", "arguments": {}}
```

CLI:
```bash
node do-work/ask-the-running-app-what-it-can-do.mjs actions --app-id trillion --json
```

## 1a. Discover which apps are running

CLI:
```bash
node do-work/ask-the-running-app-what-it-can-do.mjs list-running-apps
```

Returns every installed Bitfield app whose owner has published a transport, hex-decoded
to its human-readable `app_id`, with `running` set from a live `/boot` answer over that
transport (a socket path for a local app). A status file outlives a close, so its
presence is never reported as running. No more guessing app IDs.

## 1b. Native local.files actions

The `actions` command now surfaces six native `local.files` actions alongside
app-declared workflow actions:

- `action:read-local-file` — read any local file (returns base64 bytes)
- `action:read-local-file-range` — read a byte range
- `action:list-local-directory` — list a directory
- `action:scan-local-files` — recursively enumerate a bounded glob (requires a carrier whose native `local.files` target implements `scan_files`)
- `action:write-local-file` — write a local file
- `action:move-local-path-to-trash` — trash a path

These run through the same `execute-definition` lane. Pass `--include-output`
to see the result payload.

Example (read a file):
```bash
node do-work/ask-the-running-app-what-it-can-do.mjs \
  execute-definition --app-id trillion \
  --definition-id action:read-local-file \
  --input-json '{"path":"/absolute/path/to/file.md"}' \
  --include-output
```

## 2. Run one declared action

MCP:
```json
{"tool": "call_running_app_action",
 "arguments": {"definitionId": "action:read-ai-records-cli-registry", "input": {}, "timeoutMs": 120000}}
```

`timeoutMs` is optional, must be an integer from 1 through 600,000, and defaults to 30,000 for action execution when omitted. The CLI twin is `--timeout-ms 120000`.

Only action ids returned by step 1 are legal. If the id is not listed, the app
has not declared it — see "When the action is missing" below.

If you pass a bare ID without the `action:` prefix and the engine cannot find
it, the CLI now returns a hint: `Try: --definition-id action:<id>`. Always use
the full `action:` namespace.

## 3. Select a different app

Set `RUNNING_APP_STATUS_FILE` when starting the MCP server, or pass
`--status-file` / `--app-id trillion` to the CLI. App selection is caller data;
this package names no app. The `transport` command prints what the selected
app's owner published: `{"socketPath": ...}` for a local app, `{"url": ...}`
only for a hosted deployment that declared a TCP listen address.

## 4. When the action is missing

A missing action is a real answer, not a failure of this package:

1. The capability may exist as a **native target** (`local.files`,
   `compute.process`, `slot::http-client`) that no declared action exposes yet.
2. The owning package may not be installed in this app.
3. The package may exist in the store but not be converged into the running set.

Never fall back to raw shell. Follow `capability-map.md` to find the owner.

## 5. Install a package from the store

1. Browse the catalog (`bitfield-package-store-catalog` / browse surface).
2. Install with `install-one-app-open-bundle-into-this-computer` (or the
   plural owner for several).
3. Converge with `converge-one-installed-app-to-its-current-handle`.
4. Re-run `list_running_app_actions` and confirm the new action appears.

## 6. Create a capability that does not exist

1. Search existing packages first (L093 inventory) — most capabilities exist.
2. If an owner exists, add the missing declared action as DATA to that package.
3. Converge the package into the engine with
   `make-packages-match-their-source`.
4. Run the declared checks, publish to the live store, read back.
5. Only if no owner exists anywhere, follow
   `1000000000x-capability-acquisition-and-job-completion.md` for a new package.

## Stale sessions

An already-running AI session does not hot-load new MCP registrations or
instruction files. If your session was started before this package was
registered, restart the session, or use the owner CLI above. The runtime hook
denial will tell you the same thing.

## Common failure modes

| Symptom | Real cause | Fix |
|---|---|---|
| "MCP resource list blocked" | Fleet tool allowlist, not this package | Use the four declared tools or the CLI twin |
| Action id not found | App never declared it | Follow capability-map.md owner |
| App unreachable | Trillion shell/port not where the owner file says | Re-select owner file / app id |
| `local.files` reports `unsupported ... operation: scan_files` | The declared action is newer than the running carrier's native target | Rebuild/install the carrier through its declared owner, then retry `action:scan-local-files` |
| `local.files` mentioned in docs | That is a native target, not this MCP | Find the declared action that reaches it |
