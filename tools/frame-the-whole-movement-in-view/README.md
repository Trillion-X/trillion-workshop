# tools/frame-the-whole-movement-in-view/

Keeps a vertical video's whole movement inside the picture, by measurement. The law (video_style_laws `the-whole-movement-stays-in-view`): the number of frames where the subject's box or its implement's box crosses the picture edge is 0, for every client's video of a movement.

## Commands (one request file each; the request's `command` picks it)

| Command | Reads | Writes | Does |
|---|---|---|---|
| `measure` | the source video, shots (`start`, `end`, `slow`) | `out/boxes.json` | detects the subject (largest subject-class box) and the implement near it (implement-class boxes within `near_px`) on every sampled frame of each shot |
| `choose` | `out/boxes.json`, `layouts` in the order to try, `output`, `margin`, `follow_window_frames`, `max_zoom` | `out/framing.json` | for each shot, every layout's window and the frames whose box crosses its edge; the picked layout is the first in order with 0 such frames |
| `gate` | `out/framing.json` | nothing | exits 1 unless every shot is picked with 0 frames out of view; the workflow goes back to `choose` on that failure |

## Layouts are rows

A layout is `{name, aspect, sizing}`. The tool does not know any layout's name; the workflow passes the layout rows of the law, in order (tightest first, side-by-side last, never the default):

- `full-height`: the whole source height at `aspect` (9:16 for full-bleed). Its zoom is output height over window height and must not exceed `max_zoom`.
- `around-movement`: the smallest window at `aspect` holding the shot's whole extent plus `margin`, capped at the source. Used for the wide layout with blurred bars and for the stacked comparison's panel (aspect = output width over half the output height).
- `follow`: one window per frame at `aspect`, holding the boxes of the frames within `follow_window_frames` of it, so it moves and widens with the movement.

## Graphics in the bars

`choose` also writes each shot's `graphic_areas`: for the blurred-bars layout, the two bands above and below the window at full width, inside `safe_margin_px` (a request setting, to be read from the platform safe zone rows when wired). Graphics and captions for that shot go only there. The full-bleed, follow and stacked layouts give none: their graphics stay where the layout puts them, measured by the graphics tool. An unknown layout name fails loud rather than getting a guessed area.

## Evidence

Every candidate keeps its window, zoom, extent and `undetected_frames` (frames with no subject, which the gate cannot measure). The `full-height` candidate is the "before" count for a fixed full-bleed frame; the picked layout is the "after".

## Files

| File | Purpose |
|---|---|
| `do-work/frame_the_movement.py` | the three commands |
| `test/test_frame_the_movement.py` | 10 tests on synthetic boxes, no detection model: `python3 test/test_frame_the_movement.py` |
| `tool-rows.json` | the Workshop row (`tool:frame-the-whole-movement-in-view`), on the person's computer |
| `part.json` | nothing here is imported by other code |

## Limits

- Detection uses the segmentation model passed as `model` (yolo11n-seg) with the COCO classes passed as `subject_class` and `implement_class`; no client, sport or brand word is in the code.
- `measure` refuses while the 1-minute load is 120 or more; run it one at a time.
- Frames with no subject are not counted as out of view; they are reported as `undetected_frames`.
