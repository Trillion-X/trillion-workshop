# tools/check-every-tool-call/

Runs the person's checks on every tool call an AI makes, in any session that can reach their check lists: a session on their own computer, or a cloud session that only has a repository. Each check is a row of the person's check list; its `full_definition` is the row the hook dispatcher on their computer runs. A repository's Claude settings (`settings.json` in its `.claude` folder) start `python3 do-work/check_switches.py run <settings file>` for each tool call; it reads the rows from where the settings say, picks the ones for this call, runs each one's `workshop_run` command from this Workshop, and answers the harness. A list it cannot read is said on every call (`check list unreachable: <why>`) and refuses nothing.

`check_switches.py` and `guard_rows.py` moved here byte for byte from the hook dispatcher on the person's computer (`moved-from.json`, `ports/`; that repository is private, so each source is named by its commit and the identity of its path); `check_switches.py` then gained the `run` verb and a door named by the environment. The dispatcher there imports these copies, so one copy reads the rows and one copy picks and answers.

## Files

| File | Purpose |
|------|---------|
| `do-work/check_switches.py` | The one reader of the check rows. `refresh(state)` reads every row of the declared list types through the door (`records:list`, paged) and replaces a local snapshot whole: the rows marked Off (`off`) and every row's value (`rows`). A failed read keeps the old snapshot and writes why beside it (`<snapshot>.unreachable`). `apply(guards, state)` drops rows marked Off only while `honour_off` is true, and says each mark. `run <settings file>` (`run_the_check_list(event, settings_file)`) answers one hook event: it reads the snapshot (the first call of a session waits for the door; later calls refresh in the background), keeps the rows that name `workshop_run`, picks and answers with `guard_rows.py`, and runs each picked row's argument list with `{tools}` (this Workshop's tools folder, found through any link to this file), `{repository}` and `{tool_input.<field>}` filled in. A row's command is a plain command: exit 0 passes in silence; exit 2, or any failure of a row with `failure_policy: "deny"`, refuses with its output. The settings are the caller's DATA: `configure(rules)`, or the JSON file named by `CHECK_LIST_SETTINGS`. |
| `do-work/guard_rows.py` | The dispatcher's choosing and answering: `chosen(chain, harness, event, payload, env)` picks the rows for a harness, event, scope and tool (`on`, `acts_on`, `skip_when`, `requires_env`); `merge(event, results)` makes the one answer from every row's answer (exit 2 refuses; another failure refuses only under `failure_policy: "deny"`). |
| `test/run-the-check-list.test.mjs` | `run` against a made-up door: no key and a 401 are said on every call and refuse nothing; a row that applies refuses in its own words; rows for another scope, another tool or an unmatched command do not run; a row marked Off still runs and the mark is said; the door can come from the environment; and the port-contract row, started through a link to this tool, refuses a commit of a feature file no contract claims and lets other commits through in silence. |
| `ports/check-switches.json`, `ports/guard-rows.json` | The moves: the source repository, commit and path, the byte-copy commit, and when the old copies leave. |
| `read-data/settings.json` | The settings `run` uses when the session names none: the door from `CHECK_LIST_DOOR`, the key from `CHECK_LIST_KEY`, the check rows of type `record:hook-guard`, scope `every-repository`. |
| `moved-from.json`, `part.json` | Where each moved file came from, and the tree that imports them (`imported_by`). |

## Settings

```json
{
  "door": { "url_from": { "env": "CHECK_LIST_DOOR" }, "address": "@own-records", "method": "records:list",
            "key_from": { "env": "CHECK_LIST_KEY" }, "page": 20, "timeout_seconds": 10 },
  "types": [{ "type": "record:hook-guard", "id_prefix": "record:hook-guard:" }],
  "field": "on", "off_value": "Off", "detail_fields": ["why_off", "switched_by", "switched_at"],
  "snapshot": { "file": "check-switches.json", "refresh_seconds": 60 },
  "honour_off": false, "harness": "claude", "scope": "every-repository"
}
```

The door is `door.url`, or the environment variable `door.url_from` names. `key_from` is `{ "env": name }` (a cloud session's own key) or `{ "keychain": item }` (the person's computer). The key is read at refresh time and sent only in the Authorization header. A page of 20 rows keeps each answer well under a door's 64 KiB. The snapshot lives in `CHECK_LIST_STATE`, else a folder under `~/.cache/check-every-tool-call/` named for the settings file.

## A repository's hook

Each repository whose sessions are checked carries this `settings.json` in its `.claude` folder. It finds this tool through `CHECK_EVERY_TOOL_CALL` (the tool's folder, or a git address of this Workshop, cloned once into `~/.cache/check-every-tool-call/workshop`), else in the repository itself or a checkout beside it, and runs it with `CHECK_LIST_SETTINGS` or `read-data/settings.json`. A session where none is found says so on every call.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "timeout": 180,
            "command": "t=\"${CHECK_EVERY_TOOL_CALL:-}\"; case \"$t\" in *://*) d=\"$HOME/.cache/check-every-tool-call/workshop\"; [ -d \"$d/.git\" ] || git clone -q --depth 1 \"$t\" \"$d\" >/dev/null 2>&1; t=\"$d/tools/check-every-tool-call\";; esac; if [ -z \"$t\" ]; then for c in \"$CLAUDE_PROJECT_DIR\" \"$CLAUDE_PROJECT_DIR\"/../*; do if [ -f \"$c/tools/check-every-tool-call/do-work/check_switches.py\" ]; then t=\"$c/tools/check-every-tool-call\"; break; fi; done; fi; if [ -f \"$t/do-work/check_switches.py\" ]; then exec python3 \"$t/do-work/check_switches.py\" run \"${CHECK_LIST_SETTINGS:-$t/read-data/settings.json}\"; fi; echo '{\"systemMessage\": \"check list unreachable: no Workshop (CHECK_EVERY_TOOL_CALL names none and none is beside this repository)\"}'"
          }
        ]
      }
    ]
  }
}
```

## Dependencies

**Depends on:** Python 3 standard library; the person's door (`records:list`).

**Depended on by:** each repository's Claude settings hooks; the hook dispatcher on the person's computer imports `check_switches.py` and `guard_rows.py` from its export of this Workshop.
