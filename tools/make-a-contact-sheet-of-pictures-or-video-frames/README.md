# make-a-contact-sheet-of-pictures-or-video-frames

A script a person's AI runs on the person's own computer. It lays pictures, or frames of a video, out as labelled contact
sheets, so a person (or a reviewer) can choose a frame, compare candidates or check a render by eye: a grid of thumbnail
candidates, the frames of a preview at the seconds that matter, or a steady run of frames over a few seconds of motion.

One JSON request in (a file named as the first argument, or standard input); the last line printed is the answer,
`{"result": {"sheets": [...], "tiles": n}}`, or `{"error": "..."}` saying what to change. Nothing is kept between runs and
no value is assumed for the person: every size, colour, font and quality below is a field of the request.

## The three kinds

### `pictures`: the given pictures in a grid

| field | default | meaning |
|---|---|---|
| `pictures` | required | `[{path, label}]` (or plain paths); a picture with no label is labelled with its file name |
| `out` | required | the sheet (JPEG) |
| `columns` | 3 | pictures to a row |
| `cell_width` | 480 | px |
| `cell_aspect` | `"16:9"` | `"w:h"`, or `"first"`: the first picture's shape |
| `fit` | `"crop"` | `crop`: scaled to the cell's width, its middle cut out when taller (a shorter picture leaves the background under it); `stretch`: scaled to the cell |
| `pad` | 6 | px round and between the cells |
| `background` | `[24, 24, 24]` | a colour name or `[r, g, b]` |
| `label.where` | `"below"` | `below` or `above` the picture |
| `label.text` | `"given"` | `given` (each picture's label) or `file-name` |
| `label.font_file` | none | a TrueType/OpenType file; with none, Pillow's own font |
| `label.size` | `max(14, cell_width // 22)` with a font file | px |
| `label.strip_px` | the size (below) or 22 (above) | height of the label's strip |
| `label.offset` | `[0, 2]` below, `[4, 4]` above | where the words start in the strip |
| `label.colour` | `[235, 235, 235]` | |
| `quality` | 88 | JPEG quality |

### `frames-at-times`: one frame at each time, stamped with it

`video`, `out`, and `times` (seconds, as numbers or as the words to stamp) or `every: {from, to, fps}` (every 1/fps second from
`from` up to `to`, stamped with three decimals). `width` 640 (each frame scaled to it), `columns` 3, `per_sheet` (all on one
sheet unless set; then `out` must hold `{k}`, the sheet number from 1), `label` (`font_file`, `size` 26, `colour` white,
`box` `black@0.6`, `x` 8, `y` 8: ffmpeg drawtext), `background` black, `quality` 88.

### `frames-at-a-rate`: ffmpeg's tile filter over a stretch

`video`, `out` (one file, or a pattern with `%02d` for every sheet), `fps`, `start` and `end` (seconds, optional), `width` 384
and `height` -2 (ffmpeg scale), `grid` `[6, 6]`, `sheets` (only the first n sheets), `jpeg_qscale` (ffmpeg `-q:v`), `nostdin`
true, `label`: `stamp` `time` (`%{pts\:hms}`) or `frame` (frame number from 0), `font_file`, `size` 16, `colour` yellow, `box`
`black@0.6`, `x` 4, `y` 4.

## How to run it

```
python3 -m pip install -U pillow        # and ffmpeg on the path for the video kinds
python3 tools/make-a-contact-sheet-of-pictures-or-video-frames/do-work/make_contact_sheet.py request.json
```

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:make-a-contact-sheet-of-pictures-or-video-frames`: `on-your-computer`, with the commands that fetch it and run it. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/make_contact_sheet.py` | The command: reads the request, makes `pictures` and `frames-at-a-rate` sheets, hands `frames-at-times` to the file below, prints the answer. Also takes the older command line `out.jpg cols cellw "label\|path" ...`. |
| `do-work/frames_at_times.py` | `frames-at-times`: one ffmpeg frame per time, stamped, laid `columns` to a row. Also a command of its own: `frames_at_times.py out.jpg video t [t ...] [--width 640]`. |
| `ports/*.json` | The port contracts: each file above starts as the byte copy of the older script it was moved from. |
| `test/test_make_contact_sheet.py` | Every kind on made-up pictures and a made-up ffmpeg test video, and the refusals. |
| `test/make-a-contact-sheet.test.mjs` | Runs them under `npm test`; skips, saying why, without Pillow. |

## Dependencies

Python 3.10+ with Pillow; ffmpeg (with drawtext) for `frames-at-times` and `frames-at-a-rate`. Depended on by nothing in
this repository.
