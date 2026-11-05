# compose-thumbnails-from-layout-templates

A script a person's AI runs on the person's own computer. It builds video-thumbnail candidates from real frames of the
person's footage with six layout templates read off strong reference thumbnails: a claim box across a split, a big face
beside stacked words, a magnifier on a flaw, price tags on a flat backdrop, a held object with quoted words, and a corner
face with stroked words. Each template is code (the layout stays); each candidate is one row of values (which frame, where
the face is, the words, sizes and arrow ends), kept in the person's own settings row, never here.

One JSON request in (a file named as the first argument, or standard input); the last line printed is
`{"result": {"thumbnails": [paths]}}` (each candidate `<out>/<id>.png`, 1280x720) or `{"error": "..."}` saying what to change.

## The request

| field | meaning |
|---|---|
| `frames` | folder of full-size frames (`<name>.png`, 3840x2160 in the templates' numbers) |
| `cutouts` | folder of cut-outs of the same frames (`<name>_cut.png`, RGBA), each cut from the crop whose top-left is `cut_offset` |
| `cut_offset` | `[1000, 150]` by default |
| `out` | folder the thumbnails are written into |
| `font` | `{"file": a TrueType/OpenType file, "variable": true}` when it is a variable font with the named styles "Condensed Heavy" and "Condensed Black"; false uses the file as it is for every style |
| `only` | candidate ids to build; all when absent |
| `settings_record` | the person's row `record:setting:compose-thumbnails-from-layout-templates~<scope_kind>~<scope_id>` (handed as the record itself, or as its id under `tools/settings/do-work/run-with-settings.mjs`, which reads it through the records door) |
| `settings` | laid over the row, key by key |

The settings hold `candidates`: `{id: {template, ...values}}`. Positions are in the full-size frame (`face`: `[x, y, height]`
of the face box; `subject`, `bg_box`, `zoom_c`: centres and sizes) or on the 1280x720 canvas (`face_x`, `face_y`, `cut_x`,
`arrow_to`, `zoom_at`, text positions). The values each template reads are the `c[...]` keys of its function in
`do-work/compose_thumbnails.py`: `split_claim` (person, face, subject_frame, subject, text, arrow_to), `face_right_stack`
(person, face, face_px, face_x, face_y, bg, bg_box, lines, text_y), `zoom_flaw` (person, face, face_px, cut_x, face_y, bg,
bg_box, zoom_frame, zoom_c, zoom_r, zoom_at, lines, size), `tags` (person, face, face_px, cut_x, face_y, backdrop, tags),
`hold_quote` (person, face, face_px, cut_x, face_y, bg, bg_box, text, arrow_to, size), `corner_face` (person, face, face_px,
cut_x, face_y, bg, bg_box, lines, text_y, size, arrow_from, arrow_to).

## How to run it

```
python3 -m pip install -U pillow
python3 tools/compose-thumbnails-from-layout-templates/do-work/compose_thumbnails.py request.json
```

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:compose-thumbnails-from-layout-templates`: `on-your-computer`. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/compose_thumbnails.py` | The templates and the command. |
| `ports/compose-thumbnails.json` | The port contract: the file above starts as the byte copy of the film script it was moved from. |
| `test/test_compose_thumbnails.py` | Every template on made-up frames and cut-outs, the settings row, the refusals. |
| `test/compose-thumbnails.test.mjs` | Runs them under `npm test`; skips, saying why, without Pillow. |

## Dependencies

Python 3.10+ with Pillow; `tools/settings` (`read-data/settings.py`, for `request_settings`). Depended on by nothing here.
