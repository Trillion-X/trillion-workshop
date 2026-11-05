# tools/settings/

The one reader every Workshop tool uses for the settings a person keeps for it. Settings are rows of the person's generic list `list:settings`, never files beside the code (rule 11: settings are rows in the person's lists, read through the door).

A row is a `record:setting` with id `record:setting:<workshop-folder>~<scope_kind>~<scope_id>`:

| Field | Holds |
|---|---|
| `name` | What the settings are, in a few words. |
| `tool` | The tool row that reads them, e.g. `tool:cite-principles-from-captions`. |
| `scope_kind` | `piece`, `film`, `person` or `account`. |
| `scope_id` | Which piece, film, person or account. |
| `settings` | The values, as compact JSON text with sorted keys (an object is read too). |
| `from` | Where the values came from, `"<old path>@<sha>"`. |
| `status` | `active` or `retired`; a retired row is refused. |

A tool takes `settings_record` in its request: the record as `records:read` gives it (`{id, type, value}`), its value alone, a list of records, or the path of a JSON file holding them. It reads it with `setting(given, folder, scopes, default)`: the settings of the first scope that has a row (most specific first, e.g. this piece, then this film, then the person, then the account), else the default. That is old Trillion's `setting(name)`, which gave the value or `null`.

## Files

| File | Purpose |
|---|---|
| `read-data/settings.py` | `setting_id`, `parse_id`, `make_record`, `list_record`, `chosen`, `settings_of`, `setting`; `SettingError` says how to fix a request. |
| `read-data/settings.mjs` | The same for JavaScript tools: `settingId`, `parseId`, `makeRecord`, `chosen`, `settingsOf`, `setting`. |
| `read-data/settings.mjs` `readSetting`, `readSettingRow` | `tool:read-a-tool-setting-through-my-door`: the same choice read through the person's records door at run time (records:read of each scope's row, most specific first). The run's right is `settings_prefix` (`record:setting:<folder>~`), so it reads only that tool's rows. A container tool calls `readSetting(door, { folder, scopes, fallback, tool })` directly. |
| `do-work/read_setting.py` | `tool:read-a-tool-setting`: one JSON request in (read or make), one JSON line out. |
| `tool-rows.json` | The row. |
| `test/test_settings.py`, `test/settings.test.mjs` | Ids, scope choice, the default, every refusal, the command, and the two readers agreeing. Made-up rows only. |

## Using it from a tool

A Python tool packs `tools/settings/read-data/settings.py` (`invoke.files.package_files`, or a sibling path in an on-your-computer row) and calls:

```python
import settings
values = settings.setting(request.get('settings_record'), 'my-tool-folder',
                          [('film', film_id), ('account', 'main')], default=DEFAULTS)
```

To make the rows a loader writes, use `make_record(...)` (and `list_record()` once); the records go in a `records:write` plan in the shape `tools/export-records-as-list-rows` builds.

## Reading a named row through the records door

A tool may also take `settings_record` as a row's id, `record:setting:<folder>~<scope_kind>~<scope_id>`, and read it at run time through the run's records door. Its row then grants `records:read` on its own folder's prefix only, and packs `tools/settings` (`read-data`, `do-work`) at `/opt/settings` beside `tools/records-door` at `/opt/records-door`:

```json
"records": { "fd": 3, "rights": [{ "kind": "record:setting", "prefix": "record:setting:<folder>~", "operations": ["records:read"] }] }
```

What the tool runs with is, weakest first: its own defaults, the row's settings, the request's own `settings` object (plain objects merge key by key; anything else is replaced whole). A named id the person does not keep is refused, because running on defaults would silently change the answer.

- **JavaScript:** `await settingsFor(input, { door, folder, scopes, defaults, tool })` answers `{ settings, from }`. `readSettingRecord(door, id, { folder })` reads one row (or null) and refuses another folder's row. `layOver(under, over)` is the merge.
- **Python, or any other program:** run it under `node /opt/settings/do-work/run-with-settings.mjs --folder <folder> -- <program...>`. When `settings_record` is an id, the command reads the row through the door and hands the program the request with `settings_record` replaced by the record itself and `settings_from` naming it. The program calls `settings.request_settings(request, defaults, folder=..., scopes=..., tool=...)`. Its output is passed through unchanged.

| File | Purpose |
|---|---|
| `do-work/run-with-settings.mjs` | The command above. |
| `test/run-with-settings.test.mjs`, `test/echo_settings.py` | Reading through the stand-in records door, the merge, refusals, and a made-up Python program run under the command. |

## Moved from Trillion

Old Trillion kept a setting as one record of type `setting` (Trillion-X/trillion `src/decision-store.mjs` before 4ffa1dc4a2: line 8 names the kind; lines 751-754 `setting(name)` reads `setting:<name>` and gives its value or `null`, `setSetting` writes it). Here the name is the tool's folder plus a scope, and the value is the row's `settings` field. `settingsPage` (a page of settings by prefix) is the door's `records:list` on `list:settings` and is not repeated.

## Dependencies

**Depends on:** Python 3 and Node's standard library; `tools/records-door` only for reading a named row through the door (`settingsFor` with a door, `do-work/run-with-settings.mjs`).

**Depended on by:** every Workshop tool that takes `settings_record`.
