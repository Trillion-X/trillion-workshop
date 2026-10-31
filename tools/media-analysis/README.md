# media-analysis

A script a person's AI runs on the person's own computer. It indexes what their videos and pictures look like and what their talks say, and answers a phrase with the best moment in each recording.

- Picture lane: frames sampled across each video (or one still), embedded with a CLIP model through open_clip.
- Speech lane: transcript chunks (the AI brings the transcript) embedded with a sentence model.
- A search is one matrix product per lane; the best row per recording wins and carries its moment (a second for a picture, a start, end and the words for speech).

The words-to-picture-vector tool (`words-as-picture-vector`) turns words into a vector in the same kind of space for a search that runs in the engine's container; this tool is the whole loop on the person's computer, indexing included.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row `tool:media-analysis`: `on-your-computer`, with how to get it and what to tell the person. |
| `part.json` | Nothing here is imported by other code. |
| `do-work/meaning_index.py` | The command. One JSON request per line on standard input, one reply per line on standard output, a last line `{"result": {"answered", "failed"}}`. Holds the CLIP loader (`load_clip`, `embed_text`), the two lanes (`Lane`), the query encoders (`QueryEncoders`) and the operations. |
| `test/test_meaning_index.py` | The lanes, `add`, the sampling and the line protocol on synthetic vectors (numpy only), then the real CLIP and sentence models from the local cache: saved query encoders answer without the full models, a picture and a transcript are found by a phrase. The model tests are skipped, saying why, when the models are not cached. |
| `test/meaning-index.test.mjs` | Runs that file. Skips, saying why, when python3 or numpy is missing. |

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
