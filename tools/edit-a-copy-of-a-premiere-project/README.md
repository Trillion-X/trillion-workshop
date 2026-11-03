# Edit a copy of a Premiere project

Edits a **copy** of a Premiere Pro project from a JSON plan: **insert**, **cut**, **move** and **assemble**.
It edits the project file (gzipped XML) directly. It never opens, launches or scripts Premiere, and it never
writes the input project. One remap engine (`do-work/timeline.py`) does every operation and carries all tracks along:
video, audio, captions, inserted pieces and a full-length adjustment layer.

Premiere Pro 26.5 opened and saved a project written by this tool: it found every inserted file online, made their
peak files and read an overlay's alpha.

Moved from Trillion-X/source-repo-a `tools/premiere-insert` (e1100bf). The record of what it wrote, and the
runs for a film, stay with that film.

## Run

From the root of the Workshop checkout:

```sh
T=tools/edit-a-copy-of-a-premiere-project/do-work
python3 -I $T/premiere_insert.py PLAN.json --written FILM/written.json [--project IN.prproj] [--output OUT.prproj]
python3 -I $T/validate.py OUT.prproj                          # ids, references, orphans, order, overlaps
python3 -I $T/prdump.py OUT.prproj [FROM TO]                  # timeline listing with source seconds
python3 -I $T/proxy_render.py OUT.prproj OUT.mp4 [--from TC --to TC] [--height 360]   # ungraded check render
python3 -I $T/grade_check.py OUT.prproj ORIGINAL.prproj GRADED_EXPORT.mp4 OUT_DIR       # graded plates vs the grade
```

`premiere_insert.py` prints its log, then a last line `{"result": {output, blake3, written, replaced, length, inserts,
log}}` or `{"error": "what to change"}`.

To turn an EDIT-PLAN (`new_order` rows) into a plan:

```sh
python3 -I $T/compile_edit_plan.py EDIT-PLAN.json --transcripts DIR --output OUT.prproj --plan-out OPS.json \
  [--inserts INSERTS.json] [--protect ROW] [--protect-window A001:20:24] [--pause-over 0.9] [--pause-keep 0.4] \
  [--insert-prefix INSERT-] [--fps 24000/1001] [--project IN.prproj]
python3 -I $T/premiere_insert.py OPS.json --written FILM/written.json
```

## Plan

```json
{
  "project": "/abs/original.prproj",
  "output": "/abs/new.prproj",
  "sequence": "Main cut",
  "timecodes": "original",
  "ops": [
    {"op": "insert", "id": "c1", "at": "00:00:12:05", "pieces": [
      {"file": "/abs/c1-plate.mov", "track": "V1"},
      {"file": "/abs/c1-overlay.mov", "track": "V3"},
      {"file": "/abs/c1-narrator.wav", "track": "A2"}]},
    {"op": "insert", "id": "c5", "at": "00:04:10:02", "pieces": [
      {"placeholder": "GAP c5 PLACEHOLDER (6.5 s)", "seconds": 6.5, "track": "V1"}]},
    {"op": "cut", "range": {"from": "00:04:10:02", "to": "00:04:11:10"}},
    {"op": "move", "range": {"clip": "A002", "src_in": 30.5, "src_out": 48.0}, "to": {"after": {"clip": "A001", "src_in": 100.0, "src_out": 112.25}}},
    {"op": "assemble", "entries": [
      {"clip": "A001", "src_in": 4.0, "src_out": 9.5, "label": "R1"},
      {"insert": "c1", "label": "INSERT-c1"}]}
  ]
}
```

A plan with only an `"inserts"` list, a single insert with `"pieces"`, or a shot file carrying an `"insert"` object
also works; each becomes insert ops.

**Ranges.** A range is one of these:
- sequence timecodes: `{"from": TC, "to": TC}`;
- a source range of a clip in seconds: `{"clip": "A001", "src_in": 14.24, "src_out": 21.83}`. It must lie on V1 (or on `"track"`) as one unbroken run. Inserts sitting inside the run ride along with it. If the same source appears twice, the first occurrence is used and the log says so;
- an insert made earlier in the plan: `{"insert": "c1"}`.

**Points.** A `to` or `at` is a timecode, a frame number, `{"after": range}` or `{"before": range}`.

**Tracks.** `"create_tracks": true` lets a piece name the next video track above the top one (for example `V4` on a
3-track sequence). The tool adds it the way Premiere writes one: a copy of the top track with the next ID and index, no
items, untargeted, plus one more timeline patch entry. Without it, a missing track is refused.

**Pre-graded plates.** A plate made from a graded export goes ABOVE the adjustment layer (V3 here), with its overlay
above that (V4), and nothing on V1 under it (with the adjustment layer on V2). The adjustment layer then never grades it a second time. Check it with
`grade_check.py`.

