# check-a-rendered-video

A script a person's AI runs on the person's own computer. It checks a rendered video's frames, joins and audio for the mistakes a viewer notices and a maker misses, before anyone watches it: a stray frame at a cut, a cut that lands inside a word, a graphic running off the frame or covering a face, text too small to read on a phone, a sound effect that is too quiet, scratchy or laid down again like a loop, and more (the table below). It prints PASS, WARN or FAIL for each check with the times, and its last line is a JSON summary.

It is a mechanism only. Which checks run and every number and word list they use are the person's own limits, read at run time from a limits file (below); the tool ships none, so it carries nobody's taste. It works from the video and, for the checks that need it, a spec: a JSON file that says what the editor did (the stretch of source footage the video plays, its cuts and held frames, the graphics laid over it and when each appears). A video with no spec gets the checks that need only the video.

## The limits file

A JSON object, given with `--limits FILE`, and required. It holds the person's rows, nothing else is assumed:

* `frame` and `analysis`: the frame size and how the video is sampled (shared by every check), and `analysis.timeline_name` (the file beside the overlay that lists its elements, boxes and sounds) and `analysis.timeline_id_aliases` (`{event type: timeline element id}` for an event the renderer lists under another id).
* One section per check, named like its module (`in_frame`, `joins`, `word_clip`, `jitter`, `text`, `face`, ...): its numbers, and the word lists and event type names it uses (which types are text, which are cutaways, which drift by design, which fillers to cut). The check's module docstring says what each key does.
* A check whose sections are not all in the file does not run. It is reported `SKIP no limits for <sections>`, never passed.

The person's AI gets these rows from the person's own records (through the records door) or from a file the person points to, and passes the file's path. The tool never ships, merges or falls back to a default. `test/fixtures/limits-for-generated-videos.json` is a complete example of the shape, with synthetic numbers for the generated test videos.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:check-a-rendered-video`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/check_a_rendered_video.py` | The command: `check <video>` or `batch <videos-dir>`. |
| `do-work/rendercheck/cli.py` | Reads the options, runs each check, prints the report and the last-line JSON. |
| `do-work/rendercheck/ctx.py` | One video's context: spec, overlay and timeline, the time maps (cuts, holds, stitched openings) and lazily loaded frames, audio and words. |
| `do-work/rendercheck/checks/*.py` | One module per check. Each has `needs(ctx)` (why it cannot run) and `run(ctx)` (its findings). |
| `do-work/rendercheck/pins.py` | The list of checks and, for each, the limit sections it reads; a check's pin is the BLAKE3 of those, its own code and the shared code. |
| `do-work/rendercheck/sfx.py`, `media.py`, `report.py`, `jsonio.py`, `config.py` | Shared: the added sound effects, ffmpeg reading, findings and the printout, JSON, limits loading. |
| `test/fixtures/limits-for-generated-videos.json` | A worked example of the limits file, with synthetic numbers chosen for the generated test videos. It is not a recommendation and the tool never reads it outside the tests. |
| `test/test_*.py` | One passing and one failing case per check on small synthetic videos made with ffmpeg. |
| `test/run_tests.py` | Runs them all: `python3 test/run_tests.py` (or one file: `python3 test/run_tests.py test_checks.py`). |
| `test/check-a-rendered-video.test.mjs`, `test/check_environment.py` | Run those tests under `npm test`; skip, saying why, when python3, ffmpeg, numpy, OpenCV, Pillow, SciPy or blake3 is missing. |

## How to run it

```
python3 -m pip install -U numpy opencv-python pillow scipy blake3
python3 do-work/check_a_rendered_video.py check my-video.mp4 --limits my-limits.json --spec my-video.json
python3 do-work/check_a_rendered_video.py batch ./videos --limits my-limits.json --specs ./specs
```

It needs `ffmpeg` and `ffprobe` on the path. Speech timings come from `mlx-whisper` on Apple silicon (`python3 -m pip install mlx-whisper`); pass `--words words.json` (a list of `{w, s, e}` word timings) to skip it, or run on a machine without it and the checks that need words say so.

