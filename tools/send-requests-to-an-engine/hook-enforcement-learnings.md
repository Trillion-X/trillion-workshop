# Hook enforcement learnings (Codex + this bridge)

## Root cause of the cross-session bypass (corrected 2026-09-07, live-proven)

**The earlier "stale host process" theory in this file was WRONG and is
retracted.** The real cause is **modified hook trust**: the two PreToolUse
hook commands in `~/.codex/hooks.json` were edited (fail-closed wrapper
added) AFTER their hashes were trusted, so `hooks/list` reports
`trustStatus: "modified"` for `pre_tool_use:0:0` and `:0:1` while every
other hook reports `trusted`. Codex **silently skips** modified hooks — no
error, no denial, no event — so the terminal guard never runs in ANY
session, fresh or old. SessionStart/Stop hooks kept firing because their
trust remained valid, which is exactly what made the stale-process theory
look true.

Facts verified live via app-server `hooks/list` (0.151.0) on 2026-09-07:

- Codex executes a user hook only while its persisted `trusted_hash` equals
  the hook's CURRENT `currentHash`. Divergence = `trustStatus: "modified"` =
  silently skipped, fleet-wide, until re-trusted.
- Stored PreToolUse hashes (`998949f…`, `2eeaab6…`) ≠ current hashes
  (`2f6f4b0…`, `8294cae…`) — every other event's stored hash matched exactly.
- Diagnosis owner: app-server JSON-RPC `hooks/list` with `{"cwds":[…]}`
  against a **persistent** stdin connection (an early-EOF pipe silently
  drops the response — that false negative fed the "not invoked" theory).
- Repair owner: app-server `config/batchWrite`, one edit per key
  `hooks.state."<hooks-list key>".trusted_hash` = `currentHash`,
  `mergeStrategy: "upsert"`, `reloadUserConfig: true`; then `hooks/list`
  again and require `trustStatus: "trusted"` + a live denial probe.

## Repair

1. Read current hashes from `hooks/list`; upsert them into
   `[hooks.state]` via `config/batchWrite` with `reloadUserConfig: true`.
2. Re-run `hooks/list`: both PreToolUse entries must say `trusted`.
3. Proof: a nested `codex exec` probe trying a raw `cat` must be DENIED
   (`Tool call blocked by PreToolUse hook:`), and other chats' raw commands
   must return the guard denial. If the live Desktop daemon does not
   hot-reload, one full app restart picks up the repaired trust.

## Standing rule

Any edit to a hook's command string (including adding a wrapper) rotates its
`currentHash` and silently disables that hook everywhere until trust is
re-persisted. After EVERY hooks.json edit, run `hooks/list` and require
`trustStatus: "trusted"` — never assume prior trust survives.

## Legal lanes through this package (exact shapes)

- Owner front door (single segment, no pipes):
  `node .../send-requests-to-an-engine/do-work/ask-the-running-app-what-it-can-do.mjs
  <subcommand> --app-id trillion`.
- Subcommands: `url | boot | actions | read-record | scan-current-under-path |
  execute-definition | end-process-session`.
- `execute-definition` HIDES action output unless you pass `--include-output`.
  That flag is the difference between "bridge is wedged" and a 1ms result.
- Long-running actions use `--timeout-ms N` on the CLI or `timeoutMs` over MCP. Values are bounded to 1600,000 ms; omitted action calls retain the 30-second default.
- Reads/searches of local files go through `execute-definition` with the live
  local.files actions: `action:read-local-file`, `action:read-local-file-range`
  (byte `offset` + `length`, NOT line numbers), `action:list-local-directory`, and
  `action:scan-local-files` when the selected app carrier implements native `scan_files`.
- Flag order matters: app selection goes AFTER the subcommand
  (`execute-definition ... --app-id trillion`).

## Engine op lane health

The 2026-09-07 "wedged engine" state (5+ minute hangs on calls) cleared
without a code change; reads and action dispatch now return in milliseconds.
Before declaring a wedge, retest with `--include-output` and a tiny file.
