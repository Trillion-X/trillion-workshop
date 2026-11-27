# media-analysis

A script a person's AI runs on the person's own computer. It indexes what their videos and pictures look like and what their talks say, and answers a phrase with the best moment in each recording.

- Picture lane: frames sampled across each video (or one still), embedded with a CLIP model through open_clip.
- Speech lane: transcript chunks (the AI brings the transcript) embedded with a sentence model.
- A search is one matrix product per lane; the best row per recording wins and carries its moment (a second for a picture, a start, end and the words for speech).

The words-to-picture-vector tool (`words-as-picture-vector`) turns words into a vector in the same kind of space for a search that runs in the engine's container; this tool is the whole loop on the person's computer, indexing included.

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row `tool:media-analysis`: `on-your-computer`, with how to get it and what to tell the person. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/meaning_index.py` | The command. One JSON request per line on standard input, one reply per line on standard output, a last line `{"result": {"answered", "failed"}}`. Holds the CLIP loader (`load_clip`, `embed_text`), the two lanes (`Lane`), the query encoders (`QueryEncoders`) and the operations. |
| `test/test_meaning_index.py` | The lanes, `add`, the sampling and the line protocol on synthetic vectors (numpy only), then the real CLIP and sentence models from the local cache: saved query encoders answer without the full models, a picture and a transcript are found by a phrase. The model tests are skipped, saying why, when the models are not cached. |
| `test/meaning-index.test.mjs` | Runs that file. Skips, saying why, when python3 or numpy is missing. |
| `do-work/embed-video-frames-clip.py` | One-shot keyframe sampler: shot detection and hybrid keyframes (long shots get extra samples), near-duplicate removal, CLIP image embedding, and `build_preview_sheet` (frames as one JPEG). Ported from the package's `process-scripts/` (`5e6db3ec11`); the CLIP and video libraries load only when called. |
| `do-work/make-media-analysis-records-from-command-output.py` | Command output to claim, embedding, chapter, thumbnail and error records, with content addresses and the process-output hash map. Ported from the package (`5e6db3ec11`). |
| `test/process-scripts.test.mjs` | Runs the three test files below. |
| `test/test_embed_video_frames_clip.py` | The package's six sampler tests (interval, long shots, dedup, opaque refs, contract shape, missing video), repointed to `do-work/`. |
| `test/test_build_preview_sheet.py` | The package's five preview-sheet checks, repointed to `do-work/`. |
| `test/test_make_media_analysis_records.py` | The package's five records checks (hash map, preview refs with no inline bytes, content address, no region, unresolved hash), repointed to `do-work/`. |

## The requests

```
{ "id": 1, "op": "embed_picture", "identity": "clip-7", "file": "path to read", "media_kind": "image"?, "duration": 42.5?, "sampling": { "interval_seconds": 6, "max_frames": 20, "dedup_similarity": 0.95 }? }
{ "id": 2, "op": "embed_speech", "identity": "clip-7", "chunks": [ { "start": 0, "end": 4, "text": "..." } ] }
{ "id": 3, "op": "add", "kind": "picture", "identity": "clip-7", "value": <the value embed_picture returned> }
{ "id": 4, "op": "search", "query": "a person drawing on a whiteboard", "lanes": ["picture", "speech"], "limit": 40 }
{ "id": 5, "op": "prepare" }
```

The config file (the one argument) may hold `picture_model`, `speech_model`, `query_encoders` and `in_order`. Without `in_order` the process is warm: searches, picture indexing and speech indexing run on separate threads and a search never waits behind indexing, which suits a caller that keeps it running and writes requests as they come. With `in_order` every request is answered in the order given, which is what one file that both indexes and searches needs.

## Invariants

- Vectors are keyed by the identity the caller gave and returned to the caller to keep; `add` brings them back, so a recording is never embedded twice.
- A newer value for an identity replaces its earlier rows.
- Models load from the local Hugging Face cache offline; the script never downloads a model.
- A query encoder is the model's text side traced once to a file in `query_encoders` and kept only when it reproduces the full model's vector for a probe phrase; its file name carries the model and the torch version.
- No temporary files: frames travel from ffmpeg over a pipe.

## Dependencies

**Depends on:** Python 3.10 or later with numpy, pillow, torch, open_clip_torch, sentence-transformers and tokenizers; ffmpeg and ffprobe.

**Depended on by:** nothing in this repository.

## Carried from the package

`from-bitfield-packages/media-analysis/` holds what the package `media-analysis` kept and `do-work/meaning_index.py` does not do, under the package's own paths, byte for byte, with `moved-from.json`:

| File | What it is |
|---|---|
| `do-work/process-scripts/embed-video-frames-clip.py` | One-shot shot-based keyframe sampling (shot detection, hybrid keyframes), CLIP image embedding, near-duplicate removal and a preview sheet. `meaning_index.py` samples at a fixed interval instead. |
| `do-work/process-scripts/embed-text-clip-query.py` | One-shot CLIP query encoder. |
| `do-work/process-scripts/make-media-analysis-records-from-command-output.py` | Turns analysis command output into claim, embedding, chapter, thumbnail and error records. |
| `do-work/process-scripts/test_*.py` | The four Python tests of those scripts (plain scripts run by the Python that holds the models). |
| `do-work/submit-media-analysis.ts`, `show/MediaAnalysisPanel.tsx`, `show/mount-media-analysis.tsx` | The request builder and the request screen. They call the old package runtime, so they open no screen until swapped for the records door. |
| `things-to-store-and-run.json` | The package's records (capability, surface, entry, contracts, workflow actions). Not wired to a row. |

The package's media-resolve (bank and stock lookup) is `tools/find-media-for-a-description/`. The package's TRIBE v2 script was not committed in the package (uncommitted file), so only `tools/predict-viewer-response-to-a-video/` holds that job.