**Timecodes.** `"timecodes": "original"` (the default) reads an insert's `at` on the input timeline, and each insert moves by the inserts made before it. Original timecodes are refused after a cut, move or assemble; use `{"after": range}` there.

## What each op does

- **insert:** every track opens a gap of the insert length at `at`. Then each piece is placed on its track at `at`: a file, or a black placeholder clip named with its label (made from the project's Black Video media). The length is the longest piece, in whole frames; a length within 0.5 ms of a frame boundary counts as that boundary.
- **cut:** the range is deleted and everything after it closes up (ripple delete).
- **move:** the range is taken out and put back at `to`; everything between closes up.
- **assemble:** the timeline is rebuilt from the listed ranges, in the listed order. Anything not listed is deleted.

The engine (`timeline.remap`) does all four the same way:
- Every video and audio item is razored at every range boundary.
- Each piece lands at its range's new position, or is deleted with the objects only it owns.
- Linked picture and sound pieces are re-linked by their span.
- A caption lands with the range that holds most of it, runs on through ranges that continue it seamlessly, and is shortened where that run ends.
- A full-length adjustment layer is re-sized to the new length and never razored, so its effects stay one stack. A partial adjustment layer is refused.
- The plan stops if an insert would be left in no range.

## compile_edit_plan.py

It reads `new_order` rows (`clip`, `src_in`, `src_out`, `inner_cuts`, `INSERT-<id>` rows (another prefix with `--insert-prefix`)) and writes an ops plan: insert ops, then one assemble op. Review it, change it if needed, then run it.
- `--inserts INSERTS.json`: a list of insert objects. Each one can also have:
  - `"anchor": {"clip", "src"}`: where the insert sits in its source. A pause holding the anchor is not trimmed, so the insert keeps its place.
  - `"resume": {"clip", "frame"}`: the insert's freeze frame. The row after the insert starts on exactly that frame.
  - Without `--inserts`, the EDIT-PLAN's own `inserts` are used.
- **Pause trim:** a gap of more than `--pause-over` s between two words, with both words inside the row, keeps `--pause-keep` s (half on each side). Word timings come from `--transcripts DIR`: one `<clip>.json` per clip with `words[]` (`type`, `start`, `end` in seconds). `--fps` sets the sequence frame rate (default 24000/1001). `--protect` rows and `--protect-window CLIP:FROM:TO` keep their pauses.
- **Not done:** filler words (um, uh). The join needs an ear, so they are left in.

## Checks before writing

- Each piece's facts come from ffprobe. The tool refuses: a different frame rate from the sequence; audio that is not stereo; a video file with audio; a missing track; drop-frame timecode; a missing file.
- **Structure:** unique ids; every reference resolves; no object left unreferenced; track lists in time order; no overlaps. Problems that already exist in the input are not counted.
- The gzip round trip must give back the same XML. The output must not be the input path.
- An existing output is replaced only if its BLAKE3 equals the entry for it in the `--written` record, the record of the files this tool wrote. That record belongs with the person's film, not with the tool. If anyone saved the output since (for example Premiere), or there is no record, the tool refuses; write to a new name. A replaced output goes to the Trash (the `trash` command), or is renamed `<output>.replaced-<time>` beside itself where there is no `trash`.

## Limits

- **Colour interpretation stays at Premiere's default.** The tool writes no colour field on an inserted file; Premiere reads it on open, the same way it reads the camera clips. Do not change a plate's interpretation: the grade (the adjustment layer's Lumetri stack) was built on the camera clips at their default interpretation, so a plate graded the same way must keep the same default. A piece with `"color_space_override"` is refused.
- **The proxy is not Premiere's render.** It has no Lumetri, no colour management (S-Log3 looks flat) and no effects. It checks order, joins, sync and inserts only.
- Mono or multichannel audio pieces, new tracks and partial adjustment layers are refused rather than guessed.

## Files

- `premiere_insert.py`: plan runner, insert op, importing files and placeholders.
- `timeline.py`: remap engine with `cut`, `move` and `assemble`; range resolution.
- `compile_edit_plan.py`: EDIT-PLAN `new_order` to ops plan.
- `prproj.py`: read, write, timecode and track helpers.
- `validate.py`, `prdump.py`, `proxy_render.py`: checks, listing and the ungraded check render.
- `grade_check.py`: each pre-graded plate's last frame against the next V1 frame as the graded export shows it
  (found through the original project's V1). Prints PSNR and mean Y/U/V and writes side-by-side PNGs. This is the
  only colour check possible without Premiere; it is not a render of the new project.

## Tests

`node --test tools/edit-a-copy-of-a-premiere-project/test/*.test.mjs` runs `test/test_edit_a_copy.py` on a made-up project that
`test/synthetic_prproj.py` builds in the test (two invented recordings on a 23.976 sequence). Needs python3 and BLAKE3;
the file-insert and proxy tests also need ffmpeg.
