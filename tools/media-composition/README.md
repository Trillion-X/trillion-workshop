# tools/media-composition/

The video editing tools: find the action, scene changes, silence and beats in a video, reframe it to another shape, change its speed over a range, caption it, grade its colour, lay sounds and pictures over it, arrange and render an edit, measure its loudness, pick a cover frame, export an editor timeline, find and name recurring voices, blur faces that did not agree, and point editor projects at clips' new places. Each tool is one script in `do-work/` that runs inside the tool container with ffmpeg.

The colour grade files (`read-data/luts/*.cube`) are supplied by the account and are not in this repository; a render that names one without it stops with a message that says so.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The `tool-row-source` that lists this folder's `records.json` rows into the Workshop, and `tool:apply-a-pair-state-message`, a container row run by `tools/records-door`'s `run-an-export.mjs` (no records door). |
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
| `read-data/session-pairing.mjs` | `newSession(id, states)` and `apply(session, message) -> { session, ignored? }`: several devices in one recording session (primary and secondary cameras, a watch, a remote control) share one session id and exactly one primary; each sends join, leave, state or handover. A message for another session, from an unknown device or breaking the one-primary rule is ignored with a reason and never changes the session. Pure; never mutates its input. Moved byte for byte from Trillion-X/trillion `src/session-pairing.mjs`. |
| `read-data/session-pairing-tools.mjs` | `applyPairStateMessage` (`tool:apply-a-pair-state-message`): the session handed in (a new one from only `id` and `states`) with one message applied; `sessionFromInput` refuses a session with no id or no states. |
| `read-data/stored-bytes.json` | The grade files a render reads by address (`package::media-composition::stored-bytes::<name>` -> `read-data/luts/<file>`). |
| `read-data/edit-command-log.mjs` | `openEditLog({ session, store, reduce, initial })`: an edit session as a log of typed commands, each appended to the caller's store before the new state is shown, a snapshot (state, undo and redo history) every `snapshot_every` commands, undo and redo as entries, and groups kept or discarded whole; `memoryEditLogStore()` for tests and sessions that need no reload. Numbers and mark names are DATA in `edit-command-log.json`. Moved from old trillion `parts/media-composition/read-data/`. |
| `do-work/range-edits.mjs` | An edit as KEPT RANGES over the original, never new content: `keptRanges` (only start and end, sorted, disjoint, touching ranges joined, anything else refused in words), `removedRanges`, `keptTotal`, `applyKept` (only original items, in order), `checkOutputLength` (the produced length against the kept total within the caller's tolerance) and `coverage` / `refuseUntilReady` (an export waits until pieces in the caller's `ready_states` cover every kept second). Moved byte for byte from the older owner (`ports/range-edits.json`); its cutters (cut-the-action, cut-by-events) are still there and move next. |
| `ports/range-edits.json` | The SOURCE_FIRST_PORT contract for `do-work/range-edits.mjs`. |
| `src/confidence-filter.mjs`, `src/confidence-filter.json` | A second stage behind a noisy detector (REA finding F-0566): `filterEvents` keeps the events a per-context model row (a logistic of `bias` plus each weight times its feature) holds above `keep_above`, and keeps every event of a context with no model; `decide` answers `act`, `ask` or `abstain` for a confidence against `act_at` and `ask_at` (DATA in the JSON). Pure. Moved byte for byte from Trillion-X/trillion `src/` with `test/confidence-filter.test.mjs`. |
| `do-work/make-pictures-and-sounds.mjs`, `.json` | The one runner behind every `tool:make-<style>` (old trillion `parts/media-composition/do-work/make-pictures-and-sounds.mjs` at 1e886c3f, lines 172 and 249: a style runs an http maker or a program; `records/workshop-media-generation-tool-records.json`:5 makes each style its own tool). Sound effects made on the person's own computer are four more style rows and maker rows here, not a second generator: a maker may say `makes_all` (the program runs once with `output.folder` and `output.count`, so a local model loads once, and a `<result>.json` beside a result is kept as its `about`), number and list inputs reach the command (`{ each, item }` gives one argument per item), and the person's settings for that computer (program, code and weights folders, tuned numbers: the tool's settings record) come in the input's `settings` or `--settings <file>` over the maker's. A style with `runs_on: "your-computer"` is derived as a `computer` tool that writes into the folder the person grants (the source's `lay_over`). |
| `do-work/make-sound-with-stable-audio-3.py` | Maker `stable-audio-3-small-sfx`: COUNT seeds of one prompt with Stable Audio 3 Small-SFX; the latents are decoded here and a loud clip scaled under full scale instead of clamped. Ported from the launch-video repository's sound-effect generator (`ports/make-sound-with-stable-audio-3.json`). |
| `do-work/make-sound-with-moss-soundeffect.py` | Maker `moss-soundeffect-v2`: COUNT seeds of one prompt with MOSS-SoundEffect v2.0 (`ports/make-sound-with-moss-soundeffect.json`). |
| `do-work/make-sound-for-a-video-with-hunyuan-foley.py` | Maker `hunyuan-video-foley`: one sound-effect stem as long as a video from its picture, in windows of at most 15 s at the section starts, joined with 5 ms seams so every sample keeps its time (`ports/make-sound-for-a-video-with-hunyuan-foley.json`). |
| `test/make-sounds-on-this-computer.test.mjs`, `test/test_local_sound_makers.py` | The local sound styles through the runner with stand-in programs, and the three maker programs run against stand-in model modules (no weights needed; numpy, soundfile and ffmpeg). |
| `test/` | `node --test` proofs; the render tests need ffmpeg and ffprobe on PATH. |
| `test/session-pairing.test.mjs` | Trillion's session test from `test/local-document-and-catalogue.test.mjs` (F-0570) with its assertions unchanged, and the row run as the container runner runs it. Trillion's `test/video-pipeline.test.mjs` session check exercises `cut-by-events.mjs`, which stays in trillion, so it did not move. |

