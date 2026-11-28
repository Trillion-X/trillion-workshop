# track-and-compare-movement

Five scripts a person's AI runs on the person's own computer, one after another or alone:

1. **Follow a thing I pointed at.** `track_selected_object.py` takes a video, a stretch of up to 30 seconds, the second at which the person pointed and one to 32 points on that frame (inside the object, or outside it), runs a point-prompted SAM 2 video model offline, and writes a new folder with a lossless mask video, a mask and a transparent preview picture per frame and `result.json` (the object's pixel count in each frame). A frame where the object is hidden stays empty.
2. **Read people's joints.** `estimate_pose.py` runs an ultralytics pose model the person has downloaded and writes a `pose.keypoints.v1` track: each person (one id through the clip) and each frame, 17 COCO joints as `[x, y, confidence]` in pixels. A track made from the same video bytes and the same checkpoint is reused.
3. **Line up two movements.** `align_dtw.py` takes two such tracks and writes the frame pairs that show the same phase of the movement (dynamic time warping, hard or soft, on posture with the hips as the centre and the torso as the scale). It also gives a `distance`, the posture cost along the path divided by both frame counts, so several references can be ranked against one clip (the length-normalised score `joeblau/subvox` uses for its word templates). It does not say which movement is better.
4. **Plan a side-by-side video.** `author_comparison_edl.py` takes two clips with their pose tracks and the second to centre on in each, and writes a media-composition edit: one split segment per pass (a full pass, a slow-motion pass), each cell a crop around the joints found in that window, kept inside the frame, with labels, mirror and layout from the spec. A pass can be slowed with smooth (motion-compensated) in-between frames, or be a held contact frame; `comparison-variants.json` lists the passes the person asked for (1x, 0.5x, 0.25x and 0.1x smooth, the contact still) in 9:16 and 16:9, one edit per shape. With a sync on one side, that side plays the sync's speed pieces and the other plays as recorded. It renders nothing.
5. **Sync two swings by their landmarks.** `swing_landmarks.py` reads four moments of a swing from its pose track around a given contact: L1 takeback start, L2 furthest back, L3 contact (given), L4 finish. `phase_sync.py` reads them for both swings and retimes the reference in three constant-speed pieces so each of its landmarks lands on the output frame of the target's same landmark; each side's window runs from its own L1 to its own L4 (plus a short lead and tail), never a fixed second count. A piece outside the speed bounds of `phase-sync.json` (0.25x to 4x), or a side whose landmarks cannot be read, is refused, so a pair that cannot be synced is never distorted. The error is counted as landmark misses in output frames; with both clips given, a landmark sheet shows both people at L1..L4 side by side so a person can check that each pair is the same moment.

Whole-frame motion against a reference video is a different job: `check-a-videos-motion-against-a-reference`. A cheap non-learned follower of the most-changing part of the picture is `media-composition`'s `track-moving-subject`.

## The one route: workflow:make-matched-movement-clips

Every movement comparison and swing clip is made by `workflow:make-matched-movement-clips` (a row of
the pursuit's `workflow_recipes`), never by a hand-run script: its steps run `do-work/make_matched_clips.py`
(prepare, perceive, match, render, check, keep, and progression) from Workshop origin/main, then index each kept clip in the named store's
`recording_moment`. A guard in ai-command-center (`.claude/hooks/making-a-deliverable-needs-a-wf-run.py`, its `routes`
data) refuses running these scripts, or ffmpeg on swing-library footage, outside an open run of that workflow. Why (Nov 25 2026):
comparison clips had been made by hand scripts around this tool's matcher, contact finder and planner.

| Stage | What it runs |
|-------|--------------|
| prepare | `files_road.fetch` of the perception models and every clip by Files identity |
| perceive | `perception/run_perception.py` (pose, then `describe_clip` with the physical stroke rules on), as the index folder `select_partner` reads; a clip described with the same salience rules is reused. A tightly cut one-swing clip never reaches a sustained rest, so `quiet_edge_frac`, `min_lead_s` and `min_follow_s` let an edge cut while the body is quiet, with contact far enough inside, count as a whole swing |
| match | `match/select_partner.py` per target window; only admitted pairs (camera direction verified) are kept. With `reference_classes` (each reference folder and the class a person labelled it with) it runs the labelled mode: a window is admitted only when its nearest `movement`-class reference is within `class_admit` and every other class is at least `class_margin` further; a view family with no contrast class refuses. `class_admit` 0 admits nothing and records every window's class distances, the run the bound and margin are calibrated on |
| render | `author_comparison_edl.py` (stacked or side by side, crop on each person, centred on contact), rendered by media-composition `render-an-edit.mjs` |
| check | `side_by_side.py check` (two sources, same stroke and direction, contact within one output frame) |
| keep | `files_road.keep` (any size, in 32 MiB pieces) and one row per clip |
| progression | Only when the run's input names `progression` (then prepare goes straight to it, from the work folder's finished `pairs.json`, and the batch stages are not run): one fixed reference swing on the top cell and a target's dated swings under it, oldest first. The reference swing is the one that partners the most dates with a swing that can be shown (or the one named); per date its closest pair whose phase sync holds and whose cells hold the whole movement (the framing check, per swing), spread over time, as many as fit `seconds`; each swing is render's own plan (contact, phase sync, mirror) cut as its whole synced swing; the reference crop is held for the whole video; each swing carries its date (`label.format`) as a caption in a caption style whose letters' edge media-composition `caption-subtitle.mjs` places by measuring. Writes `progression/NAME.mp4` and `NAME.json` (every swing's program seconds, contact second and the measured caption rows) |

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | Four rows: `tool:track-a-selected-object-in-a-video`, `tool:read-peoples-poses-from-a-video`, `tool:line-up-two-movements`, `tool:plan-a-side-by-side-movement-comparison`; each `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/track_selected_object.py` | The tracker. Arguments `--video --output --start --end --time --points --fps --model [--device]`; last line `{"result": ...}` or `{"error": ...}`. |
| `do-work/estimate_pose.py` | The pose reader. `--video --out --checkpoint [--device --conf --max-frames --no-cache]`. |
| `do-work/align_dtw.py` | The aligner. `--clip --reference --out [--gamma]`. |
| `do-work/author_comparison_edl.py` | The edit builder. `--spec --out [--variants comparison-variants.json]` (with `--variants`, one edit per shape at OUT with `.9x16`/`.16x9` before `.json`); `build_edl`, `variant_specs`, `player_crop`, `safe_half` and `cell_aspect` are plain functions. A side's `sync` (a `phase_sync.v1`, file or object) retimes that side through `speed_ramp`; a pass's `smooth: true` (speed below 1) and `still: SECONDS` become the split's `speed_smooth` and `still`. |
| `do-work/comparison-variants.json` | DATA: the shapes (9x16 stacked, 16x9 side by side) and the passes of a comparison; the one list, which `stroke_variants.py` also reads its shapes and speeds from. |
| `do-work/phase_sync.py` | The landmark sync. `--spec --out [--sheet]`; spec `{fps, target: {kp, contact, track_id?, clip?}, reference: {...}, settings?, sheet?}` (a side's `in`/`out` is refused: the window comes from the landmarks); writes `phase_sync.v1`: `target`/`reference` {in, contact, out}, `landmarks` {target, reference: {L1..L4}}, `pieces` [{from, to, plays_from, plays_to, speed}], `speed_ramp` [{t, speed}], `landmark_misses_frames`, `max_phase_error_frames` (the largest miss) and, with both clips, `landmark_sheet` (default beside OUT as `.landmarks.png`); a refusal prints `{"error", "refused"}` and exits 1. `phase_sync`, `reference_window`, `reference_second` and `plays_at` are plain functions. |
| `do-work/swing_landmarks.py` | The landmark reader. `--kp --contact [--track-id --clip --sheet]`; `find_landmarks(frames, contact)` gives L1..L4 in clip seconds or raises `NoLandmark` saying which and why; `landmark_sheet(rows, out)` takes each row's frames at L1..L4 with ffmpeg (the frame nearest each second) into one labelled picture, a row per person. The rules and their measurements are under "Landmark rules" below. |
| `do-work/phase-sync.json` | DATA: the speed bounds, the miss refusal limit (output frames), the lead and tail around L1 and L4, and under `landmarks` every landmark rule number and the sheet's cell size. |
| `do-work/fast_pose.py` | The fast pose reader: ffmpeg decodes small frames, the model reads 16 at a time, one person is followed by nearest box. `--video --out --checkpoint [--height --device]`; writes the same `pose.keypoints.v1` track, about 4x the frame rate of `estimate_pose.py`. |
| `do-work/find_strokes.py` | Each stroke's contact second and window. `--track --out [--min-speed --min-arc]`; wraps `describe_clip.detect_windows` with three physical rules (lost-body frames, at most one body height a frame, the signal capped at its 99th percentile) and keeps a window only when the hitting wrist is fast enough and sweeps across the hips. |
| `do-work/stroke_variants.py` | The clip-library variants of every stroke: the shapes and speeds of `comparison-variants.json` (16:9 and 9:16, speeds 1, 0.5, 0.25, 0.1), an every-frame copy, the contact still, all from one decode, kept in Files. `--job --state --work [--spec --contacts]`; `--contacts` makes only the listed strokes; waits while the load is high and goes on from its state file. |
| `do-work/make_site_clip.py` | One site file per clip of a plan: cuts the kept stretches of the source (refusing bytes that are not the named identity), encodes once for the web (H.264, crf 18, fast start, silent unless the clip asks for sound: a voice is a person too), keeps it in Files and prints the place input for `workflow:place-each-allowed-clip-where-the-site-reads-it`. A clip or still with no `why` is refused. `--plan --work --call`. |
| `do-work/side_by_side.py` | `make`: one stroke from two recordings, one cell above the other, both at real speed, cut by frame number so each source's contact frame (read by eye: the ball on the strings) lands on the same output frame whatever the frame rates; a cell is the source's own pixels (an upscale is refused), mirrored when the spec says. `check`: the gate for a format that says comparison: is-a-comparison (two different sources, each cell matches its own source's contact frame), same-stroke (both labels read from frames), same-hitting-direction (from hand, camera side and mirror), contact-in-sync (within 1 output frame, answered in frames and ms); `--sheet` writes start, racket back, contact -1/0/+1, follow-through and end. `make --spec --out`, `check --spec --clip [--sheet]`. |
| `do-work/files_road.py` | `fetch(identity, dest)` and `keep(path, name, media_type)` through `tool:your-files` (share and read; start, one raw piece, finish), each checked by BLAKE3. |
| `read-data/pose_schema.py` | The track contract: `COCO`, `kp3` (one keypoint made safe) and `canonicalize_pose_track`. |
| `test/test_align_dtw.py` | Synthetic skeletons: two swings of different length and speed give a monotonic path with both ends anchored; an empty track, a track with a non-number and identical tracks; the distance is 0 for identical tracks and ranks a slowed copy of a movement closer than a different movement. |
| `test/test_estimate_pose.py` | The contract, the cache rule (same size, head and tail but another middle is not the same video), the refusals and a cache hit, with no model. |
| `test/test_make_site_clip.py` | The cut filter, the refused backward stretch, sound off unless asked, the place input, a clip or still with no why refused; and, with ffmpeg and b3sum, a real silent cut of a made-up video kept by its identity, and bytes that are not the named identity refused. No engine is used. |
| `test/test_side_by_side.py` | Direction from hand, camera and mirror; different strokes and unread labels refused; an upscale refused; and, with ffmpeg, two made-up sources at 30 and 24 frames a second made into one clip whose contacts share an output frame, a contact moved two frames refused, a solo clip refused as a comparison, and the sheet's frames. |
| `test/test_track_selected_object.py` | The refusals; and, when ffmpeg, torch, transformers and the small SAM 2 model are cached, a real run on a made-up video of a white square moving across black. Skipped, saying why, otherwise. |
| `test/test_author_comparison_edl.py` | The edit on synthetic tracks: labels, layout, mirror and passes from the spec, crops inside the frame and at the cell's shape, the window cut to the shorter clip, the person picked by id, the command and its refusal; a synced side's window and ramp (as long as the target's), smooth only when slowed, the still, one edit per shape from the variants. |
| `test/test_stroke_variants.py` | The clip-library variants' shapes and speeds are `comparison-variants.json`'s, the ones the library was made in, and another variants file gives its own. |
| `test/test_phase_sync.py` | Made-up swings with planned landmarks: L1..L4 found within one frame whatever the wrist labels (and with labels swapped for single frames); a wrong contact, a track starting mid-takeback and one stopping mid-follow-through refused; every reference landmark on the target's output frame, a takeback starting 0.6 s earlier aligned at L1, the window from L1 to L4, a lead shortened at a track's start, speeds outside the bounds refused, a fixed window refused; author_comparison_edl's edit from the sync; and, with ffmpeg, the command writing the sync and a sheet whose eight cells are the frames at the landmark seconds. |
| `test/test_synced_render.py` | With ffmpeg and node: made-up swings synced, planned and rendered by media-composition; each pass exactly its planned frames, the reference showing the synced source frame at 1x within 1.5 output frames (the renderer starts a cell at the first frame at or after a sub-frame `in`), contacts meeting, the still holding both contacts, smooth slow motion making in-between frames. |
| `test/track-and-compare-movement.test.mjs` | Runs the python files above. Skips, saying why, when python3 or numpy is missing. |

## Landmark rules (swing_landmarks.py) and why

Read in image space, in torso lengths from the hips' middle; nothing by its left/right label (a pose model seen from
behind swaps them, sometimes for one frame). The two wrists are followed as two tracks that move the least from frame
to frame; the racket hand is the faster one around contact. "Hands speed" is the mean of the two wrists' speeds, the
same whichever is the racket hand.

| Landmark | Rule | Why this rule |
|----------|------|---------------|
| L3 contact | Given by the caller; refused when the hands are fastest more than `contact_off_s` (0.1 s) from it within `contact_check_s` (0.35 s). | A sync pinned to a wrong contact shows wrong moments side by side. On a pro reference whose given contact was 0.968 s the frames show the racket on the ball at 1.268 s; the hands are fastest at 1.235 s. |
| L2 furthest back | Walk back from contact down the forward swing to the racket hand's lowest point (the drop), then up to its highest point before that; L2 is the last frame whose hand is still within `turn_torso` (0.15) of that height. | Height, not left/right, because where the camera stands changes where a takeback goes on screen but not how high the hand goes. The last frame at the top is the racket laid back, just before the drop. The hand's horizontal extreme was tried first and failed: from behind, a pro's arm reaches furthest sideways two frames before contact. |
| L1 takeback start | Back from L2, skipping frames with the hand within `hold_torso` (0.35) of its L2 place (a hold at the top while waiting for the ball), the last stretch of at least `ready_frames` (4) frames with hands speed at or under `ready_fraction` (0.15) of the contact speed; L1 is the frame after it. | Measured hands speed (torso lengths/s): still ready positions 0.4-1.1, takebacks 2-4, contact peaks 5-12. A fixed number fails across camera distances and pose noise; 0.15 of the swing's own peak was under every ready stretch and over every takeback. Without the hold skip, a pro holding the racket back for 5 frames was read as ready. |
| L4 finish | After contact, the first stretch of at least `finish_frames` (2) frames with hands speed at or under `finish_fraction` (0.25) of the contact speed. | One frame under the bound caught a dip mid-follow-through (0.08 s after contact); 2 frames and 0.25 put the finish on the wrapped racket in 7 of the 8 swings read. |

Measured Nov 26 2026 on 11 real swings filmed from behind (7 of one student, 4 of a pro; one pro contact read off its
frames, 1.268 s, because the given 0.968 s is the racket drop), the frames at L1..L4 looked at on sheets. Of the 8
swings read: L2 showed the racket laid back in 8; L1 the still ready position in the 3 pros and 2 of the 5 student
swings, the other 3 start while he moves to the ball (no still ready position, so L1 is the last still moment before
the move); L4 the wrapped finish in 7 (one 0.3 s late, in the recovery). Refused: one swing whose track has no frames
around contact, one pro clip whose given contact is 0.33 s before its fastest moment, and one self-fed student swing
whose frames show the given contact is right but whose hands are fastest 0.25 s after it (a false refusal).

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
