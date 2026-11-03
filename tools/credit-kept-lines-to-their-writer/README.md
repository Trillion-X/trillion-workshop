# tools/credit-kept-lines-to-their-writer/

Credits each line of a text's newest version to whoever first wrote it, an AI or a person, from its versions; counts kept work, not generated work; keeps nothing.

Moved from Trillion-X/trillion (commit b92aa549f2) byte for byte by `tools/move-code-between-trees`: `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The tool's run (`do-work/`) calls the moved modules unchanged.

## How it runs

`tool:credit-kept-lines-to-their-writer` run `do-work/credit-kept-lines-to-their-writer.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads no records and writes nothing; everything it works on is handed in.

## What stays in the old tree

`src/person-store.mjs` in the old tree still runs the ledger in its write, so the old copy stays until the store's ledger moves to the engine. The per-commit counts of lines from completions, agent and person are kept by that ledger, not by this tool.

## Files

| File | Purpose |
|------|---------|
| `do-work/credit-kept-lines-to-their-writer.mjs` | The tool's run: the input handed to the moved modules. |
| `src/kept-work.mjs` | `keptWork` (pure), `versionsFromLog` and `makeKeptWork` (the ledger the old person store writes in its own transaction). |
| `src/kept-work.json` | How a line is normalized and which fields are tracked. |
| `test/kept-work.test.mjs` | Ported from the old tree, the `keptWork` case as written; the change-log and person-store cases stay there. |
| `test/credit-kept-lines-to-their-writer.test.mjs` | The run over made-up input, and each row run as the container runner runs it, on its own sample. |
| `tool-rows.json` | The Workshop rows. |
| `moved-from.json` | Where each moved file came from, and both identities. |
| `part.json` | The public files. |

## Dependencies

**Depends on:** `tools/records-door` (the run command), Node, `@noble/hashes` (BLAKE3).

**Depended on by:** `tool-rows.json`.