## Edit fields a frame-exact cut uses

| Field | What it does |
|------|---------|
| clip `frames` | The clip's exact length in output frames: cut to that count, its last frame held when the source runs short, the sound padded or cut to the same seconds. |
| clip `still: {at, duration?}` | Holds the source frame at `at` seconds for `duration` (or `frames`); grade, `ken_burns` and fades act on it as on any clip. No sound. |
| narration `level: {lufs, gain_db: [lowest, highest]}` | Brings the placed stretch to `lufs`, measured on that stretch as heard in stereo, the gain held between the bounds. |
| narration `audio_filters` | An ffmpeg audio chain run on the placement after its level, before its fades. |
| `master_loudnorm_linear: true` | The master loudness as two passes: the program measured, then one gain applied (`master_loudness_range`, default 11 LU). |
| card line `font_file`, `border_px`, `border_color`; card `audio_source` | A card line's font and outline; the card's sound as a lavfi audio source (silence when absent). |

## Not yet

`tool:run-an-app-job` and `tool:use-an-app-on-this-computer` still run on old trillion's Mac host (old trillion `computer/app-job.mjs`, `parts/media-composition/do-work/use-an-app-here.mjs`, `apps-here.json`). Their home is this folder, as `computer` rows. They have not moved, for these reasons:

- **Engine capability.** The engine cannot start an app's own tool server. `start-a-program` picks only from its `programs` rows: `ai-command`, `headless-browser` and `record-and-hear` (trillion-rust `src/runtime/workshop/computer-capabilities.json:88`, programs at `:165`). The job needs a program row `app-tool-server` with parameter `program` (the `start` command an `apps-here.json` row names, such as `filmcraft-cli` or `npx`), granting these rules:
  - `(allow process-exec file-read* (literal "{program}"))`
  - `(allow process-exec (literal "/usr/bin/open"))` and `(allow mach-lookup (global-name "com.apple.coreservices.launchservicesd"))`, so `/usr/bin/open -g -j -a <app>` can open a closed app quietly
  - `(allow process-exec (literal "/bin/ps"))`, beside `read-processes`, to see whether the app runs
  - `(allow network-outbound (remote ip "localhost:*"))`, for an app helper's signed health check on loopback

  The `places` files go into the app's own folder under `change-a-folder`, which already exists.
- **Installed-app check.** It reads `computer/computer-sources.mjs` `LOOKS` and `computer/computer-sources.json`, which move with the computer-places readers in another session. It moves after them.
- **Files.** The old Namespace client (`namespaceClient`, `sendFile`) becomes `door.files` with a `files` right (`read_file` for inputs), and outputs become the row's `outputs` with `keep_in: files`.

## Dependencies

**Depends on:** ffmpeg, ffprobe and Node in the tool container image; `tools/content-identity` for file identities; Python with onnxruntime, rembg and the face and voice models the container holds, for the `.py` scripts.

**Depended on by:** the Workshop's container runner, through this folder's rows (`tool:apply-a-pair-state-message` also needs `tools/records-door`'s `run-an-export.mjs`); in Trillion-X/trillion, `parts/media-composition/do-work/cut-the-action.mjs` still imports its own copy of `src/session-pairing.mjs` until it moves; `tools/assemble-a-plan-into-a-cut`, which lays a plan out as one edit and renders it through `render-an-edit.mjs` after `match-shots.mjs`.
