# tools/put-picked-options-into-a-filmcraft-project/

Scripts a person's AI runs on the person's own computer, for the options agents build for a film in FilmCraft: build an option on its own copy of the project and export its preview, publish a checked preview into the folder the person watches, make a working preview and a review pack of it, and put a picked option into the protected project.

## The pick gate

A script a person's AI runs on the person's own computer. The person picks; agents build options. This is the one road for putting a picked option into a protected FilmCraft project: it checks the person's own stand on the option, then runs the option's FilmCraft ops headless on the project and logs what it did. It refuses every option the person has not picked themselves, and it never uses the live app's control port.

Ported from a film repository's `tools/pick-gate/pick_gate.py` (5a9ba39): the first commit here holds its lines 37-87 (reading the settings and deciding a pick) byte for byte, and the next one adapts them and brings in its lines 89-137 (`is_protected`, `check`, `rows`, `apply`), changing only where it reads its settings and its decisions (`ports/pick-gate.json`).

## Where the person's picks and settings live

Both are the person's own records, read here through their records door (`trillion op @own-records`; `TRILLION_BIN` names another command) at run time:

- **The settings** are one row of the person's `list:settings` (type `record:setting`): `record:setting:put-picked-options-into-a-filmcraft-project~film~<film folder name>`, or the id `--settings-record` names. The script reads the row and hands it to `tools/settings` `request_settings`, which lays it over the script's `DEFAULTS` (`picked_stances` `["agree"]`, `option_kind` `film-option`, `option_fold` `{ collapse_space: true }`, `filmcraft_cli` `filmcraft-cli`, `apply_log` `pick-gate-applied.jsonl`). A row must at least name `protected_projects` and `allowed_option_folders`. A retired row, or a row of another tool, is refused.
- **The pick** is the person's stance record on the option, the record `tools/where-a-person-stands` keeps (`stance:<option kind>:<identity of the option id>`). Only a stand kept `by: person` whose newest value is one of `picked_stances` counts. The record id and the option's identity are made by that folder's own code, through `do-work/stance-id-from-stdin.mjs`, so the fold and the hash have one owner. Keeping a stand is `tool:keep-where-you-stand`, which checks the person's words against their source; this script never writes one.

The script reads the records itself. A file handed to it cannot stand in for the person.

## The option previews

Ported from a film repository's FilmCraft option-preview tools (b968a719): the round-3 preview builder (lines 41-244), its option-folder and render-lock module (1-105), its publish step (3-111), its working preview (1-62), its review pack (1-41) and the chapter-4 composite preview (1-108). Each first commit here is the byte copy; the next one adapts it (`ports/*.json`). The chapter drivers that ran these for other chapter folders are now the request's `chapter` (or `options_folder`) and the settings' `preview.chapters`.