Options: `--limits FILE` (required: the person's limits, below), `--only in-frame,joins,word-clip` (a comma list of checks), `--overlay overlay.mov` (a render of the graphics alone, with alpha), `--timeline timeline.json` (where each graphic's box and sound is), `--words FILE`, `--source-words FILE` (word timings of the footage the video was cut from), `--recipe FILE` (`motion.jitter_px`), `--cache-dir DIR` (where transcriptions are kept between runs; default a folder under the system temp folder), `--json FILE` (every finding), `--ids a,b` (batch: only these videos).

Exit code 1 when any check is FAIL (WARN does not fail), 2 when there is nothing to check. The last line printed is `{"result": {"verdict" (FAIL, WARN, PASS, or NOT_MEASURED when no check could run), "videos": [{"video", "verdict", "failed", "warned", "not_measured"}]}}`.

## What each check catches

| Check | Catches | How |
|---|---|---|
| `in-frame` | A card, tick or print running off or hugging the frame edge | The overlay's alpha: opaque content inside the title-safe margin or touching the edge for longer than the limit; and the spec boxes of elements whose size is known. An element marked `"off_frame": true` is INFO. |
| `joins` | A stray frame at a cut or hold: a held frame that does not match the footage after it, one out-of-sequence frame (A B A), a frozen frame between moving ones | Frame differences of the footage only, with overlay pixels masked out. Joins come from the spec's `edit.cuts` and `edit.hold`. |
| `word-clip` | A cut or insert that lands inside a word | Two witnesses: the sound (audio that stops abruptly while still voiced, or speech that starts right at the join) and word timings from whisper on the video. |
| `jitter` | Too much stop-motion shake | From the spec: amplitude x seconds on screen of every element that jitters, how many shake at once, how long one shakes. |
| `text` | Transcript fragments, a dangling last word, an outline on text, text that is hard to read against the footage, text in the bottom caption zone that player controls cover | Spec strings and rendered frames sampled over time (WCAG contrast ratio against a minimum). |
| `face` | Graphics that cover or crowd the speaker's face | A face detector on sampled frames against the overlay's alpha. |
| `exits` | A graphic that vanishes on screen instead of leaving through the frame edge | Each connected shape of the overlay's alpha followed to where it ends. |
| `dwell` | A finished graphic that leaves before it can be read | Seconds on screen after the last element lands, against the words and items on it. |
| `type-sync` | Typing sounds that do not follow the letters | A key onset within a tolerance of every run of typed letters. |
| `backing` | A card, strip or label that does not stand out from the surface behind it | Grey-level difference between the element and its surround. |
| `movement` | Movement that is fast and small, or wide, instead of slow and small | Per-element step size and net travel. |
| `sound-balance` | An exit sound quieter than the appear sound of its graphic; an effect too quiet to hear over the voice | The effect track at each timeline sound against the voice in the video. |
| `sound-harsh` | Scratchy, grating effects | High-band share, brightness and crest factor of each effect. |
| `sound-loops` | One recording laid down again and again like a loop | Runs of several copies of the same effect (cross-correlation above a limit). |
| `sound-sync` | A sound effect that does not land on the frame of its event | Whole-stem phase-transform correlation, then per-event onsets, within one frame. |
| `settle` | A document that keeps drifting after it landed, or eases in too slowly | The overlay's alpha mass and centroid per landing. |
| `tempo` | A graphic idle for too long | Frames where alpha mass, centroid and picture are unchanged. |
| `zoom` | A zoom in followed by a zoom out | `edit.scale` keyframes. |
| `camera` | A push-in that is timid, constant-speed or too short to read | `edit.scale` and full-frame still zooms. |
| `motion-blur` | A smooth move in or out with no motion blur | Edge softness of the overlay's alpha over the move. |
| `internal-text` | Process or internal notes on screen | Every spec string against the ban patterns in the limits. |
| `text-size` | Text too small for a phone | Font-size keys against a minimum cap height at the frame's line count. |
| `info-added` | An informational graphic that only repeats the spoken words | New words and numbers against the word timings. |
| `math-shown` | Numbers on screen that relate with no arithmetic shown, or wrong arithmetic | Every on-screen string read for numbers and operations. |
| `cue` | A graphic that arrives long after the speaker points at what it shows | Burst of change in the footage at the graphic's track point. |
| `broll` | Cutaway footage too short to register or not graded to match | Seconds on screen and colour distance (delta E) to the footage around it. |
| `placement` | A graphic over the speaker's hands or a held object | Mean frame change of the footage under each timeline box, only where the overlay does not cover. |
| `filler-words-cut` | Filler words left in speech that was cut or rebuilt | Word timings near each join. |

