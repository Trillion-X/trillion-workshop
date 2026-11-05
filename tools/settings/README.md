# tools/settings/

The one reader of a person's tool settings. A tool's tuned values (thresholds, word lists, model and voice choices) are
not files in the tool and not values in its code: they are rows of the person's generic list `list:settings`, read at
run time. This ports old trillion's `setting` record kind (Trillion-X/trillion `src/decision-store.mjs` lines 8 and
751-762, before commit 4ffa1dc4a2) to list rows read through the person's records door.

## A settings row

| Field | Holds |
|---|---|
| id | `record:setting:<workshop-folder>~<scope_kind>~<scope_id>`, e.g. `record:setting:grade-and-repair-speech-audio~person~me` |
| type | `record:setting` (the rows of `list:settings`) |
| value.name | a name a person reads |
| value.tool | the tool row that reads it, e.g. `tool:grade-and-repair-speech-audio` |
| value.scope_kind, value.scope_id | `person`, `film`, `piece` or `account`, and which one; they must agree with the id |
| value.settings | the settings the tool reads, one JSON object kept as JSON text in the list's long-text field (an object is taken too); its keys are the tool's own |
| value.from | where the values came from, `<old path>@<commit>` |
| value.status | `active`, or `retired` (a retired row is refused, naming the row to give instead) |

A tool takes `settings_record` in its request: the row id for a container row, which declares the right
`{ "kind": "record:setting", "id": { "fill": { "from": "input", "field": "settings_record" } }, "operations": ["records:read"] }`
and packs `{ "package": "settings", "paths": ["read-data"], "at": "/opt/settings" }`; or, for a script the person's AI
runs on their computer, a file holding the row as `records:read` answered it (`{ id, type, value }`).

## Files

| File | Purpose |
|---|---|
| `read-data/settings-record.mjs` | `recordId`, `parseRecordId`, `settingsOf(record, folder)`, `readSettings(door, id, folder)`, `readSettingsRow` (the row), `settingStore` (old trillion's `setting` / `setSetting` / `settings`, kept as they were) over `snapshotEeaf(records)`, and the command `node settings-record.mjs settings-of --record FILE [--folder FOLDER]` that prints the settings object (Python tools run this, so there is one reader). |
| `tool-rows.json` | `tool:read-a-tools-settings`: reads one settings row through the door and gives its settings. |
| `part.json` | `read-data/settings-record.mjs` is public: tools pack it. |
| `ports/setting-record.json` | The port contract from old trillion's decision store. |
| `test/settings-record.test.mjs` | The id, the old store over a snapshot, every refusal, a read through a stand-in door, and the command. |

## From Python

```python
import json, subprocess
settings = json.loads(subprocess.run(['node', 'tools/settings/read-data/settings-record.mjs', 'settings-of',
                                      '--record', record_file, '--folder', 'my-tool-folder'],
                                     check=True, capture_output=True, text=True).stdout)
```

A refusal exits 2 with what to fix on standard error.

## Dependencies

Node's standard library only. The row packs `tools/records-door` (`run-an-export.mjs` and the door client).
