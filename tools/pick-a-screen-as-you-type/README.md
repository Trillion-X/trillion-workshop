# tools/pick-a-screen-as-you-type/

Picks, as a person types, the screen that already does what their words ask (offered screens, made interfaces, kept screens), keeps the shown one calm, and fills its inputs from the words, with no model.

Moved from Trillion-X/trillion (commit b92aa549f2) byte for byte by `tools/move-code-between-trees`: `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The tool's run (`do-work/`) calls the moved modules unchanged.

## How it runs

`tool:pick-a-screen-for-typed-words`, `tool:fill-screen-inputs-from-words` run `do-work/pick-a-screen-as-you-type.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads no records and writes nothing; everything it works on is handed in.

## What stays in the old tree

The app's `src/workspace/instant-screen.tsx` and `src/meaning-or-words.mjs` (which uses `word-match.mjs`) in the old tree still need these files, so the old copies stay until they move. The 300 ms client request, the online classifier with its timeout and the server cache the findings name are the app's and the Worker's, not here.

## Files

| File | Purpose |
|------|---------|
| `do-work/pick-a-screen-as-you-type.mjs` | The tool's run: the input handed to the moved modules. |
| `src/instant-screens.mjs` | The open catalog, `rank`, the calm rule (`decide`, `choose`), the bounded answer cache (`createAnswers`) and kept screens. |
| `src/instant-screens.json` | Every weight, threshold, bound and word. |
| `src/input-parsers.mjs` | The one parser registry: dates, times, durations, amounts, people, choices, booleans, emails. |
| `src/input-parsers.json` | The parsers' words. |
| `src/word-match.mjs` | Words compared without a model (stems, common words, terms). |
| `test/instant-screens.test.mjs` | Ported from the old tree, the parser, answer-cache and kept-screen cases as written; the cases that rank the app's own screen catalog, made-controls and the Workshop screen rows stay there. |
| `test/pick-a-screen-as-you-type.test.mjs` | The run over made-up input, and each row run as the container runner runs it, on its own sample. |
| `tool-rows.json` | The Workshop rows. |
| `moved-from.json` | Where each moved file came from, and both identities. |
| `part.json` | The public files. |

## Dependencies

**Depends on:** `tools/records-door` (the run command), Node.

**Depended on by:** `tool-rows.json`.
