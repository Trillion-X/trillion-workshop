# tools/render-a-motion-graphics-overlay/

Draws the animated graphics that go over a piece of video. A **spec** is a timed list of events (`{type, at, ...}`):
torn paper strips and cards, typed and kinetic words, count-ups, charts and nutrition labels, marker circles and
underlines, cut-out photos, footage insets, endcards and more. The render writes:

- `overlay.mov`: ProRes 4444 with alpha.
- `sound.wav`: its sound stem, with the voice when the spec mixes one.
- `sfx-only.wav`: the sounds without the voice.
- `timeline.json`: every element, sound and placed box, with its time.

With `stills`, it writes single frames over the spec's still background instead.

The **look** is the person's settings: colours, faces, paper textures, motion, the sound table, the title-safe margin
and named sections. It is read from a row of their `list:settings` through `tools/settings`. Nothing about a film is in
this folder. The words on screen, pictures, clips and voices are in the spec. The palette, faces, recordings and
textures are in the look. `read-data/example-look/` is a made-up look for samples and tests.

## Request and answer

The row runs `do-work/render-overlay.mjs`. It reads `spec_record` (a piece's row, `settings.spec`) through the records
door, then runs the renderer under `tools/settings` `run-with-settings.mjs`. That step replaces a `settings_record` id (the
look row) with the record itself. The renderer lays the look out with `settings.request_settings`: `settings_files`,
then the row, then the request's own `settings`.

| Key | Meaning |
|---|---|
| `settings_record` | `record:setting:render-a-motion-graphics-overlay~film~<film>`: the look. |
| `settings` | The look, or changes laid over the row's look: `recipe`, `look`, `look3`, `frame`, `faces`, `sound_layers`, named sections (`do-work/overlay/look.py`). |
| `settings_files` | JSON files of a look on this computer, laid under `settings` in order. |
| `spec_record` / `spec` | A piece's row whose `settings.spec` is the spec, or the spec itself. |
| `assets` | The folder the look's relative file names are read from. |
| `root` | The folder the spec's relative file names (voice, clips, pictures, mattes) are read from. Defaults to `assets`. |
| `out` | The folder the render writes into. |
| `stills` | Seconds. Writes those frames instead of the video. |
| `lock` | `{file, wait_while?}`: one render at a time on this computer, at the lowest CPU priority. |

The answer is `{"result": {id, frames, duration_s, overlay, sound?, sfx_only?, timeline}}` or
`{"result": {id, stills}}`. When the render is refused, the answer is `{"error": "..."}` and the exit code is 1.

A render stops and names the element in these cases:

- an element leaves the title-safe area;
- the last frame still shows something;
- the spec plays a sound the table does not hold;
- a type is unknown.

## A correction insert for a cut (`tool:render-an-overlay-insert-for-a-cut`)

The second row renders what an editor needs to cut a narrated correction into a film. For each shot (a spec with
`plate {source, frame}`, `graded_frame {export, cut_frame}`, `cut_insert_s` and optionally `preview_before_end_s` /
`preview_after_start_s`; `null` when the film ends with the insert) it first runs
`tool:check-every-claim-against-its-facts-and-sources` on the shot and refuses it, drawing nothing, when its claims fail.
Then it writes into `out/<shot id>/`:

| File | What it is |
|---|---|
| `<id>-overlay-prores4444.mov` | The overlay, ProRes 4444 with alpha. |
| `<id>-narrator.wav` | The narrator's voice, padded so 0 s is the overlay's first frame. |
| `<id>-sfx-music.wav` | The look's music bed (`recipe.sound.music`) and every placed sound, with the same alignment. |
| `<id>-plate-slog3-prores422hq.mov` | The camera frame (`plate`), ungraded, held for the insert's length; kept for reference. |
| `<id>-plate-graded-prores422hq.mov` | The same moment from the graded export, held: it sits above the editor's adjustment layer. |
| `<id>-preview.mp4` | 3 s of the graded export before the insert, the insert, 3 s after. |
| `<id>-timeline.json` | Every element and sound with its time. |

A shot without `duration_s` lasts until its exit's light leak and its last word are done. A shot without an exit is
refused. `tools/edit-a-copy-of-a-premiere-project`'s FilmCraft frame holds read the overlay and the two stems by these names.

| Key | Meaning |
|---|---|
| `settings_record`, `settings`, `settings_files`, `assets`, `root`, `out`, `lock` | As for the overlay; the lock is held for the whole batch. The look's `insert` section may give `claim_check`, `preview_encoder`, `lock` and `picker_names`. |
| `spec` / `spec_record` / `specs` / `spec_records` | One shot, or a batch rendered one after another under one lock. |
| `mode` | `full` (default); `quick`: the two stems and a 540p preview with the overlay piped in, no ProRes files; `audio_only`: the stems and the preview against the overlay a full render wrote. |
| `stills` | Seconds: frames over the shot's `cutout.image` instead of the videos. |
| `preview_encoder` | This computer's H.264 encoder: `h264_videotoolbox` (the default, a Mac) or `libx264`. |
| `claim_check` | The claim check's request without `shots` (its `settings_record` id is read through the door), or `{"skip": "<why the shot makes no claim>"}`. |
| `copy_previews_to` | `{folder, names?: {shot id: name}}`: each preview is also copied to `<folder>/<name>.mp4` (a picker); names default to the look's `insert.picker_names`, then the shot id. |

The answer is `{"result": {"inserts": [{id, frames, duration_s, timeline, claim_check, overlay?, narrator?, sfx_music?,
plate?, plate_graded?, preview?, stills?, copied_to?}]}}`.

## Files

| File | Purpose |
|---|---|
| `do-work/render-overlay.mjs` | The row's command. Reads the piece row, then runs the renderer with its settings. |
| `do-work/render_a_motion_graphics_overlay.py` | Checks the request, reads spec file names against `root`, installs the look and renders. |
| `do-work/overlay/look.py` | The settings of one render. `section(name)` reads named sections. |
| `do-work/overlay/stage.py` | Frame size and rate, colours, faces, textures, shadows, torn edges, word times, sprites, and the coloured-pencil restyle. |
| `do-work/overlay/kit.py` | Look colours and faces, shadowed type, footage readers, crop to fill, the brush stroke, scrapbook edges, and exits by compass word. |
| `do-work/overlay/build.py` | `Build`: events turned into sprites and sounds, and any frame drawn from them. Also subtitles, light leak, torn sheet, person matte, crumple frames, count-roll clicks and chart icons. |
| `do-work/overlay/events/*.py` | One module per technique. Each defines one or more `ev_<type>(self, e)`, which are bound onto `Build` (`events/__init__.py`). |
| `do-work/overlay/helpers/*.py` | Drawing and sound code several events share: paper pieces, marker and slide, slide pieces, motion smear, table objects, particles, peptide beads, sound classes, writing sounds. |
| `do-work/overlay/render.py` | One render: the encode, the sound mix (`sound_events`) and the timeline. |
| `do-work/render-insert.mjs` | `tool:render-an-overlay-insert-for-a-cut`'s command: reads the shots' piece rows, the look row and the claim check's settings row, then runs the insert renderer. |
| `do-work/render_an_overlay_insert.py` | Checks an insert request (one shot or a batch), installs the look and renders each shot under the lock. |
| `do-work/overlay/insert.py` | One insert: the claim check, the overlay, the narrator and music-and-effects stems, the two freeze plates, the preview and the timeline. |
| `ports/overlay-renderer.json`, `ports/overlay-insert.json` | The SOURCE_FIRST_PORT contracts of the renderer and of the insert files. |
| `do-work/overlay/lock.py` | The render lock and the wait while a flag file says so. |
| `do-work/crumple_a_card.py` | The crumple exit: a Blender cloth simulation of the card itself (needs Blender). |
| `read-data/example-look/` | A made-up look: `look.json`, a paper texture and one click. Every face is Pillow's own (`faces: "builtin"`). |
| `test/test_render_a_motion_graphics_overlay.py` | Render, stills, refusals, file names, sound placement, event binding, the lock, still slides. |
| `test/test_render_an_overlay_insert.py` | Every insert file and its alignment, quick, audio_only, stills, a batch under the lock, the claim check's refusal (on that tool's made-up world), the look's insert defaults. |
| `test/render-an-overlay-insert.test.mjs` | Reading a batch of shots, the look row and the claim check's row from a stand-in records door, a batch through the command, and the Python tests. |
| `test/render-a-motion-graphics-overlay.test.mjs` | Reading the look and piece rows from a stand-in records door, a render through the command, and the Python tests. |

