# tools/settings/

The one reader of a tool's settings. A person's settings for a tool (thresholds, channel lists, folders, model names:
anything that is theirs and not the tool's) are never kept in a tool folder. They are one row in the person's own
`list:settings`, and a tool reads that row at run time.

This ports old trillion's `setting` record kind (`src/decision-store.mjs` before 4ffa1dc4a2, lines 8 and 751-754:
`setting(name)` answers the value, or nothing when there is none) to a row per tool and scope, read through the door.

## The row

| Field | Holds |
|---|---|
| id | `record:setting:<workshop-folder>~<scope_kind>~<scope_id>` |
| type | `record:setting` |
| `name` | what the settings are, in plain words |
| `tool` | the Workshop folder that reads them (the same as in the id) |
| `scope_kind` | `person`, `film`, `piece` or `account` |
| `scope_id` | which person, film, piece or account (lower-case letters, digits, `.`, `-`, `_`) |
| `settings` | the tool's settings: a JSON object, or JSON text holding one |
| `from` | where they came from, as `<old path>@<commit>` |
| `status` | `active`, or `retired` once another row replaces it (a retired row is refused) |

## How a tool reads it

- A tool that runs in a container with the door: `readSetting(door, id)` and `settingsOf(request, folder)` from
  `read-data/setting.mjs`.
- A tool that runs on the person's computer: the AI reads the row first (`tool:read-a-tools-settings`, or the door's
  `records:read`) and passes the record it got as `settings_record` in the tool's request (or the path of a JSON file
  holding it). The tool calls `settings_of(request, '<its folder>')` from `read-data/read_setting.py`. A request may give
  `settings` inline instead, for a sample run or a test.

Either reader refuses, saying what to fix: an id of the wrong shape, another tool's row, an absent row, a retired row,
or settings that are not a JSON object.

## Files

| File | Purpose |
|---|---|
| `tool-rows.json` | `tool:read-a-tools-settings`: reads one settings row through the door and answers it checked, with the record to hand on. |
| `part.json` | The two readers other tools import. |
| `read-data/setting.mjs` | The Node reader: `settingId`, `parseSettingId`, `settingOf`, `settingsOf`, `readSetting` and the row's `read`. |
| `read-data/read_setting.py` | The same rules in Python (standard library only): `setting_id`, `parse_setting_id`, `setting_of`, `settings_of`. |
| `test/settings.test.mjs` | The Node reader on made-up rows, through the stand-in records door, and runs the Python tests. |
| `test/test_read_setting.py` | The Python reader on made-up rows. |

## Dependencies

**Depends on:** `tools/records-door` (the door client), Node's and Python's standard libraries.

**Depended on by:** every tool whose settings are the person's own.
