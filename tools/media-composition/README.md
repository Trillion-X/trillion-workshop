# tools/media-composition/

The video editing tools: find the action, scene changes, silence and beats in a video, reframe it to another shape, change its speed over a range, caption it, grade its colour, lay sounds and pictures over it, arrange and render an edit, measure its loudness, pick a cover frame, export an editor timeline, find and name recurring voices, blur faces that did not agree, and point editor projects at clips' new places. Each tool is one script in `do-work/` that runs inside the tool container with ffmpeg.

The colour grade files (`read-data/luts/*.cube`) are supplied by the account and are not in this repository; a render that names one without it stops with a message that says so.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The `tool-row-source` that lists this folder's `records.json` rows into the Workshop. |
| `records.json` | The 22 `ai-tool-descriptor` rows. Each is a `container` invoke that packs `do-work/` and `read-data/` here, `tools/content-identity`, and `@noble/hashes`. |
| `do-work/video-compose.mjs` | The one renderer: an edit (JSON) to a video with ffmpeg. Every tool that makes a video renders through it, by way of `do-work/render-an-edit.mjs`. |
| `do-work/` | One script per tool (`find-action-moments.mjs`, `reframe-to-a-size.mjs`, `change-speed-over-a-range.mjs`, `cut-and-caption.mjs`, `grade-a-video.mjs`, `layer-over-video.mjs`, `measure-loudness.mjs`, `save-cover-frame.mjs`, `export-editor-timeline.mjs`, `relink-editor-projects.mjs`, ...) and the helpers they import. |
| `read-data/` | DATA and pure helpers the scripts read: caption styles and lines, looks, layers, the reframe camera. |
| `read-data/stored-bytes.json` | The grade files a render reads by address (`package::media-composition::stored-bytes::<name>` -> `read-data/luts/<file>`). |
| `test/` | `node --test` proofs; the render tests need ffmpeg and ffprobe on PATH. |

## Dependencies

**Depends on:** ffmpeg, ffprobe and Node in the tool container image; `tools/content-identity` for file identities; Python with onnxruntime, rembg and the face and voice models the container holds, for the `.py` scripts.

**Depended on by:** the Workshop's container runner, through this folder's rows.
