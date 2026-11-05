# tools/settings/

The one reader every Workshop tool uses for a person's own settings. A library that every row reading settings packs
(`read-data`, `do-work`) at `/opt/settings`, beside `tools/records-door` at `/opt/records-door`. Its own row,
`tool:read-my-setting-for-a-tool`, reads one row of `list:settings` and says whether it is there and in use.

## Where settings live

A person's settings for a tool are rows of their generic list `list:settings`, each a record of type
`record:setting`:

| Field | Holds |
|---|---|
| id | `record:setting:<workshop-folder>~<scope_kind>~<scope_id>`, for example `record:setting:rank-library-formats-against-concepts~film~sample-film` |
| `name` | Words naming the row. |
| `tool` | The tool row id it sets, `tool:<id>`. |
| `scope_kind` | `person`, `film`, `piece` or `account`: what the settings are for. |
| `scope_id` | Which one (a film's slug, a piece's id, `all`). |
| `settings` | A JSON object: the numbers, paths, words and options the tool runs with. |
| `from` | Where they came from, `<old path>@<commit>`, or who wrote them. |
| `status` | `active`, `draft` or `retired`. Only an `active` row is used. |

This ports old Trillion's `setting` record kind: `src/decision-store.mjs` at Trillion-X/trillion `4ffa1dc4a2^`,
line 8 (a setting is a root record of type `setting`) and lines 751-754 (`setting(name)` reads `setting:<name>` and
answers its value or null). Here the id carries the tool's folder and the scope, so one tool never reads another's.

## How a tool reads them

A tool takes `settings_record` (the row's id) and optionally `settings` (an object) in its input. What it runs with
is, weakest first: its own defaults, the record's `settings`, the input's own `settings`. Plain objects merge key by
key; anything else is replaced whole. A named record that is absent, or not `active`, is refused with words saying
what to do: running on defaults when the person named their own would silently change the answer.

Its row grants only `records:read` on its own folder's prefix:

```json
"records": { "fd": 3, "rights": [{ "kind": "record:setting", "prefix": "record:setting:<folder>~", "operations": ["records:read"] }] }
```

- A **JavaScript** tool calls `settingsFor(input, { door, folder, defaults })` from `read-data/settings.mjs`.
- A **Python** (or any other) program is run under `do-work/run-with-settings.mjs --folder <folder> -- <program...>`.
  It reads the record, and hands the program the request with `settings` merged, `settings_from` naming the record,
  and `settings_record` taken out. The program lays its defaults under them with `read-data/settings.py`
  `settings_of(request, defaults)`. The program's output is passed through unchanged.

## Files

| File | Purpose |
|---|---|
| `read-data/settings.mjs` | `settingId`, `parseSettingId`, `checkSettingValue`, `readSetting(door, id, { folder })`, `layOver`, `settingsFor`. |
| `read-data/settings.json` | The row rules: list, type, id shape, scope kinds, required fields, statuses. |
| `read-data/settings.py` | `lay_over` and `settings_of` for Python programs. |
| `do-work/run-with-settings.mjs` | The wrapper above. |
| `test/settings.test.mjs` | Ids, row checks, the merge, reading through the stand-in records door, the wrapper running a made-up Python program. |
| `test/echo_settings.py` | That made-up program. |
| `tool-rows.json` | `tool:read-my-setting-for-a-tool`: `readSettingRow` under `tools/records-door`'s `run-an-export.mjs`, with records:read on `record:setting:`. |

## Dependencies

**Depends on:** `tools/records-door` (`read-data/records-door.mjs`), Node's standard library, Python 3.10+.

**Depended on by:** every tool whose input takes `settings_record`.
