# tools/settings/

The one reader every Workshop tool uses for the settings a person keeps for it. Settings are rows of the person's settings table (the owner-places role `settings`, see read-data/settings-store.mjs), never files beside the code (rule 11: settings are rows in the person's lists). No store is reached here: the person's AI reads the rows from the store the person keeps them in and hands them in, and keeps what a make answers.

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

A tool takes `settings_record` in its request: the record as the person's store gives it (`{id, type, value}`), its value alone, a list of records, or the path of a JSON file holding them. It reads it with `setting(given, folder, scopes, default)`: the settings of the first scope that has a row (most specific first, e.g. this piece, then this film, then the person, then the account), else the default. That is old Trillion's `setting(name)`, which gave the value or `null`.

## Files

| File | Purpose |
|---|---|
| `read-data/settings.py` | `setting_id`, `parse_id`, `make_record`, `list_record`, `chosen`, `settings_of`, `setting`, `handed_record`, `given_rows`, `request_settings`, `lay_over`, `keep`; `SettingError` says how to fix a request. |
| `read-data/settings-store.mjs` | The settings table: `settingsRoleOf` reads the owner-places role `settings`; `readRequest`, `createRequest` and `writeRequests` make the statements (one request each, with `statement_timeout_ms`, run by tool:run-sql-in-my-database); `recordsOf` and `writeOutcome` read the answers; `carryRequests` makes the one-time carry of rows made before the table existed. Compare-and-set: a keep with no expected row inserts only when the id is free; a keep over an expected row updates only where the version read is still current. A row that is taken or has moved is refused in words naming its id. |
| `read-data/settings-table.json` | The table's statements (create, select, insert, update) with `{table}` where the role's `schema.table` goes, and the timeout. |
| `read-data/settings.mjs` | The same for JavaScript tools: `settingId`, `parseId`, `makeRecord`, `chosen`, `settingsOf`, `setting`, `handedRecord`, `settingsFor`, `layOver`, `isSettingId`. |
| `do-work/read_setting.py` | `tool:read-a-tool-setting`: one JSON request in (read or make), one JSON line out. A make answers `keep`: each row with `expected`, the row as handed in `stored.records` (`{type, value}`) or `null` when it was not there, so the store refuses a write made from a stale read. |
| `what-this-tool-does-and-how-to-run-it.json` | The row. |
| `test/test_settings.py`, `test/settings.test.mjs` | Ids, scope choice, the default, every refusal, the command, `keep` with `expected`, and the two readers agreeing. Made-up rows only. |
| `test/settings-store.test.mjs` | The settings table's role, the read and create statements, compare-and-set writes against a stand-in run that keeps rows in memory (a stale write refused by id), the carry, and `statement_timeout_ms` on every statement. |
| `test/handed-rows.test.mjs` | A named row read from the rows handed in, the merge, and the refusals when it was not handed, in JavaScript and Python. |
| `test/rows-name-no-records-method.test.mjs` | No row names a records method. |

## Using it from a tool

A Python tool packs `tools/settings/read-data/settings.py` (`invoke.files.package_files`, or a sibling path in an on-your-computer row) and calls:

```python
import settings
values = settings.setting(request.get('settings_record'), 'my-tool-folder',
                          [('film', film_id), ('account', 'main')], default=DEFAULTS)
```

To make the rows a loader writes, use `make_record(...)` (and `list_record()` once), and `keep(records, stored)` to give each the `expected` row it was made over.

## A named row handed in

A tool may also take `settings_record` as a row's id, `record:setting:<folder>~<scope_kind>~<scope_id>`. The caller reads that row from the person's store and hands it in `stored.records` (`[{id, type, value}]`); with `settings_record` left out, the setting rows in `stored.records` are read with the scopes given. A row of another tool's folder is refused.

What the tool runs with is, weakest first: its own defaults, the row's settings, the request's own `settings` object (plain objects merge key by key; anything else is replaced whole). A named id that was not handed in is refused, because running on defaults would silently change the answer.

- **JavaScript:** `settingsFor(input, { folder, scopes, defaults, tool })` answers `{ settings, from }`. `handedRecord(stored, id, { folder })` finds one row (or null). `layOver(under, over)` is the merge.
- **Python:** `settings.request_settings(request, defaults, folder=..., scopes=..., tool=...)` gives the same settings from the same request.

| File | Purpose |
|---|---|
| `show/settings-mount.tsx` | The module entry of `tool:screen-settings`: its `mount` is `mountSettingsScreen`. |
| `web/src/workspace/settings-screen.tsx`, `web/src/workspace/settings-pages.tsx`, `web/src/workspace/settings-pages.json`, `web/src/workspace/settings-posts.mjs`, `web/src/workspace/settings-panels.json` | The Settings screen: the rail's groups and pages (`settings-panels.json`), the pages it draws itself (`settings-pages.tsx` with their words in `settings-pages.json` and the What's new posts in `settings-posts.mjs`) and the shell that steps between them. Moved byte for byte from the web client (`moved-from.json`); the files of the web shell they import stay there. |

## Moved from Trillion

Old Trillion kept a setting as one record of type `setting` (Trillion-X/trillion `src/decision-store.mjs` before 4ffa1dc4a2: line 8 names the kind; lines 751-754 `setting(name)` reads `setting:<name>` and gives its value or `null`, `setSetting` writes it). Here the name is the tool's folder plus a scope, and the value is the row's `settings` field. `settingsPage` (a page of settings by prefix) is a read of `the settings table` in the person's own store and is not repeated.

## Dependencies

**Depends on:** Python 3 and Node's standard library.

**Depended on by:** every Workshop tool that takes `settings_record`.
