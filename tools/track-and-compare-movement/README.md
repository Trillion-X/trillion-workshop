# track-and-compare-movement

Four scripts a person's AI runs on the person's own computer, one after another or alone:

1. **Follow a thing I pointed at.** `track_selected_object.py` takes a video, a stretch of up to 30 seconds, the second at which the person pointed and one to 32 points on that frame (inside the object, or outside it), runs a point-prompted SAM 2 video model offline, and writes a new folder with a lossless mask video, a mask and a transparent preview picture per frame and `result.json` (the object's pixel count in each frame). A frame where the object is hidden stays empty.
2. **Read people's joints.** `estimate_pose.py` runs an ultralytics pose model the person has downloaded and writes a `pose.keypoints.v1` track: each person (one id through the clip) and each frame, 17 COCO joints as `[x, y, confidence]` in pixels. A track made from the same video bytes and the same checkpoint is reused.
3. **Line up two movements.** `align_dtw.py` takes two such tracks and writes the frame pairs that show the same phase of the movement (dynamic time warping, hard or soft, on posture with the hips as the centre and the torso as the scale). It does not say which movement is better.
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
| `read-data/pose_schema.py` | The track contract: `COCO`, `kp3` (one keypoint made safe) and `canonicalize_pose_track`. |
| `test/test_align_dtw.py` | Synthetic skeletons: two swings of different length and speed give a monotonic path with both ends anchored; an empty track, a track with a non-number and identical tracks. |
| `test/test_estimate_pose.py` | The contract, the cache rule (same size, head and tail but another middle is not the same video), the refusals and a cache hit, with no model. |
| `test/test_track_selected_object.py` | The refusals; and, when ffmpeg, torch, transformers and the small SAM 2 model are cached, a real run on a made-up video of a white square moving across black. Skipped, saying why, otherwise. |
| `test/test_author_comparison_edl.py` | The edit on synthetic tracks: labels, layout, mirror and passes from the spec, crops inside the frame and at the cell's shape, the window cut to the shorter clip, the person picked by id, the command and its refusal. |
| `test/track-and-compare-movement.test.mjs` | Runs the four python files above. Skips, saying why, when python3 or numpy is missing. |

## Invariants

- Nothing is downloaded and no frame leaves the computer: both models are read from files or the local cache.
- A bad range, frame rate, point or output folder is refused before any frame is cut or model loaded; an existing output folder is never written into.
- A pose joint that is missing or not a finite number is stored as the absent point `[0, 0, 0]`; the aligner refuses a track holding a non-number.
- The alignment cost grows with the product of the two frame counts.

## Left behind

The two packages (motion-analysis, motion-comparison) also held a tennis-and-ball perception pipeline (court geometry, ball tracking, rally and point events), learned view, phase and motion encoders trained on one person's clips, a partner-selection and certification step tuned on that data, the code that wrote the results as the old engine's records (and the comparison result record, factor confidence and sync-window types), a second dynamic-warping resampler anchored on a contact moment, and the overlay renderers. They are not here: they carry one sport's vocabulary and one person's trained weights, so they would not be a mechanism, and the records and rendering belong to the engine and the screens.

## Dependencies

**Depends on:** Python 3.10 or later; numpy for the aligner; numpy, opencv-python and ultralytics for the pose reader; numpy, pillow, torch and transformers (with `Sam2VideoModel`) plus ffmpeg for the tracker.

**Depended on by:** nothing in this repository.
