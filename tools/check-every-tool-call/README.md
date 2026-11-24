# tools/check-every-tool-call/

Runs the person's checks on every tool call an AI makes, in any session that can reach their check lists through the existing authorized list owner. Each check is a row of the person's check list; its `full_definition` is the row the hook dispatcher runs. A repository's Claude settings start `python3 do-work/check_switches.py run <settings file>` for each tool call. The runner reads a local snapshot, picks the rows for this call, runs each row's `workshop_run` command from this Workshop, and answers the harness. A list it cannot read is reported on every call (`check list unreachable: <why>`), not counted as a passed check, and refuses nothing. The person's check rows themselves (`record:check:<id>`, kind `check`) are judged too: a row whose `kinds` name `git-commit`, `git-push` or `tool-call` judges what that call publishes with the one judge (`do-work/judge-check-rows.mjs`), and its `fixtures` prove it.

`check_switches.py` and `guard_rows.py` moved here from the hook dispatcher (`moved-from.json`, `ports/`). The dispatcher imports this owner, so one copy reads the rows and one copy picks and answers. The reader no longer calls a retired records address or loads an agent key. Its caller declares the existing list owner's command; that owner opens its database and owns its table and value projection.

## Files

| File | Purpose |
|------|---------|
| `do-work/check_switches.py` | `refresh(state)` reads every declared list type, across every page, through the DATA-declared reader command. It replaces a local snapshot whole: exact Off rows (`off`), every guard row's value (`rows`) and the check rows (`checks`). A failed read keeps the old snapshot and writes a bounded reason beside it (`<snapshot>.unreachable`). `apply(guards, state)` drops rows marked Off only while `honour_off` is true, and says each mark. `run <settings file>` answers one hook event: the first call waits for a reader only when no snapshot exists; subsequent stale reads refresh detached. It keeps rows that name `workshop_run`, picks and answers with `guard_rows.py`, and fills `{tools}`, `{repository}` and `{tool_input.<field>}` in each argument list. Exit 0 passes in silence; exit 2, or a failure under `failure_policy: "deny"`, refuses with the row's output. Settings come from `configure(rules)` or `CHECK_LIST_SETTINGS`. |
| `do-work/guard_rows.py` | `chosen(chain, harness, event, payload, env)` picks rows for harness, event, scope and tool (`on`, `acts_on`, `skip_when`, `requires_env`). `merge(event, results)` makes one answer from every row's answer. Exit 2 refuses; another failure refuses only under `failure_policy: "deny"`. |
| `do-work/judge-check-rows.mjs` | Check rows on one call, judged through `tools/check-against-a-persons-rules-and-verdicts` rules mode. `git-commit` reads staged added lines and whole staged JSON values; `git-push` reads those units over commits since HEAD left origin/main; `tool-call` reads the call as a view and each input string. A failed unit refuses with each finding's `says`. A row that states no deterministic test is read by a model, reported and never refused. Off rows are reported and not judged. `fixturesHold(row)` checks every declared pass/refuse fixture; a call writing a row whose fixtures fail is refused. The `fixtures` command is `tool:check-a-check-rows-fixtures`. |
| `read-data/check-rows.json` | Unit kinds, JSON file selection, fixture placement, check-row input shape and every word the row judge says. |
| `tool-rows.json` | `tool:check-a-check-rows-fixtures`: `{ rows }` in; `{ holds, rows: [{ id, holds, checked, wrong, no_fixtures?, broken?, read_by_a_model? }], lines }` out. Packs the row judge and its imports. |
| `test/check-rows-judge-commits-and-pushes.test.mjs` | Synthetic rows prove their fixtures, staged and pushed JSON literals, word checks, tool calls, Off reporting, model-only rows, broken fixtures, written-row refusal and the packed container entry. Its declared synthetic reader filters by type and `where`. |
| `test/run-the-check-list.test.mjs` | The actual runner with a synthetic authorized list owner: absent reader and 401 remain unchecked and visible; an applicable row refuses in its own words; other scopes/tools/commands do not run; Off policy is preserved; reader commands may come from the environment; the linked port-contract consumer accepts and refuses its declared cases; failed refreshes back off. |
| `test/check-switches-reader.test.py` | Synthetic-only process-boundary checks: stdin data, no shell or key lookup, bounded pages/deadlines, command validation, safe failures, failed-process rejection and repeated-cursor refusal. |
| `test/fixtures/read-list-page.py` | Synthetic list owner for the runner tests. Its local test server owns all rows and backend responses. Never a production reader. |
| `ports/check-switches.json`, `ports/guard-rows.json` | Source and adaptation contracts, including snapshot, switch and caller-owned reader invariants. |
| `read-data/settings.json` | Default caller DATA: `CHECK_LIST_READER` names a JSON argument list; guard/check types, exact Off semantics, snapshot cadence, scope and per-call row judge. No credentials or database layout. |
| `moved-from.json`, `part.json` | The original moves and the tree that imports these files. |

