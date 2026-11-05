# tools/settings/

The one shared reader of a person's tool settings: a library every tool packs, with one row of its own, `tool:read-a-tool-setting`, for callers that cannot import it. Every tool whose behaviour depends on the person (their thresholds, model choices, folders, layouts, voices) takes `settings_record` in its input and reads that setting at run time through its records door with this reader. Nothing about any person is in a tool; the settings are rows of the person's own list.

## Where settings live

One generic list in the person's account: `list:settings`, row type `setting`, kept as records of type `record:setting` with the id

```
record:setting:<workshop tool folder>~<scope kind>~<scope id>
```

`scope kind` is `person`, `film`, `piece` or `account`. A row's value:

| Field | Holds |
|---|---|
| `name` | A name a person reads. |
| `tool` | The Workshop tool folder the setting is for (equal to the id's). |
| `scope_kind`, `scope_id` | What the setting is for. |
| `settings` | The tool's own settings: one JSON object (or that object as JSON text). |
| `from` | Where it came from, `<old path>@<commit>`, when it was moved from a file. |
| `status` | `active` is read; anything else is refused. |

This ports the old app's `setting` record kind: old trillion `src/decision-store.mjs` before commit 4ffa1dc4a2, line 8 (a setting is one record of type `setting`), lines 751-753 (`setting(name)`: read `setting:<name>`, answer its value or null), 754-757 (`setSetting`) and 758-762 (`settings(prefix)`). One change on purpose: a missing setting is refused with what to do, never answered as null, so a tool never runs silently on built-in defaults.

## Use it

```js
import { readSettings, settingRight } from '/opt/settings/read-data/settings.mjs';
const settings = await readSettings(door, input.settings_record, { tool: 'my-tool-folder' });
```

A row packs `read-data/` here at `/opt/settings` (`invoke.files.package_files`, like `tools/records-door`) and declares the one-record right `settingRight(id)` gives: `{ kind: "record:setting", id, operations: ["records:read"] }` (or a `prefix` of `record:setting:<folder>~` when the id is chosen at run time). Python tools use `read-data/settings.py` (`read_settings(read, settings_record, tool=...)`, `settings_of(value, id, tool=...)`), which reads the same DATA and refuses with the same words.

To move a file stand-in into the account, build the row with `settingRow({ tool, scope_kind, scope_id, settings, name, from })` (or `setting_row` in Python) and put it in a `records:write` payload (`tools/export-records-as-list-rows`).

Refusals (every one says what to do): a malformed id, an unknown scope kind, a setting for another tool, a missing setting, one not active, a value naming another tool, settings that are not an object, no door.

## Files

| File | Purpose |
|---|---|
| `part.json` | The library's public files. |
| `tool-rows.json` | `tool:read-a-tool-setting`: `{ settings_record, tool? }` in, `{ settings_record, tool, scope_kind, scope_id, settings }` out, with a records right on exactly that one id. |
| `do-work/read-a-tool-setting.mjs` | That row's function, run by `tools/records-door` `do-work/run-an-export.mjs`. |
| `read-data/settings.mjs` | `readSettings`, `settingsOf`, `settingId`, `parseSettingId`, `settingRight`, `settingRow`, `SettingError`. |
| `read-data/settings.py` | The Python twin: `read_settings`, `settings_of`, `setting_id`, `parse_setting_id`, `setting_row`, `SettingError`. |
| `read-data/settings.json` | The list, row and record type, id shape, scope kinds, fields and every refusal's words. |
| `test/settings.test.mjs` | Ids, reading one record, JSON-text settings, every refusal, payload rows and rights, and the Python twin, on made-up rows and an in-memory door. |
| `test/settings_twin.py` | Runs the Python twin for that test. |
| `ports/settings.json` | The port claim. |

## Depends on

Node 22.6+ standard library; Python 3.10+ standard library. No packages.
