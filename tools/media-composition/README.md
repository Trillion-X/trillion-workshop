# tools/media-composition/

The video editing tools: find the action, scene changes, silence and beats in a video, reframe it to another shape, change its speed over a range, caption it, grade its colour, lay sounds and pictures over it, arrange and render an edit, measure its loudness, pick a cover frame, export an editor timeline, find and name recurring voices, blur faces that did not agree, and point editor projects at clips' new places. Each tool is one script in `do-work/` that runs inside the tool container with ffmpeg.

The colour grade files (`read-data/luts/*.cube`) are supplied by the account and are not in this repository; a render that names one without it stops with a message that says so.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The `tool-row-source` that lists this folder's `records.json` rows into the Workshop. |
| `records.json` | The 24 `ai-tool-descriptor` rows. Each is a `container` invoke that packs `do-work/` and `read-data/` here (`tool:suggest-media-cuts` packs only its six files), `tools/content-identity`, and `@noble/hashes`. |
| `do-work/detect-events.mjs` | `tool:find-events-against-a-running-baseline`: runs the detector row `read-data/detect-events.json` names and answers `{ kind, time, confidence }` events in source seconds. A `stream` row walks `do-work/stream-features.mjs` frames (loudness rise and picture change) through `do-work/stream-core.mjs`, which carries a running baseline per feature and lets head rows say what stood out; a `program` row runs a module of this folder such as `find-action-moments.mjs`. |
| `do-work/video-compose.mjs` | The one renderer: an edit (JSON) to a video with ffmpeg. Every tool that makes a video renders through it, by way of `do-work/render-an-edit.mjs`. |
| `do-work/` | One script per tool (`find-action-moments.mjs`, `reframe-to-a-size.mjs`, `change-speed-over-a-range.mjs`, `cut-and-caption.mjs`, `grade-a-video.mjs`, `layer-over-video.mjs`, `measure-loudness.mjs`, `save-cover-frame.mjs`, `export-editor-timeline.mjs`, `relink-editor-projects.mjs`, ...) and the helpers they import. |
| `do-work/match-shots.mjs` | The shot match: an edit in, the same edit out with each clip that names `shot_match: {group}` graded toward its group's one look (Reinhard L*a*b* transfer, measured through the clip's own grade, written as one `.cube` per clip and appended to its `grade` as `lut3d`); `shot_match: {like: <segment id>}` takes that segment's LUT. Used before render-an-edit. |
| `read-data/` | DATA and pure helpers the scripts read: caption styles and lines, looks, layers, the reframe camera, the event detectors and their streams (`detect-events.json`). |
| `do-work/suggest-media-cuts.mjs` | `tool:suggest-media-cuts`: a recording's kept transcript to cut proposals as typed lines. The caller hands in the answer it kept (`kept`) and keeps the one returned (`keep`); the container keeps nothing. |
| `read-data/auto-edit.mjs`, `read-data/auto-edit.json` | Timed words to `remove-span` proposals for a mode (silent_pauses, filler_words), streamed as status, thinking, then complete or a typed ending (NO_TRANSCRIPT, NO_PROPOSALS, FAILED), kept per recording, mode and `algorithm_version`. Moved from Trillion-X/trillion `parts/media-composition/read-data/`. |
| `read-data/suggestion-stream.mjs`, `read-data/suggestion-stream.json` | Any suggestion as newline JSON lines checked against the DATA's line shapes, stopped by a signal (ABORTED), cached only for the same algorithm version. Moved from Trillion-X/trillion. |
| `read-data/auto-cleanup.ts` | The cleanup engine (silences and fillers in timed words) auto-edit reads. Moved from Trillion-X/trillion with auto-edit. |
| `read-data/stored-bytes.json` | The grade files a render reads by address (`package::media-composition::stored-bytes::<name>` -> `read-data/luts/<file>`). |
| `test/` | `node --test` proofs; the render tests need ffmpeg and ffprobe on PATH. |

## Edit fields a frame-exact cut uses

| Field | What it does |
|------|---------|
| clip `frames` | The clip's exact length in output frames: cut to that count, its last frame held when the source runs short, the sound padded or cut to the same seconds. |
| clip `still: {at, duration?}` | Holds the source frame at `at` seconds for `duration` (or `frames`); grade, `ken_burns` and fades act on it as on any clip. No sound. |
| narration `level: {lufs, gain_db: [lowest, highest]}` | Brings the placed stretch to `lufs`, measured on that stretch as heard in stereo, the gain held between the bounds. |
| narration `audio_filters` | An ffmpeg audio chain run on the placement after its level, before its fades. |
| `master_loudnorm_linear: true` | The master loudness as two passes: the program measured, then one gain applied (`master_loudness_range`, default 11 LU). |
| card line `font_file`, `border_px`, `border_color`; card `audio_source` | A card line's font and outline; the card's sound as a lavfi audio source (silence when absent). |

## Dependencies

**Depends on:** ffmpeg, ffprobe and Node in the tool container image; `tools/content-identity` for file identities; Python with onnxruntime, rembg and the face and voice models the container holds, for the `.py` scripts.

**Depended on by:** the Workshop's container runner, through this folder's rows; `tools/assemble-a-plan-into-a-cut`, which lays a plan out as one edit and renders it through `render-an-edit.mjs` after `match-shots.mjs`.
