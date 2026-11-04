# tools/stream-an-answer-in-keyed-parts/

Merges a streamed answer's events into keyed parts (text, sources, related questions, patches), keeps a patch that does not apply as drift, ignores replays and answers the token a re-attach continues from.

Moved from Trillion-X/trillion (commit b92aa549f2) byte for byte by `tools/move-code-between-trees`: `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The tool's run (`do-work/`) calls the moved modules unchanged.

## How it runs

`tool:merge-a-streamed-answer` run `do-work/stream-an-answer-in-keyed-parts.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads no records and writes nothing; everything it works on is handed in.

## What stays in the old tree

`computer/local-models.mjs` in the old tree still builds its answer with this module, so the old copy stays until it moves. Source search, news and related questions are calls of their own beside the stream; this tool holds only how their parts merge.

## Files

| File | Purpose |
|------|---------|
| `do-work/stream-an-answer-in-keyed-parts.mjs` | The tool's run: the input handed to the moved modules. |
| `src/keyed-parts.mjs` | `newEntry`, `mergeEvent`, `applyOps`, `resumeToken`, `afterAttempt`. |
| `src/keyed-parts.json` | Part types, how each merges, the patch operations and the stall limit. |
| `test/keyed-parts.test.mjs` | Ported from the old tree, its first four cases as written; the local-model chat case stays there. |
| `test/stream-an-answer-in-keyed-parts.test.mjs` | The run over made-up input, and each row run as the container runner runs it, on its own sample. |
| `tool-rows.json` | The Workshop rows. |
| `moved-from.json` | Where each moved file came from, and both identities. |
| `part.json` | The public files. |

## Dependencies

**Depends on:** `tools/records-door` (the run command), Node, `@noble/hashes` (BLAKE3).

**Depended on by:** `tool-rows.json`.