Every command reads one JSON request (a file named as the first argument, or standard input) and prints its answer as the last line, `{"result": ...}` or `{"error": what to change}`. Common fields: `film` (the film's folder), `option` (the option id; its round is part of it, x02-r4-1 is round 4), `chapter` or `options_folder` (else the settings' chapter whose `option_ids` matches the id), `spec` (else `specs-round-<n>/<id>.json` in the option folder), `settings_record` (the film's row, below: its id, read through `trillion op @own-records`, or the record, its value or a file of it), `settings` (laid over it), `plan` (true: nothing that writes runs; the answer lists the exact `filmcraft-cli`, `ffmpeg` and file steps, in order; FilmCraft's own edit commands run on a scratch copy, the export does not run, and the loudness pass 2 names pass 1's `{input_i}`... values).

| Command | Row | What it does |
|---|---|---|
| `do-work/filmcraft_preview.py` | `tool:build-a-filmcraft-option-preview` | Copies the chapter's base project to `projects-round-<n>/<id>.fcproj` and makes every edit of the spec's `edit` block with FilmCraft's own headless commands (its docstring lists them: prepend, cuts, head_extend, hold, a1_mute, gain, scale, hold_picture, overlay), exports the `preview` range under the render lock, masters the sound in two EBU R128 passes to `loudness`, and takes its still, into `work-round-<n>/pending/`. `how: "composite"` runs `composite_preview.py`. `overlay: {request, command?}` first renders `out-round-<n>/<id>/overlay.mov` and `sound.wav` with `tool:render-a-motion-graphics-overlay` (its own `do-work/render-overlay.mjs`; the build holds the lock, so the request's `lock` is dropped). |
| `do-work/composite_preview.py` | (the build's `how: "composite"`) | An overlay-only option: its project gets the overlay, and its preview is composited onto the chapter's FilmCraft export of the cut (`composite {base, base_t0}`), the overlay placed by timestamp and its sound by sample, then mastered the same way. An option with `scale` is exported by FilmCraft instead. |
| `do-work/publish_preview.py` | `tool:publish-a-checked-filmcraft-preview` | `action: "publish"`: pending -> `previews-round-<n>/` by rename, once ffprobe reads one `frame`-sized video, one audio stream and the preview's length (within `duration_tolerance_s`). `action: "watch"`: a hard link into the round's watch folder under the spec's `watch` name, only after the rendered-video check measured that file (`work-round-<n>/qa/<id>.json`, newer than it) and `content_gate.command` passes for the option. With no content gate in the settings, watch refuses (`require_content_gate`). `options: [...]` does several. |
| `do-work/working_preview.py` | `tool:make-a-working-preview-of-a-stitched-opening` | For a stitched opening: the same frame-snapped ranges cut with ffmpeg from `cut` (a render of the person's cut), the hold, the mutes, the overlay and its sound, the same master; into `work-round-<n>/working/`, never published. |
| `do-work/review_pack.py` | `tool:make-a-fresh-viewer-review-pack-of-a-preview` | Contact sheets (`tools/make-a-contact-sheet-of-pictures-or-video-frames` `frames_at_times.py`) and `transcript.txt` (`tools/audio-transcription` `whisper_here`) of the working preview (or `video`) into `work-round-<n>/review-pack/<id>/`. |
| `do-work/option_folders.py` | | Where the option's files live (chapter, layout, round), the render lock, the one road to `filmcraft-cli`, the plan recorder, the request and settings reader. |

### The settings

The film's row is the same `list:settings` row the pick gate reads, `record:setting:put-picked-options-into-a-filmcraft-project~film~<film folder name>`; the previews read its `filmcraft_cli` and its `preview` object (defaults in `option_folders.DEFAULTS`):

| key | default | meaning |
|---|---|---|
| `chapters` | `{}` | `{name: {options_folder (relative to film), option_ids (a regular expression on the id), base_project?, composite?: {base, base_t0}, ...}}`: a chapter's own keys are laid over the rest |
| `round_pattern` | none | a regular expression whose first group is the round; none: the id's second part after its first letter (`x02-r4-1` -> 4) |
| `layout` | `{}` | kind (`specs`, `out`, `projects`, `previews`, `work`, `watch`) -> folder name with `{round}`; an unnamed kind is `<kind>-round-<n>`, the watch folder `ROUND <n> - watch these` |
| `base_project` | `base-graded-copy.fcproj` | relative to the option folder |
| `lock` | none | `{file (relative to film), wait_while?: {file, says, poll_s, max_s}}`: one render at a time on the computer; a child of the holder runs without taking it again (`FILM_RENDER_LOCK_HELD`) |
| `export` | `{format: h264, scale: 0.5, quality: 70}` | filmcraft-cli export |
| `loudness` | `{I: -15, TP: -1.5, LRA: 11}` | the preview's two-pass loudnorm target |
| `still_qscale` | 3 | the still's `-q:v` |
| `frame`, `duration_tolerance_s` | `[1920, 1080]`, 0.1 | what publish's ffprobe check wants |
| `require_content_gate`, `content_gate` | true, none | `{command: [...]}` with `{film}`, `{option}`, `{python}` filled in; non-zero exit refuses watch, its JSON naming `unanswered_must`, `failed_must` or `problems` |
| `review_pack` | `{every_s: 1, per_sheet: 12, width: 640, model: mlx-community/whisper-large-v3-turbo, language: en}` | |

## Files

| File | Purpose |
|------|---------|
| `do-work/filmcraft_preview.py`, `composite_preview.py`, `publish_preview.py`, `working_preview.py`, `review_pack.py`, `option_folders.py` | The option previews (above). |
| `ports/filmcraft-preview.json`, `option-folders.json`, `publish-preview.json`, `working-preview.json`, `review-pack.json`, `composite-preview.json` | Their port contracts. |
| `test/test_prepend.py`, `test_cold_opens.py`, `test_publish.py`, `test_rounds.py` | The film repository's four tests of these tools, their assertions unchanged, on a made-up film (`test/preview_world.py`) with the stand-in `filmcraft-cli` (`test/stand_in_filmcraft_cli.py`, a small timeline model kept in the project file, with `test/made_up_project.py`), `ffmpeg` and `ffprobe` (`test/stand_in_media.py`). `FILMCRAFT_CLI` and `PREVIEW_TEST_BASE` run `test_prepend.py` against FilmCraft itself. |
| `test/test_filmcraft_preview.py` | The commands as rows run them: the plan equals the build's own commands and writes nothing; the settings; publish and watch refusals; the composite; the overlay step; the working preview; the review pack (real ffmpeg and Pillow, a stand-in Whisper, `test/stand_in_whisper/`). |
| `test/filmcraft-preview.test.mjs` | Runs them under `npm test`. |
| `do-work/pick_gate.py` | The command: `--film FOLDER [--settings-record ID] check OPTION`, `rows`, `apply OPTION --project FILE --ops FILE [--print]`. Its docstring holds the invariants. |
| `do-work/stance-id-from-stdin.mjs` | The bridge: `{ kind, fold, texts }` on stdin, `{ ids: { <text>: { id, artifact } } }` out, from `tools/where-a-person-stands` `artifactRef`, `foldWith` and `stanceRecordId` (`ports/stance-id-from-stdin.json`). |
| `tool-rows.json` | The rows `tool:put-a-picked-option-into-a-filmcraft-project`, `tool:build-a-filmcraft-option-preview`, `tool:publish-a-checked-filmcraft-preview`, `tool:make-a-working-preview-of-a-stitched-opening` and `tool:make-a-fresh-viewer-review-pack-of-a-preview`, all `on-your-computer`. |
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

**Depends on:** `tools/settings` (`read-data/settings.py`), `tools/render-a-motion-graphics-overlay` (run as a program by the build's overlay step), `tools/make-a-contact-sheet-of-pictures-or-video-frames` (run as a program by the review pack), `tools/audio-transcription` (`do-work/whisper_here.py`), ffmpeg and ffprobe, `tools/where-a-person-stands` (`artifact-ref.mjs`, `where-a-person-stands.mjs`), `tools/content-identity` (through `artifact-ref.mjs`), Python 3 with `blake3`, Node, the `trillion` command and `filmcraft-cli`.

**Depended on by:** the rows in `tool-rows.json`.