## Settings sections some events read

| Section | Read by | Holds |
|---|---|---|
| `sound_classes` | `helpers/sound_classes.py` | `{kind: {file, max_s, measured_m_lufs, target_m_lufs}}` |
| `writing_sounds` | `helpers/writing_sounds.py` | `{files: [...], gain_db}` |
| `marker_underline` | `events/marker_underline.py` | `{felt_stroke: file}` |
| `paper_pieces` | `helpers/paper_pieces.py` | `{tear_sound: {file, gain_db, max_s}}` |
| `marker_and_slide` | `helpers/marker_and_slide.py` | `{highlight: colour}` |
| `pen_page` | `events/pen_page.py` | `{marker_sound: file}` |

## Dependencies

**Depends on:**

- `tools/settings`, `tools/records-door` and `tools/content-identity`, all packed; the insert row also packs
  `tools/check-every-claim-against-its-facts-and-sources` and runs its `do-work/check_claims.py`.
- Python 3.10+ with Pillow, numpy and OpenCV (`cv2`).
- `ffmpeg` and `ffprobe` with `prores_ks`; for an insert's preview, `h264_videotoolbox` (a Mac) or `libx264`.
- Blender, only for the crumple exit.
- `tesseract`, only for `citation_card`.

**Depended on by:** none yet. A FilmCraft preview places `overlay.mov` and `sound.wav` on a project's tracks;
`tools/edit-a-copy-of-a-premiere-project`'s FilmCraft frame holds place an insert's overlay and stems.
