# tools/assemble-a-plan-into-a-cut/

Cuts a plan into a video on the person's own computer: stretches of recordings in the plan's order, lines a voice reads over a held frame, the person's look on every shot, the person's graphics laid over the whole cut, one soundtrack. The cut is shown to the person only after every check they name passes. A plan of slides becomes one picture per slide and a PDF.

The tool lays the cut out; it renders nothing itself. The cut is one edit of the Workshop tool `tools/media-composition` (its EDL: a clip per segment, every sound a placement on the timeline, the overlay a layer, the shot match a LUT per shot), written to `work/<slug>/edit.json` and rendered by media-composition's `render-an-edit.mjs`. A reel is one such edit too.

The tool holds only the mechanism. What a format is made of, every look, every graphic and how it is drawn, which checks a cut must pass and where things go all come in the person's request, read from their own records or files at run time. Nothing in this folder names a film, a format, a person or a brand.

## The request

One JSON file (`--request <file>`, paths in it relative to that file) or JSON on standard input (paths relative to its `relative_to`).

| Key | What it holds |
|---|---|
| `pieces` | The piece table: `default` and `formats` ({format option: {segment kind: piece row}}) and `aspects_by_medium`. A piece is `clip`, `voiced_line`, `skip` or `slide`. A format with no row is not renderable; a kind with no piece is refused by name. |
| `plan_file` or `plans` | One plan file, or `{folder, skip, only}`: every `<slug>.json` there with segments. A plan's own folder (`<folder>/<slug>/`) holds its grades file. |
| `clips` | `{words_folder}`: `<clip>.words.json` per recording, `{source, words: [{text, start, end}]}`. A plan's `sources` names a clip's file directly. |
| `looks` | `{chains: {name: [{filter, options}]}, by_clip: {clip: name}, default}`: ffmpeg filter steps per look (a LUT, an eq, anything), each clip's `grade` in the edit. No look: the picture is only fitted to the frame. |
| `grades` | `{file, as_is, recreated_key}`: per span key (`<clip>_<from>_<to>`) a row; the source's own sound only when its `treatment` is `as_is`, else its `audio` file from `audio_from` (tool:grade-and-repair-speech-audio writes these). A span with no row or a missing file stops the cut. No `grades`: the source's own sound. |
| `voice` | `{folder, word_timer: {argv}, say: [{argv}]}`: takes are `<name>.wav` beside `<name>.txt` (their exact words); `<name>.words.json` beside a take is made by the word timer when missing; `say` makes missing takes (the voice-lines step). |
| `face_reader` | `{argv}`: a command given picture files, printing one line each (see The face reader). Needed when the plan cuts recordings. |
| `overlay_renderer` | How graphics are drawn (see The overlay renderer). |
| `devices` | What graphics look like, as templates (see Devices). |
| `style` | Which of `devices.voiced_line.styles` draws the voiced lines (default `default_style`). |
| `checks` | Rows run on the made cut before it may move: `{id, argv, cwd?, pass_exit_codes?: [0], advisory_exit_codes?, fail_line_contains?}`. Filled with `cut`, `spec`, `overlay`, `timeline` (the renderer's), `cut_timeline`, `plan_file`, `work`, `report` (`<work>/<id>.json`). |
| `plan_checks` | The same rows, run on each plan before its cut (`run` step), filled with `plan_file`, `work`, `report`. An advisory exit lets the cut go on with its output shown. |
| `folders` | `work` (each cut is made in `work/<slug>`), `seen` (where the person looks), `specs` (the cut's spec as `<slug>.json`, optional), `holds_log` (optional). |
| `refs` | `cut_relative_to`, `plan_relative_to`: how the spec names the cut and the plan. |
| `rules` | Numbers laid over `read-data/cut-rules.json` (frame rate, loudness, edge handles, hold search, placement). |
| `cut_name`, `cut_file` | A work folder name and file name other than the slug (a variant of one plan). |
| `compare_with` | (`timeline` step) a timeline.json made before: every field that differs is listed. |
| `extends` | A request this one is laid over, key by key. |

Paths: `{"here": "a/b"}` (from the request's folder), `{"repository": "a/b"}` (from the root of the git repository holding the request), `{"workshop": "tools/..."}` (from this Workshop checkout). Values another tool owns: `{"read_json": <path>, "at": [key, ...]}`, read from the owner at run time instead of copied.

## Templates

Every event, spec and argv is a template the tool fills: `{"fill": name}` (a value the tool measured), `{"by_side": {"left", "right"}}`, `"on_side": {"left": {...}, "right": {...}}` (keys only one side has), `{"join": [...]}`, `{"each": name}` (a list spliced into a list), `"key": {"if": name, "then": v}`. A `why` key at any depth is a note for people and never reaches the renderer.

## The overlay renderer

Any command that draws a spec. Its row: `argv` (filled with `folder`, `id`), `stills_argv` (added for stills, with `{"each": "stills"}`), `env`, `spec_file` and `out_folder` (templates: where the tool writes the spec, where the renderer writes), `outputs` (`overlay` with alpha, `sound`, `timeline` file names), `id_mark` (a word in every id), `time_fields` (`keys`, `suffix`, `lists`: which event keys are times, so events move to the cut's seconds), `id_fields` (`id`, `refs`: ids prefixed per segment), `exit_s` (time a plan graphic's exit takes), `specs` (templates `segment`, `cut`, `measure`, `slide`) and `cut_spec_merge` (per spec-level key: `same`, `last` or `join`). With stills, every PNG it writes in its out folder is read (alpha for the columns a graphic covers; the picture for a slide).

## The face reader

Given picture files after its argv, it prints one line per file in order: `<name> eyes <open> ... mouth <open> box <x> <y> <w> <h>` (openness as height/width ratios, the box in pixels from the top left), or a line without `eyes` when there is no face. Held frames take open eyes and a closed mouth; graphics keep clear of the box. Apple Vision's face landmarks give these numbers on a Mac.

## Devices

`tag` (a one-line disclosure tag: `measure {font, size, pad_em}`, `y`, `height_em`, `inset`, `event`), `label`, `recreated` (the tag of a span whose voice was recreated), `recorded` (graphics over a recording: `heights`, `spec`), `voiced_line` (`styles`, each a text `block` (`font`, `sizes`, `wrap_width` or `wrap_chars`, `inset`, `typing`), an optional `backing`, `events` with `{"use": "tag"}` and `{"use": "backing"}`), `caption` (a sound-only recording's words: `chunk` costs, `event`), `backing` (contrast-checked dark backing), `plan_graphics` (a plan segment's own `graphics`: which key says their times are source seconds, which keys are notes, which mirror), `stand_in` (`push`), `slide` (`event`, `rotations`), `safe_margin_px`. A font is a file path or `pillow-default`.

## Files

| File | Purpose |
|---|---|
| `do-work/assemble.py` | The command: steps timeline, lay-out, build, run, voice-lines, regroup, retitle, outline, string-together. Last line `{"result"}` or `{"error"}`. |
| `do-work/cut.py` | One plan into one cut: timing, the edit (pictures, held frames, sound placements, overlay layer), checks, the move; slides. |
| `do-work/graphics.py` | Lays graphics out from the device templates and runs the overlay renderer. |
| `do-work/faces.py` | Held frames and face-clear placement from the face reader. |
| `do-work/media.py` | ffprobe readings, frames read for analysis, and the hand-off to media-composition (`render-an-edit.mjs`, `match-shots.mjs`). |
| `do-work/plans.py` | regroup, retitle, outline. |
| `do-work/voice.py` | The voice-lines step. |
| `do-work/say_line_kokoro.py` | A speaker for `voice.say`: Kokoro through mlx-audio, trimmed, soft end, room tone. |
| `do-work/reel.py` | Cuts in order with a text card between each two, as one edit. |
| `read-data/fill.py` | Request paths, read_json and the template filler. |
| `read-data/plan_pieces.py` | The piece table, aspects, the span key. |
| `read-data/timing.py` | Edge room, word times, caption chunks, event times. |
| `read-data/cut-rules.json` | The default numbers (editing and online-video norms). |
| `test/` | `run_tests.py` over `test_assemble.py`, on recordings drawn by ffmpeg with stand-in renderer, face reader, checker and speaker (`fixtures/`). |

## How to run it

```
python3 -m pip install -U numpy soundfile pillow blake3
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py timeline --request request.json my-plan
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py build --request request.json my-plan
python3 tools/assemble-a-plan-into-a-cut/do-work/assemble.py run --request request.json
```

## Dependencies

**Depends on:** `tools/media-composition` beside it in this Workshop (the renderer, on node 22 or later); Python 3.10+, numpy, soundfile, Pillow, blake3, ffmpeg and ffprobe; the person's overlay renderer, face reader and check commands; mlx-audio for the bundled Kokoro speaker.

**Depended on by:** films whose request names it; checks such as tool:check-a-rendered-video read the spec and overlay it writes.

## Tests

`npm test` from the Workshop root, or `python3 tools/assemble-a-plan-into-a-cut/test/run_tests.py`.
