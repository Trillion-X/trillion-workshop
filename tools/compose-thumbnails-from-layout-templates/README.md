# compose-thumbnails-from-layout-templates

Build still images on your own computer from your frames and text. Choose one of six fixed 1280×720 thumbnail layouts,
or give a `scene` that sets its own canvas size and stacks photos, solid rectangles and fitted text. Both use the same
settings, font file and output command.

Pass one JSON request as a file argument or on standard input. The last line is `{"result": {"thumbnails": [paths]}}`
(each candidate is an RGB PNG at `<out>/<id>.png`) or `{"error": "..."}` with exit code 1. A rejected candidate does
not write its PNG. Earlier candidates in the same request may already have been written.

## The request

| field | meaning |
|---|---|
| `out` | required output folder |
| `frames` | folder of full-size frames (`<name>.png`); required for image layers and legacy layouts (3840×2160 in the legacy coordinates) |
| `cutouts` | required only for legacy layouts: RGBA cut-outs (`<name>_cut.png`) from the crop whose top-left is `cut_offset` |
| `cut_offset` | legacy crop origin; `[1000, 150]` by default |
| `font` | `{"file": "path/to/font.ttf", "variable": false}`; required for text layers and legacy layouts. Set `variable` to true to select a named style in that TrueType/OpenType font. |
| `only` | list of candidate IDs in output order; omit or pass `[]` to render all |
| `settings_record` | the person's row `record:setting:compose-thumbnails-from-layout-templates~<scope_kind>~<scope_id>` (handed in as the record itself) |
| `settings` | laid over the row, key by key; can provide `candidates` without a row |

Give `candidates` as a map from IDs to candidate objects. Each candidate uses either `scene` or `template`, not both. One
request can include both kinds of candidates. Use plain file names for candidate IDs and frame names (up to 240 UTF-8
bytes), without directory separators, colons, control characters, or the added `.png` suffix. `.` and `..` are not names.
An input link cannot leave its input folder; an output PNG cannot be a link or special file. Each PNG is saved to a
private staging file in the output folder, then replaces the destination atomically. A failed save preserves an existing
PNG and removes its staging file; a link swapped into the destination during rendering is replaced, never followed.

### Scene: same layers at any aspect ratio

```json
{
  "frames": "./frames",
  "out": "./out",
  "font": {"file": "./fonts/DejaVuSans-Bold.ttf", "variable": false},
  "settings": {
    "candidates": {
      "preview": {
        "scene": {
          "width": 1080,
          "height": 1920,
          "background": "#142030",
          "layers": [
            {"type": "image", "frame": "one", "box": {"x": 0, "y": 0, "width": 1080, "height": 1560}},
            {"type": "rect", "paint": "#1E3480", "box": {"x": 0, "y": 1460, "width": 1080, "height": 460}},
            {"type": "text", "paint": "#FFFFFF", "text": "Start here", "font_size": 96, "min_font_size": 36,
             "box": {"x": 72, "y": 1540, "width": 936, "height": 180}}
          ]
        }
      }
    }
  }
}
```

- The canvas and every layer box use integer pixels. `x` and `y` start at the top left. Each box must have positive width
  and height and stay inside the canvas. The right and bottom edges are exclusive. `background` and `paint` are `#RRGGBB` colors.
- Layers paint first to last. `image` center-crops `<frames>/<frame>.png` to cover its box without stretching, and respects
  the PNG's alpha. `rect` fills its box with solid `paint`.
- `text` sets top-left, left-aligned copy. Use `\n` for explicit line breaks; it does not wrap or truncate. `font_size` is
  the maximum in pixels. If needed, the tool fits a smaller size down to `min_font_size` (defaults to 8 or `font_size` if
  smaller). Set both sizes equal for a fixed size. `font_style` is optional and only valid with a variable font. The
  variable-font default is `Condensed Heavy`; name a different style if the font does not have that one. The tool refuses
  copy it cannot render within the box with the supplied font and size range.
- Limits: 4,096 pixels per canvas side and 8,388,608 canvas pixels; 8,192 per source side and 24,000,000 pixels per source
  PNG; at most 16 layers per scene and 16 scene candidates per request; 512 characters per text layer and 1–512 px font sizes.
  Scene art must be a still PNG. An empty `layers` array renders just the background.

### Legacy layouts

A legacy candidate is `{template, ...values}`. The templates are a claim box across a split, a big face beside stacked
words, a magnifier on a flaw, price tags on a flat backdrop, a held object with quoted words, and a corner face with
stroked words. Variable fonts for the legacy layouts use `Condensed Heavy` and `Condensed Black`.

Positions are in the full-size frame (`face`: `[x, y, height]`
of the face box; `subject`, `bg_box`, `zoom_c`: centres and sizes) or on the 1280x720 canvas (`face_x`, `face_y`, `cut_x`,
`arrow_to`, `zoom_at`, text positions). The values each template reads are the `c[...]` keys of its function in
`do-work/compose_thumbnails.py`: `split_claim` (person, face, subject_frame, subject, text, arrow_to), `face_right_stack`
(person, face, face_px, face_x, face_y, bg, bg_box, lines, text_y), `zoom_flaw` (person, face, face_px, cut_x, face_y, bg,
bg_box, zoom_frame, zoom_c, zoom_r, zoom_at, lines, size), `tags` (person, face, face_px, cut_x, face_y, backdrop, tags),
`hold_quote` (person, face, face_px, cut_x, face_y, bg, bg_box, text, arrow_to, size), `corner_face` (person, face, face_px,
cut_x, face_y, bg, bg_box, lines, text_y, size, arrow_from, arrow_to).

## How to run it

```sh
python3 -m pip install -U pillow
python3 tools/compose-thumbnails-from-layout-templates/do-work/compose_thumbnails.py request.json
```

For the scene above, use an existing `./frames/one.png` and your own font file. The command writes `./out/preview.png`.

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row `tool:compose-thumbnails-from-layout-templates`: `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/compose_thumbnails.py` | The scene renderer, six legacy layouts and shared command. |
| `ports/compose-thumbnails.json` | The port contract for the six layouts moved from the film script. |
| `test/test_compose_thumbnails.py` | CLI, legacy layouts, scene geometry, layer pixels and error cases. |
| `test/compose-thumbnails.test.mjs` | Runs them under `npm test`; skips, saying why, without Pillow. |

## Dependencies

Python 3.10+ with Pillow; `tools/settings` (`read-data/settings.py`, for `request_settings`). Depended on by nothing here.
