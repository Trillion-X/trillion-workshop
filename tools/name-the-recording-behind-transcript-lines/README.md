# tools/name-the-recording-behind-transcript-lines/

Name the recording behind a stretch of lines in a transcript archive. A person who cites a passage of a long transcript archive by its line numbers ("lines 120 to 180") gets back every archive window that overlaps those lines: the window's id, the recording's title, the window's own line span and its first words, so the passage can be found in their own media. It reads one JSON file in a folder the person let it read, and changes nothing.

Moved from a film's tools folder (`package_lines.py`). The overlap rule and the printed line are the old tool's; the archive path and the ranges are now the request, and the archive one film's citations point into is a setting.

## Files

| File | Purpose |
|------|---------|
| `do-work/name_recording.py` | The command. One JSON request on standard input (`archive`, `ranges`, `settings`), or `--archive FILE` and one or more `<first>-<last>` ranges; `--base FOLDER` is where a relative archive path is read. Prints one tab-separated line per overlap, then `{"result": {...}}` as its last line, or `{"error": ...}`. |
| `tool-rows.json` | `tool:name-the-recording-behind-transcript-lines`, a `computer` row with `read-a-folder`, run under `tools/settings`' `run-with-settings.mjs` so a `settings_record` is read through the run's records door. |
| `part.json` | Nothing here is imported by other code. |
| `test/test_name_recording.py` | The overlap rule at the edges, the printed line, refusals, the request on standard input, a relative archive in the granted folder, and settings (archive and preview length). |
| `test/name-the-recording-behind-transcript-lines.test.mjs` | Runs those tests and checks the row. |

## The request

| Key | What it holds |
|---|---|
| `archive` | The archive index: a JSON list of `{id, recording, start_line, end_line, text}`, one item per window. A path inside the granted folder. |
| `ranges` | Line ranges `first-last`: a list, or one string with spaces between them. |
| `settings_record` | The person's `list:settings` row for this folder, `record:setting:name-the-recording-behind-transcript-lines~<scope_kind>~<scope_id>`. |
| `settings` | Settings for this run, laid over the row's. |

Settings (defaults in `do-work/name_recording.py`): `archive` (used when the request names none; `null`) and `preview_chars` (how many first characters of a window to show; 120).

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `parse_range` | `"12-40"` to `(12, 40)` | Refuses a range that is not `<first>-<last>` or that ends before it starts. |
| `windows_for` | `(windows, spec) => [window]` | A window overlaps when it starts at or before the range's last line and ends at or after its first. |
| `printed` | `(spec, window, preview) => line` | `<range>	<id>	<recording>	<first>-<last>	<first characters, as Python writes them>`. |
| `answer` | `(request, base) => (code, lines, last)` | The whole run: settings, refusals, the printed lines and the last JSON line. |

## Dependencies

**Depends on:** Python 3.10 or later and its standard library; `tools/settings` (`read-data/settings.py`, `do-work/run-with-settings.mjs`) and `tools/records-door`, which its row packs.

**Depended on by:** `tool-rows.json`.

## Invariants

- Read only: the archive index is never changed and nothing outside it is read.
- Every range is checked before anything is printed; a bad one is refused with what to write.
- A range that no window overlaps prints one line saying so and is listed in `not_found` (the old tool printed nothing, which could not be told from a failed run).
- Nothing in the code names a person, a recording or a place on a disk; a film's archive is its settings row.
