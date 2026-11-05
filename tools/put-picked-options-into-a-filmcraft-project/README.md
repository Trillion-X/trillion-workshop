# tools/put-picked-options-into-a-filmcraft-project/

A script a person's AI runs on the person's own computer. The person picks; agents build options. This is the one road for putting a picked option into a protected FilmCraft project: it checks the person's own stand on the option, then runs the option's FilmCraft ops headless on the project and logs what it did. It refuses every option the person has not picked themselves, and it never uses the live app's control port.

Ported from a film repository's `tools/pick-gate/pick_gate.py` (5a9ba39): the first commit here holds its lines 37-87 (reading the settings and deciding a pick) byte for byte, and the next one adapts them and brings in its lines 89-137 (`is_protected`, `check`, `rows`, `apply`), changing only where it reads its settings and its decisions (`ports/pick-gate.json`).

## Where the person's picks and settings live

Both are the person's own records, read here through their records door (`trillion op @own-records`; `TRILLION_BIN` names another command) at run time:

- **The settings** are one row of the person's `list:settings` (type `record:setting`): `record:setting:put-picked-options-into-a-filmcraft-project~film~<film folder name>`, or the id `--settings-record` names. The script reads the row and hands it to `tools/settings` `request_settings`, which lays it over the script's `DEFAULTS` (`picked_stances` `["agree"]`, `option_kind` `film-option`, `option_fold` `{ collapse_space: true }`, `filmcraft_cli` `filmcraft-cli`, `apply_log` `pick-gate-applied.jsonl`). A row must at least name `protected_projects` and `allowed_option_folders`. A retired row, or a row of another tool, is refused.
- **The pick** is the person's stance record on the option, the record `tools/where-a-person-stands` keeps (`stance:<option kind>:<identity of the option id>`). Only a stand kept `by: person` whose newest value is one of `picked_stances` counts. The record id and the option's identity are made by that folder's own code, through `do-work/stance-id-from-stdin.mjs`, so the fold and the hash have one owner. Keeping a stand is `tool:keep-where-you-stand`, which checks the person's words against their source; this script never writes one.

The script reads the records itself. A file handed to it cannot stand in for the person.

## Files

| File | Purpose |
|------|---------|
| `do-work/pick_gate.py` | The command: `--film FOLDER [--settings-record ID] check OPTION`, `rows`, `apply OPTION --project FILE --ops FILE [--print]`. Its docstring holds the invariants. |
| `do-work/stance-id-from-stdin.mjs` | The bridge: `{ kind, fold, texts }` on stdin, `{ ids: { <text>: { id, artifact } } }` out, from `tools/where-a-person-stands` `artifactRef`, `foldWith` and `stanceRecordId` (`ports/stance-id-from-stdin.json`). |
| `tool-rows.json` | The row `tool:put-a-picked-option-into-a-filmcraft-project`, `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `test/pick-gate.test.mjs` | The script against a throwaway film, a stand-in `trillion` (`test/stand-in-trillion.mjs`) and a stand-in `filmcraft-cli`, and the bridge against `tools/where-a-person-stands`. Made-up films and words. |

## Key Types / Functions

| Name | Shape | Role |
|---|---|---|
| `load_config` | `(film, record_id?) -> settings` | The film's settings row through the door and `request_settings`, or a refusal saying what to write. |
| `option_decisions` | `(film, settings) -> {option_id: decision}` | Every stand on an option of the film's option kind: the one reader. |
| `latest_verdict` / `require_pick` | `(film, settings, option_id) -> decision` | One option's stand, or a refusal saying what stand there is. |
| decision | `{ decision_id: <stance record id>, option_id, verdict: <stand>, reason_verbatim: <the person's words>, source, at }` | |
| apply log entry | `{ at, option_id, verdict_decision_id, verdict, project, protected, ops_file, ops_hash, exit, stdout_tail, stderr_tail }` | One line per apply in the file `apply_log` names, relative to the film. `ops_hash` is `blake3:` and the hex of the ops file. |

## Not carried from the private script

- The film's verdict file (`verdict_file`, `picked_verdicts`): the decisions are the person's stance records now. A loader turns a film's verdict rows into stance versions with `tool:plan-a-stance-reload`: picked and picked-with-changes become `agree`; rejected, rejected-as-built and not-picked become `disagree`; liked-part and not-picked-liked become `partly`; any other word (not watched, pending) becomes a stand taken back (`null`), so the newest row still wins. The word picked-with-changes itself is not kept; the person's words in `why` are.
- `record-pick` (append a picked or rejected row after checking the quote in a message file): `tool:keep-where-you-stand` keeps the stand and checks the words in their source (`source_text`, `do-work/where-a-person-stands.mjs` invariant 6).
- Rebuilding the copy gate's pick-implied labels after each pick: the copy gate reads `rows` of this script.
- The `lines` a row named: a stand is on one thing; a line the person's words single out is a stand of its own kind on that line.
- `protected_control_ports`, `candidate_files`, `read_only_command_patterns`, `checklist_gate` and `display_only_fields` are the film guard's own configuration (the hook that refuses a write to a protected project), not this tool's.

## Dependencies

**Depends on:** `tools/settings` (`read-data/settings.py`), `tools/where-a-person-stands` (`artifact-ref.mjs`, `where-a-person-stands.mjs`), `tools/content-identity` (through `artifact-ref.mjs`), Python 3 with `blake3`, Node, the `trillion` command and `filmcraft-cli`.

**Depended on by:** the row in `tool-rows.json`.
