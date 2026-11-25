# track-and-compare-movement

Four scripts a person's AI runs on the person's own computer, one after another or alone:

1. **Follow a thing I pointed at.** `track_selected_object.py` takes a video, a stretch of up to 30 seconds, the second at which the person pointed and one to 32 points on that frame (inside the object, or outside it), runs a point-prompted SAM 2 video model offline, and writes a new folder with a lossless mask video, a mask and a transparent preview picture per frame and `result.json` (the object's pixel count in each frame). A frame where the object is hidden stays empty.
2. **Read people's joints.** `estimate_pose.py` runs an ultralytics pose model the person has downloaded and writes a `pose.keypoints.v1` track: each person (one id through the clip) and each frame, 17 COCO joints as `[x, y, confidence]` in pixels. A track made from the same video bytes and the same checkpoint is reused.
3. **Line up two movements.** `align_dtw.py` takes two such tracks and writes the frame pairs that show the same phase of the movement (dynamic time warping, hard or soft, on posture with the hips as the centre and the torso as the scale). It also gives a `distance`, the posture cost along the path divided by both frame counts, so several references can be ranked against one clip (the length-normalised score `joeblau/subvox` uses for its word templates). It does not say which movement is better.
4. **Plan a side-by-side video.** `author_comparison_edl.py` takes two clips with their pose tracks and the second to centre on in each, and writes a media-composition edit: one split segment per pass (a full pass, a slow-motion pass), each cell a crop around the joints found in that window, kept inside the frame, with labels, mirror and layout from the spec. It renders nothing.

Whole-frame motion against a reference video is a different job: `check-a-videos-motion-against-a-reference`. A cheap non-learned follower of the most-changing part of the picture is `media-composition`'s `track-moving-subject`.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Four rows: `tool:track-a-selected-object-in-a-video`, `tool:read-peoples-poses-from-a-video`, `tool:line-up-two-movements`, `tool:plan-a-side-by-side-movement-comparison`; each `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/track_selected_object.py` | The tracker. Arguments `--video --output --start --end --time --points --fps --model [--device]`; last line `{"result": ...}` or `{"error": ...}`. |
| `do-work/estimate_pose.py` | The pose reader. `--video --out --checkpoint [--device --conf --max-frames --no-cache]`. |
| `do-work/align_dtw.py` | The aligner. `--clip --reference --out [--gamma]`. |
| `do-work/author_comparison_edl.py` | The edit builder. `--spec --out`; `build_edl`, `player_crop`, `safe_half` and `cell_aspect` are plain functions. |
| `do-work/fast_pose.py` | The fast pose reader: ffmpeg decodes small frames, the model reads 16 at a time, one person is followed by nearest box. `--video --out --checkpoint [--height --device]`; writes the same `pose.keypoints.v1` track, about 4x the frame rate of `estimate_pose.py`. |
| `do-work/find_strokes.py` | Each stroke's contact second and window. `--track --out [--min-speed --min-arc]`; wraps `describe_clip.detect_windows` with three physical rules (lost-body frames, at most one body height a frame, the signal capped at its 99th percentile) and keeps a window only when the hitting wrist is fast enough and sweeps across the hips. |
| `do-work/stroke_variants.py` | The clip-library variants of every stroke: 16:9 and 9:16, speeds 1, 0.5, 0.25, 0.1, an every-frame copy, the contact still, all from one decode, kept in Files. `--job --state --work [--spec --contacts]`; `--contacts` makes only the listed strokes; waits while the load is high and goes on from its state file. |
| `do-work/make_site_clip.py` | One site file per clip of a plan: cuts the kept stretches of the source (refusing bytes that are not the named identity), encodes once for the web (H.264, crf 18, fast start, silent unless the clip asks for sound: a voice is a person too), keeps it in Files and prints the place input for `workflow:place-each-allowed-clip-where-the-site-reads-it`. A clip or still with no `why` is refused. `--plan --work --call`. |
| `do-work/files_road.py` | `fetch(identity, dest)` and `keep(path, name, media_type)` through `tool:your-files` (share and read; start, one raw piece, finish), each checked by BLAKE3. |
| `read-data/pose_schema.py` | The track contract: `COCO`, `kp3` (one keypoint made safe) and `canonicalize_pose_track`. |
| `test/test_align_dtw.py` | Synthetic skeletons: two swings of different length and speed give a monotonic path with both ends anchored; an empty track, a track with a non-number and identical tracks; the distance is 0 for identical tracks and ranks a slowed copy of a movement closer than a different movement. |
| `test/test_estimate_pose.py` | The contract, the cache rule (same size, head and tail but another middle is not the same video), the refusals and a cache hit, with no model. |
| `test/test_make_site_clip.py` | The cut filter, the refused backward stretch, sound off unless asked, the place input, a clip or still with no why refused; and, with ffmpeg and b3sum, a real silent cut of a made-up video kept by its identity, and bytes that are not the named identity refused. No engine is used. |
| `test/test_track_selected_object.py` | The refusals; and, when ffmpeg, torch, transformers and the small SAM 2 model are cached, a real run on a made-up video of a white square moving across black. Skipped, saying why, otherwise. |
| `test/test_author_comparison_edl.py` | The edit on synthetic tracks: labels, layout, mirror and passes from the spec, crops inside the frame and at the cell's shape, the window cut to the shorter clip, the person picked by id, the command and its refusal. |
| `test/track-and-compare-movement.test.mjs` | Runs the python files above. Skips, saying why, when python3 or numpy is missing. |

## Invariants

- Nothing is downloaded and no frame leaves the computer: both models are read from files or the local cache.
- A bad range, frame rate, point or output folder is refused before any frame is cut or model loaded; an existing output folder is never written into.
- A pose joint that is missing or not a finite number is stored as the absent point `[0, 0, 0]`; the aligner refuses a track holding a non-number.
- The alignment cost grows with the product of the two frame counts.

## Moved from the old `motion-analysis` package

The part of `motion-analysis` the four scripts above left out is here, byte for byte from the package at its last commit (`from-bitfield-packages/moved-from.json` is the receipt; a real player's name and one first name in comments, a fixture and an assertion are swapped for made-up words by the receipt's `calls`). It keeps the package's own paths under this folder.

| Folder | What it holds |
|--------|---------------|
| `do-work/process-scripts/perception/` | Clip to `motion-clip-descriptor.v1` in two stages (`pose_estimate.py` then `describe_clip.py`, run by `run_perception.py` / `orchestrate.sh`), with the ONNX forms of the pose, orientation and body-heading readers, `swing_state.py`, `model_location.py`, `finite_json.py`, `perception_backend.py` and the pose contract `pose_schema.py`. |
| `do-work/process-scripts/match/` | The court, ball, bounce, line-call, rally, point-outcome and shot-speed tracker family (`court_geometry.py`, `wasb_infer.py`, `bounce_detect_v2.py`, `rally_events.py`, `point_outcome.py`, `shot_speed.py`, `emit_match_facts.py`, `render_overlay.py`, the Pyodide and browser drivers and probes), with its tests. One sport's vocabulary, kept as it was. |
| `do-work/process-scripts/reel/` | The side-by-side reel stages: `track_ball.py`, `detect_beats.py`, `align_dtw.py`, `render_side_by_side.py`, `render_vertical_crop.py`, `asr_transcribe.py`, `voice_synthesize.py`, `detect_subject_track.py` (the follower `media-composition`'s semantic reframe needs), with `test_reel_pipeline.py`. |
| `do-work/process-scripts/ingest/` | A reference clip's descriptor to `motion-reference-clip` records and back to a matcher index, with the index builders and their tests. |
| `do-work/process-scripts/bio/`, `prosody/`, `affect/` | The three passive-perception producers (heart-rate variability, voice arousal, face action units): raw self-describing facts, fail closed. |
| `do-work/process-scripts/make-motion-analysis-records-from-command-output.py` | The generic record-maker the scripts' output goes through. |
| `do-work/submit-motion-analysis.ts`, `do-work/request-match-perception.ts` | The request builders (tests held). |
| `read-data/read-motion-analysis.ts`, `read-data/read-capture-context.ts` | The readers the screens use. |
| `show/` | The motion analysis panel and the capture-and-analyze surface, with their mounts. Their data layer is the retired package runtime and the shared UI parts are not in this tree (see Held). |
| `things-to-store-and-run.json` | The package's own boundary file (its record contracts, process descriptors and actions). Kept as data; not wired to a tool row. |

### Two copies of four jobs

The four scripts at the top of this folder were written fresh from the package's. They were not deleted, because each does something the package script does not: `align_dtw.py` adds the length-normalised `distance`; the others print one `{"result"}` or `{"error"}` last line and refuse in words, which the tool rows rely on, where the package's scripts exit or raise. The package's own `perception/pose_estimate.py` (the original of `estimate_pose.py`), `perception/pose_schema.py` (240 lines, against `read-data/pose_schema.py`'s 52) and `reel/align_dtw.py` are here beside them. The package's `track_selected_object.py` exists only as an uncommitted file in the package, so it was not carried. Whether to retire the four rewrites for the originals is a decision this move does not take.

### Held

- Ten files are held as `.held` (reasons in the receipt key `held`): two request-builder tests (they import `@/packages/content-media-evidence/...`, not in this tree), two read-data tests (`__dirname`), `perception/test_bundle_parity.py` (it compares against a file of the old app) and the others named there.
- Not carried: the trained models and wheels (`onnx/`, `*.pt`, `clip_axes.npz`; the package never tracked the models), the stored built bytes, the old engine's entry scope, and the package's `proof/`.
- Run here: the ingest tests (30), `match/test_log_filter.py`, `test_point_outcome.py`, `test_seam_mapping.py`, `test_shot_speed.py`, `test_descriptor_mapping.py`, the five `match/test_*.mjs` and `read-data/read-capture-context.test.ts` pass. The tests that need numpy, onnxruntime or the vendored model tree (`MATCH_VENDOR_ROOT`) were not run: none is installed here.
- `semantic-reframe` in `tools/media-composition` can run once `reel/detect_subject_track.py` has its models.

## Dependencies

**Depends on:** Python 3.10 or later; numpy for the aligner; numpy, opencv-python and ultralytics for the pose reader; numpy, pillow, torch and transformers (with `Sam2VideoModel`) plus ffmpeg for the tracker.

**Depended on by:** nothing in this repository.

## The original package files (prepared restore)

The four scripts above are a reduced port of two packages; the `Left behind` list names what they dropped. `from-bitfield-packages/moved-from.json` carries the original `packages/motion-comparison` back, byte for byte, with real names made up through `calls`: the matcher (`do-work/process-scripts/match/`: clip describing, phase and view and orientation work, motion certification, partner selection, the encoders), the renderer (`render/dtw_align.py`, `render_side_by_side_v2.py`, `pose_schema.py`), `author-comparison-edl.py`, the records writer, the screen (`show/MotionComparisonSurface.tsx`), the readers and the request builders. `author_comparison_edl.py`, `align_dtw.py` and `pose_schema.py` above are rewrites of originals now beside them. Not carried: the three trained models (`motion.pt`, `tcc.pt`, `view.pt`, trained on one person's clips). Held: the screen and the request builders import the retired package runtime; four tests are held. `render_side_by_side_v2.py` has uncommitted edits in the package that are not carried.
