# tools/make-a-video-playable-at-ingest/

Decides whether an uploaded video is kept as it came, converted to MP4 (with the ffmpeg arguments a runner fills), or kept with the reason in words; runs nothing.

Moved from Trillion-X/trillion (commit b92aa549f2) byte for byte by `tools/move-code-between-trees`: `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The tool's run (`do-work/`) calls the moved modules unchanged.

## How it runs

`tool:decide-a-video-at-ingest` run `do-work/make-a-video-playable-at-ingest.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads no records and writes nothing; everything it works on is handed in.

## What stays in the old tree

`src/file-tools.mjs` in the old tree still calls `ingestDecision`, so the old copy stays until it moves. The sandbox that limits reads to Downloads and the base64, path or URL image forms the finding names are the computer's file door, which is engine work and not here.

## Files

| File | Purpose |
|------|---------|
| `do-work/make-a-video-playable-at-ingest.mjs` | The tool's run: the input handed to the moved modules. |
| `src/ingest-normalization.mjs` | `ingestDecision`, `convertibleLabels`, `outputNameOf`: picks the row and fills it in; pure. |
| `src/ingest-normalization.json` | Every format, size cap, ffmpeg argument and word. |
| `test/ingest-normalization.test.mjs` | Ported from the old tree's `test/saved-pages-adoption.test.mjs` F-0835 case, its assertions as written; the `finish_file_upload` half stays there. |
| `test/make-a-video-playable-at-ingest.test.mjs` | The run over made-up input, and each row run as the container runner runs it, on its own sample. |
| `tool-rows.json` | The Workshop rows. |
| `moved-from.json` | Where each moved file came from, and both identities. |
| `part.json` | The public files. |

## Dependencies

**Depends on:** `tools/records-door` (the run command), Node.

**Depended on by:** `tool-rows.json`.
