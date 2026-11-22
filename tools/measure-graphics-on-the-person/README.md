# tools/measure-graphics-on-the-person/

Measures, from pixels and never by eye, whether a vertical video's graphics cover the person and whether they sit outside
the platform safe zones. A renderer or a reviewer runs it on a finished edit and reads one verdict per law.

## What it measures

The edit is three layers over one clean picture (the same edit with no graphics):

| Layer | What it is | Bar (from its law row) |
|---|---|---|
| `graphics` | cards, labels, panels, titles, end cards | no pixel on the person mask (`graphics_person_overlap_max` 0); no pixel on the face region |
| `captions` | karaoke captions | may cover the torso; no pixel on the face region (`any_layer_face_overlap_max` 0) |
| `pose` | pose marks drawn on the body | may cover the body parts switched on; no pixel on the face region |

For every frame and every layer the tool records the layer's pixels, the share of them on the person mask, the share on
the face region, and the pixels outside each requested platform's safe rectangle. It keeps the worst frame and its time
for each measure.

The two laws it returns a verdict for:

- `graphics-never-cover-the-person` (check `workflow:check-graphics-never-cover-the-person`): the graphics share on the
  person and every layer's share on the face must be within the bar. A frame where a person is on the frame but no face
  point is found fails the law; the tool never passes a face it could not find.
- `everything-inside-platform-safe-zones` (check `workflow:check-inside-platform-safe-zones`): every layer inside every
  requested platform's safe rectangle on every frame. The row gives only `zones_from` (no number), so the bar recorded in
  the verdict is `outside_px_max: 0`.

The pose-switch law (`pose-overlay-is-a-switch-per-part`) is not measured here: which body parts are switched on, and
when, is the edit's data, not pixels. The face part of it (`face_marks_max` 0) is the pose layer's face share.

## Inputs

- The clean picture: a video, same size and frame rate as the layers.
- The layers: each an alpha video (its alpha is the layer, e.g. qtrle or ProRes 4444 with alpha) or a mask video
  (white = layer). A layer whose size differs from the clean picture is refused, never scaled.
- The platform ids, and the two law rows and the platform_safe_zones rows, read from files (`rows` fetches them from the
  held database; the tool never has a zone or a bar written in its code).
- Person detection settings (`person`): the segmentation model, the pose model, `person_conf`, `keypoint_conf`,
  `face_pad_ratio`, `imgsz`, `device`.
- `format_id` (the clip's series, as its `content-series:` id) and, to write the verdict rows, `write_verdicts` (the held connection name)
  with `files_identity`: the published clip's Files identity (`1f:...`), the key the quality gate joins verdicts on. Writing is
  refused without it.

## Person and face masks

`do-work/measure_graphics/people.py`. Person: every class-0 instance from the segmentation model, unioned (the model in
use is `yolo11n-seg.pt`). Face: the pose model's nose, eyes and ears (COCO points 0 to 4), of every detected person; the
face region is the box round those points, padded by `face_pad_ratio` times the larger side of the box. The model in use
is `yolo11x-pose.pt`, the pose model installed on this Mac (`yolo11n-pose` is not installed).

Masks are written per frame to `OUT/masks/person-NNNNN.png` and `face-NNNNN.png`, with `OUT/masks/meta.json`. They are
the evidence a verdict points to.

## Files

| File | Purpose |
|---|---|
| `tool-rows.json` | The Workshop row `tool:measure-graphics-on-the-person`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/measure_graphics_on_the_person.py` | The command line: `analyze`, `measure`, `free-regions`, `rows`, `identity`. |
| `do-work/measure_graphics/layers.py` | Reads an alpha or mask video as per-frame boolean masks; refuses size mismatch. |
| `do-work/measure_graphics/people.py` | Person and face masks from detection; masks and meta written to disk. |
| `do-work/measure_graphics/measure.py` | Per-frame numbers, the worst frames, the two law verdicts. |
| `do-work/measure_graphics/free.py` | The free-region helper for renderers (below). |
| `do-work/measure_graphics/verdicts.py` | Writes `clip_quality_verdicts` rows (the held database named in `write_verdicts`), one per (files_identity, check_id). |
| `test/test_measure_graphics.py` | Unit tests on synthetic masks and layers: `python3 test/test_measure_graphics.py`. |

## How to run

From the root of the Workshop checkout, under the load ceiling (the tool refuses while the 1-minute load is 90 or more):

```
taskpolicy -b nice -n 20 python3 tools/measure-graphics-on-the-person/do-work/measure_graphics_on_the_person.py rows --connection <held connection name> --out DIR
taskpolicy -b nice -n 20 python3 tools/measure-graphics-on-the-person/do-work/measure_graphics_on_the_person.py measure --request request.json
```

`request.json`:

```json
{
  "clean": "clean.mp4",
  "layers": {"graphics": "x-graphics.mov", "captions": "x-captions.mov", "pose": "x-pose.mov"},
  "out": "run-folder",
  "platforms": ["instagram-reels", "tiktok", "youtube-shorts"],
  "zones_file": "DIR/platform_safe_zones.json",
  "laws_file": "DIR/video_style_laws.json",
  "person": {"person_conf": 0.25, "keypoint_conf": 0.3, "face_pad_ratio": 0.6, "imgsz": 960, "device": "mps",
             "seg_model": "/path/yolo11n-seg.pt", "pose_model": "/path/yolo11x-pose.pt"},
  "format_id": "content-series:<series slug>",
  "run_label": "a label for the run",
  "write_verdicts": "<held connection name>"
}
```

Omit `write_verdicts` to print the verdicts without writing rows. The printed JSON holds the files identity (the request's
`files_identity`; without one, a BLAKE3 label of the clean picture and each layer), the two verdicts with reasons, and the worst values. The verdict rows hold the per-frame
series in `measured`, the bar and zone rows in `bar`, the run folder in `evidence_ref`.

## Free regions for a renderer

A renderer analyses its clean picture once (`analyze --clean CLEAN --out DIR ...`), then asks where a graphic may go:

```
python3 do-work/measure_graphics_on_the_person.py free-regions --out DIR --zones-file DIR/platform_safe_zones.json \
    --platform instagram-reels --margin 24 --t 2.0
python3 do-work/measure_graphics_on_the_person.py free-regions --out DIR ... --span 0:29
```

`--t` or `--frame` gives one frame; `--span FIRST:LAST` gives the rectangles free on every frame of the span, for a static
graphic. The answer is JSON: `free` (rectangles `x0, y0, x1, y1, area`, largest first) and `largest`. The free area is the
platform's safe rectangle minus the person and face masks dilated by `--margin` pixels. Place the graphic inside one of
the rectangles and measure the result with `measure` to confirm.

From Python: `from measure_graphics import free`, then `free.free_regions(out_dir, frame, zone_row, margin_px)` or
`free.free_regions_span(out_dir, first, last, zone_row, margin_px)`; `zone_row` is one `platform_safe_zones` row.

## Tests

`python3 test/test_measure_graphics.py`. It covers reading alpha and mask videos, refusing a size mismatch, the person,
face, caption and safe-zone verdicts on synthetic masks, the free-region margin, the rectangle decomposition, the zone
scaling and the verdict SQL quoting. The detection models are not run by the tests; the v5 proof runs them.