## Settings

```json
{
  "rows_from": { "command_from": { "env": "CHECK_LIST_READER" }, "page": 200, "timeout_seconds": 30 },
  "types": [{ "type": "record:hook-guard", "id_prefix": "record:hook-guard:" },
            { "type": "record:check", "where": { "kind": "check" }, "id_prefix": "record:check:", "into": "checks" }],
  "field": "on", "off_value": "Off", "detail_fields": ["why_off", "switched_by", "switched_at"],
  "snapshot": { "file": "check-switches.json", "refresh_seconds": 60 },
  "honour_off": false, "harness": "claude", "scope": "every-repository",
  "check_rows": {
    "events": ["PreToolUse"],
    "unit_kinds": [
      { "kind": "git-commit", "acts_on": { "tools": "Bash", "fields": ["command"], "matches": "\\bgit\\b[^\\n]*\\bcommit\\b" } },
      { "kind": "git-push", "acts_on": { "tools": "Bash", "fields": ["command"], "matches": "\\bgit\\b[^\\n]*\\bpush\\b" } }],
    "otherwise": "tool-call", "fixtures_field": "fixtures",
    "judge": ["node", "{tools}/check-every-tool-call/do-work/judge-check-rows.mjs", "hook", "--root", "{repository}", "--kind", "{kind}"],
    "timeout_seconds": 120
  }
}
```

`rows_from.command` is a nonempty argument list. Otherwise `command_from.env` names an environment variable holding that list as JSON, never shell text. The command is the caller's existing authorized SQL/list reader. It receives `{type, limit, where?, after?}` on stdin and returns one JSON page `{records: [{id, value}], next: string|null}` on stdout; every value is an object. Page size is 1–1000 and the process deadline is at most 180 seconds. A nonzero exit, missing/malformed page, invalid row or repeated cursor fails the refresh. An owner error may return `{error: {status: 401}}`; only the bounded status is reported, never its message, stderr, rows or command contents. The runner reads no database credential and has no HTTP/keychain fallback.

A type's `where` is passed unchanged to its owner on every page. `into` names the snapshot group (`rows` by default). The old snapshot is replaced only after all declared pages succeed. A successful refresh clears the old unreachable marker. A failed refresh retains the snapshot and backs off for `snapshot.failed_retry_seconds`, or `refresh_seconds` when no separate failure cadence is declared. The snapshot lives in `CHECK_LIST_STATE`, else under `~/.cache/check-every-tool-call/` named for the settings file.

For each call, `check_rows.unit_kinds` selects kinds using the same `acts_on` tool/command matching as guard rows, else `otherwise`. Matching check rows go to `check_rows.judge` on stdin as `{rows, event}`. Exit 2 refuses; exit 0 says its `systemMessage`; an unavailable judge is explicitly unjudged and refuses nothing. A call writing check-row fixtures is judged even when no existing row is selected.

## A repository's hook

Each repository whose sessions are checked carries this hook in its `.claude/settings.json`. It finds the tool through `CHECK_EVERY_TOOL_CALL`, else in the repository or a checkout beside it, and uses `CHECK_LIST_SETTINGS` or the default DATA. A session with no reader or Workshop reports that boundary on every call.

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "",
      "hooks": [{
        "type": "command", "timeout": 180,
        "command": "t=\"${CHECK_EVERY_TOOL_CALL:-}\"; case \"$t\" in *://*) d=\"$HOME/.cache/check-every-tool-call/workshop\"; [ -d \"$d/.git\" ] || git clone -q --depth 1 \"$t\" \"$d\" >/dev/null 2>&1; t=\"$d/tools/check-every-tool-call\";; esac; if [ -z \"$t\" ]; then for c in \"$CLAUDE_PROJECT_DIR\" \"$CLAUDE_PROJECT_DIR\"/../*; do if [ -f \"$c/tools/check-every-tool-call/do-work/check_switches.py\" ]; then t=\"$c/tools/check-every-tool-call\"; break; fi; done; fi; if [ -f \"$t/do-work/check_switches.py\" ]; then exec python3 \"$t/do-work/check_switches.py\" run \"${CHECK_LIST_SETTINGS:-$t/read-data/settings.json}\"; fi; echo '{\"systemMessage\": \"check list unreachable: no Workshop (CHECK_EVERY_TOOL_CALL names none and none is beside this repository)\"}'"
      }]
    }]
  }
}
```

## Dependencies

**Depends on:** Python 3 standard library and the caller's declared authorized list reader. The row judge also uses Node 22, the Workshop's installed packages (`npm ci`), `tools/check-against-a-persons-rules-and-verdicts` and `tools/judge-words`.

**Depended on by:** repository Claude hooks and the hook dispatcher importing this Workshop's committed export. Caller source, reader command and DATA must be delivered together; never edit the exported symlink or enable unrelated rules to repair a read.