A check that cannot run says why (`SKIP`, or an INFO empty set when the video has nothing of that kind), never a silent pass.

## The spec

A JSON object. Fields it reads (each check's docstring names the rest): `id`, `duration_s`, `edit.preview` (the `[start, end]` seconds of the source footage the video plays), `edit.overlay.at`, `edit.cuts` (ranges of the source removed), `edit.hold` (frames held, `{at, seconds}`), `edit.prepend`, `edit.scale`, `sound_base` (a video of the same range without the added sounds, so effects are measured on the delivered mix), `overlay_file`, `source_words`, and per event: `type`, `id`, `at`, `pos`, `size`, `w`, `aspect`, `rows`, `text`, `then.text`, `label`, `jitter`, `until`, `targets`, `off_frame`, `covers_a_roll`. Unknown event types are ignored. The limits say which event `type` names mean what (a text type, a card, a cutaway, a type that drifts by design): they are the names the renderer that wrote the spec uses.

The timeline is a JSON object with `elements` (`{id, at}`), `sounds` (`{kind, t}`), `boxes` (`{id, t0, t1?, box: [x0, y0, x1, y1]}` in frame pixels) and optionally `duration_s`, all times in overlay seconds. A box's `t1` is optional: without it the box counts as on screen until the next box of the same id replaces it, or to the end of the video, so text is never measured against a box after its graphic has left.

The overlay is `--overlay` or the spec's `overlay_file`, with its timeline (the file named by `analysis.timeline_name` in the limits, beside it) and effect track (a file named in `sound_mix.stem_names`, beside it).

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `Finding` | `{ check, status: FAIL \| WARN \| INFO, message, t, t_end, data }` | One thing a check found, with the seconds it happens at. |
| check module | `NAME`, `needs(ctx) => reason \| None`, `run(ctx) => [Finding]` | One check. `OVERLAY_ONLY` and `EMPTY_SET` say how an absent overlay or an empty kind is reported. |
| `Context` | `(video, spec, cfg, overlay, timeline, words, source_words, recipe, cache_dir)` | Time maps (`joins()`, `source_time()`, `hold_spans()`) and lazy `overlay_alpha()`, `audio()`, `preview_words()`. |
| `pins.check_pins` | `(cfg) => { check: blake3 }` | A per-check identity, so a recorded verdict on a check can be told stale when that check changed. |

## Dependencies

**Depends on:** Python 3.10+, ffmpeg, numpy, OpenCV (`cv2`), Pillow, SciPy (`scipy.ndimage`), blake3 (or `b3sum` on the path), and for speech timings `mlx-whisper` (Apple silicon) or a `--words` file.

**Depended on by:** `tool-rows.json` (`tool:check-a-rendered-video`), run on the person's computer by their AI.

## Limits

* The jitter check reads intent from the spec, not measured motion, because the overlay has no per-element mask.
* Contrast and outline are measured on text-over-footage types only.
* The `word-clip` sound witness sees the whole mix, so a sound effect that starts exactly on a join can hide a chopped word (a missed finding, not a false one).
* Whisper smears a word over the pause after it, so a cut inside a word longer than `max_trusted_word_s` is only a hint.
* It checks form, not meaning: wording that is wrong for the audience is a job for a reader.

## Tests

```
python3 test/run_tests.py
```
