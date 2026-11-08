# tools/assemble-a-plan-into-a-cut/

Cuts a plan into a video on the person's own computer: stretches of recordings in the plan's order, lines a voice reads over a held frame, the person's look on every shot, the person's graphics laid over the whole cut, one soundtrack. The cut is shown to the person only after every check they name passes. A plan of slides becomes one picture per slide and a PDF.

The tool lays the cut out; it renders nothing itself. The cut is one edit of the Workshop tool `tools/media-composition` (its EDL: a clip per segment, every sound a placement on the timeline, the overlay a layer, the shot match a LUT per shot), written to `work/<slug>/edit.json` and rendered by media-composition's `render-an-edit.mjs`. A reel is one such edit too.

The tool holds only the mechanism. What a format is made of, every look, every graphic and how it is drawn, which checks a cut must pass and where things go all come in the person's request, read from their own records or files at run time. Nothing in this folder names a film, a format, a person or a brand.

Before a clip can use the sound-only still fallback, ffprobe must read it successfully; a failed probe refuses the cut even if ffprobe printed partial stream data.

## The request

One JSON file (`--request <file>`, paths in it relative to that file) or JSON on standard input (paths relative to its `relative_to`).

| Key | What it holds |
|---|---|
| `pieces` | The piece table: `default` and `formats` ({format option: {segment kind: piece row}}) and `aspects_by_medium`. A piece is `clip`, `voiced_line`, `skip` or `slide`. A format with no row is not renderable; a kind with no piece is refused by name. |
| `plan_file` or `plans` | One plan file, or `{folder, skip, only}`: every `<slug>.json` there with segments. A plan's own folder (`<folder>/<slug>/`) holds its grades file. |
| `clips` | `{words_folder, wordtimes_folder?}`: `<clip>.words.json` per recording, `{source, words: [{text, start, end}]}`; a word timer's `<clip>.json` (`{segments: [{words: [{word, start, end}]}]}`) in `wordtimes_folder` is read before it for the clip's word times. A plan's `sources` names a clip's file directly. |
| `looks` | `{chains: {name: [{filter, options}]}, by_clip: {clip: name}, default}`: ffmpeg filter steps per look (a LUT, an eq, anything), each clip's `grade` in the edit. No look: the picture is only fitted to the frame. |
| `grades` | `{file, as_is, recreated_key, audio_name?}`: per span key (`<clip>_<from>_<to>`) a row; the source's own sound only when its `treatment` is `as_is`, else its `audio` file from `audio_from` (tool:grade-and-repair-speech-audio writes these). A span with no row or a missing file stops the cut. `audio_name` is a template (filled with `span`, the key) of the name the grader gives a graded file, such as `{"join": ["audio/", {"fill": "span"}, ".wav"]}`: a row naming another file stops the cut too. No `grades`: the source's own sound. |
| `voice` | `{folder, word_timer: {argv}, say: [{argv}]}`: takes are `<name>.wav` beside `<name>.txt` (their exact words); `<name>.words.json` beside a take is made by the word timer when missing; `say` makes missing takes (the voice-lines step). |
| `face_reader` | `{argv}`: a command given picture files, printing one line each (see The face reader). Needed when the plan cuts recordings. |
| `overlay_renderer` | How graphics are drawn (see The overlay renderer). |
| `devices` | What graphics look like, as templates (see Devices). |
| `style` | Which of `devices.voiced_line.styles` draws the voiced lines (default `default_style`). |
| `checks` | Rows run on the made cut before it may move: `{id, argv, stdin_json?, result_exit_path?, cwd?, pass_exit_codes?: [0], advisory_exit_codes?, fail_line_contains?}`. Filled with `cut`, `spec`, `overlay`, `timeline` (the renderer's), `cut_timeline`, `plan_file`, `plan` (the actual plan object), `plan_text` (that object as JSON text), `work`, `report` (`<work>/<id>.json`). |
| `plan_checks` | The same rows, run on each plan before its cut (`run` step), filled with `plan_file`, `work`, `report`. An advisory exit lets the cut go on with its output shown, unless `advisory_stops` is true (the final cut, where an advisory result stops the plan too). tool:check-a-rendered-video's plan check (`check_plan_cuts.py`) is one such row. |
| `folders` | `work` (each cut is made in `work/<slug>`), `seen` (where the person looks), `specs` (the cut's spec as `<slug>.json`, optional), `holds_log` (optional). |
| `refs` | `cut_relative_to`, `plan_relative_to`: how the spec names the cut and the plan. |
| `rules` | Numbers laid over `read-data/cut-rules.json` (frame rate, loudness, edge handles, hold search, placement). |
| `cut_name`, `cut_file` | A work folder name and file name other than the slug (a variant of one plan). |
| `compare_with` | (`timeline` step) a timeline.json made before: every field that differs is listed. |
| `extends` | A request this one is laid over, key by key. |

Paths: `{"here": "a/b"}` (from the request's folder), `{"repository": "a/b"}` (from the root of the git repository holding the request), `{"workshop": "tools/..."}` (from this Workshop checkout). Values another tool owns: `{"read_json": <path>, "at": [key, ...]}`, read from the owner at run time instead of copied.

## Templates

Every event, spec and argv is a template the tool fills: `{"fill": name}` (a value the tool measured), `{"by_side": {"left", "right"}}`, `"on_side": {"left": {...}, "right": {...}}` (keys only one side has), `{"join": [...]}`, `{"each": name}` (a list spliced into a list), `"key": {"if": name, "then": v}`. A `why` key at any depth is a note for people and never reaches the renderer.

A command row may also give `stdin_json`: any JSON value using those same templates. It is filled with that invocation's values and serialized once onto the command's standard input. JSON input preserves semantic keys such as a recorded stand's `why`, including nested literal objects and selected branches; existing event/argv template note handling stays unchanged. A row without it keeps its argv-only behavior. Plan checks receive the actual plan for each file they check, so a request covering several plans does not have to freeze one plan into its input.

Check rows normally use the process exit code. A JSON command that reports its verdict in its last nonempty stdout line may instead declare `result_exit_path`, a nonempty list of object keys or array indices, for example `["result", "exit"]`. The check must exit its process with 0 and return a JSON object with no top-level `error`; the declared value must be an integer. That integer is then tested against the row's `pass_exit_codes` and `advisory_exit_codes`. A nonzero process exit, refused or malformed response, missing path, or noninteger value never passes and never becomes advisory. The result records `process_exit` and `response_error` for these rows. Rows without a result path keep their existing process-exit policy. No verdict code is built into the tool.

## The overlay renderer

Any command that draws a spec. Its row: `argv` (filled with `folder`, `id`), `stills_argv` (added for stills, with `{"each": "stills"}`), `env`, `spec_file` and `out_folder` (templates: where the tool writes the spec, where the renderer writes), `outputs` (`overlay` with alpha, `sound`, `timeline` file names), `id_mark` (a word in every id), `time_fields` (`keys`, `suffix`, `lists`: which event keys are times, so events move to the cut's seconds), `id_fields` (`id`, `refs`: ids prefixed per segment), `exit_s` (time a plan graphic's exit takes), `specs` (templates `segment`, `cut`, `measure`, `slide`) and `cut_spec_merge` (per spec-level key: `same`, `last` or `join`). With stills, every PNG it writes in its out folder is read (alpha for the columns a graphic covers; the picture for a slide).

A renderer row may give `stdin_json` for a JSON-input renderer such as `tools/render-a-motion-graphics-overlay`. Its templates can use `spec` (the actual spec object), `spec_file` (the written spec path), `out` (the folder from `out_folder`), and `stills_seconds` (numeric seconds), as well as `folder` and `id`. For example, the input template can contain `"spec": {"fill": "spec"}`, `"out": {"fill": "out"}`, and `"stills": {"if": "stills_seconds", "then": {"fill": "stills_seconds"}}`; the renderer's settings and assets remain the caller's DATA. The existing `stills` template value and `stills_argv` retain their original string values.

## The face reader

Given picture files after its argv, it prints one line per file in order: `<name> eyes <open> ... mouth <open> box <x> <y> <w> <h>` (openness as height/width ratios, the box in pixels from the top left), or a line without `eyes` when there is no face. Held frames take open eyes and a closed mouth; graphics keep clear of the box. Apple Vision's face landmarks give these numbers on a Mac.

## Devices

`tag` (a one-line disclosure tag: `measure {font, size, pad_em}`, `y`, `height_em`, `inset`, `event`), `label`, `recreated` (the tag of a span whose voice was recreated), `recorded` (graphics over a recording: `heights`, `spec`), `voiced_line` (`styles`, each a text `block` (`font`, `sizes`, `wrap_width` or `wrap_chars`, `inset`, `typing`), an optional `backing`, `events` with `{"use": "tag"}` and `{"use": "backing"}`), `caption` (a sound-only recording's words: `chunk` costs, `event`), `backing` (contrast-checked dark backing), `plan_graphics` (a plan segment's own `graphics`: which key says their times are source seconds, which keys are notes, which mirror), `stand_in` (`push`), `slide` (`event`, `rotations`), `safe_margin_px`. A font is a file path or `pillow-default`.

## Files

| File | Purpose |
|---|---|
| `do-work/assemble.py` | The command: steps timeline, lay-out, build, check-plans, run, voice-lines, regroup, retitle, outline, titles-table, string-together. Last line `{"result"}` or `{"error"}`. |
| `do-work/cut.py` | One plan into one cut: timing, the edit (pictures, held frames, sound placements, overlay layer), checks, the move; slides. |
| `do-work/graphics.py` | Lays graphics out from the device templates and runs the overlay renderer. |
| `do-work/faces.py` | Held frames and face-clear placement from the face reader. |
| `do-work/media.py` | ffprobe readings, frames read for analysis, and the hand-off to media-composition (`render-an-edit.mjs`, `match-shots.mjs`). |
| `do-work/plans.py` | regroup, retitle, outline, titles-table. |
| `do-work/voice.py` | The voice-lines step. |
| `do-work/say_line_kokoro.py` | A speaker for `voice.say`: Kokoro through mlx-audio, trimmed, soft end, room tone. |
| `do-work/reel.py` | Cuts in order with a text card between each two, as one edit. |
| `read-data/fill.py` | Request paths, read_json and the template filler. |
| `read-data/plan_pieces.py` | The piece table and aspects. |
| `read-data/spans.py` | A recorded span's key, the media file a clip names and its words: the one lookup the cutter and tool:check-a-rendered-video's plan check share (that row packs this file), so the check cuts what the render cuts. |
| `read-data/timing.py` | Edge room, word times, caption chunks, event times. |
| `read-data/cut-rules.json` | The default numbers (editing and online-video norms). |
| `test/` | `run_tests.py` over `test_assemble.py` and the isolated ffprobe behavior tests in `test_media_probe.py`, on recordings drawn by ffmpeg with stand-in renderer, face reader, checker and speaker (`fixtures/`). |

## How to run it

```
python3 -m pip install -U numpy soundfile pillow blake3
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py timeline --request request.json my-plan
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py check-plans --request request.json my-plan
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py build --request request.json my-plan
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py run --request request.json
```

`check-plans` runs only the request's existing plan-check rows, using the same pass/advisory policy as `run`. It generates no voice and starts no build or renderer. Its result lists each plan's `allowed` value and `plan_checks`, with `all_allowed` for the selected set. It exits 1 when any plan is stopped; an advisory accepted at review remains explicitly advisory in its check result. Set `advisory_stops` to require a pass, as for `run`.

## Dependencies

**Depends on:** `tools/media-composition` beside it in this Workshop (the renderer, on node 22 or later); Python 3.10+, numpy, soundfile, Pillow, blake3, ffmpeg and ffprobe; the person's overlay renderer, face reader and check commands; mlx-audio for the bundled Kokoro speaker.

**Depended on by:** films whose request names it; checks such as tool:check-a-rendered-video read the spec, overlay and timeline it writes, and its plan check imports `read-data/spans.py`.

## Tests

`npm test` from the Workshop root, or `python3 tools/assemble-a-plan-into-a-cut/test/run_tests.py`.

## Source lineage

This extends the existing assembler mechanisms, introduced in Workshop commit `acee5b7f6184f49583098cfbb53ba652d5696a71` and extended from the film's cutter in `2738203d`. The JSON command transport reuses `read-data/fill.py` and the existing renderer/check callers; it does not replace the cutter, renderer, rules checker or face reader. The unrelated held `computer/cut-tools.mjs` receipt in `from-old-trillion/` remains its own lineage and is not claimed as the source of these Python callers.
