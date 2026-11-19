# tools/saved-examples/

Saved examples: posts, videos and pages other people made that worked, each kept with its link, words, pictures and
why it worked, so a person and any AI can make their own work in a shape that is already proven. Each example is one
record of the kind `saved-example` in the person's own store. The store is reached directly in its own language: this
folder's one tool does what a store cannot (it checks a save, reads the link, fills what was not given) and hands the
records back; it reads and writes no store itself, and no row names the records door.

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:answer-the-saved-examples-page` | The Saved examples page's routes (`GET`/`POST /saved-examples`, `POST /saved-examples/remove`), answered `{ status, body }` as old trillion's `src/saved-examples.mjs` answered them; a save fills what was not given from the public link (internet). Takes the `saved-example` records as `stored.records` and hands the records it made or removed back in `keep` (a removed example as a null value) | takes `saved-example` in, gives `saved-example` out |

The list and the removal moved to the recipe `workflow:keep-saved-examples` (`tools/workflows/recipes/keep-saved-examples.json`, kit `tools/workflows/kits/keep-saved-examples.json`): the person's store keeps the rows, list them newest first with the count, and write a removal as a null value, proven on PGlite and a JSON folder. `tool:list-saved-examples` and `tool:remove-a-saved-example` are retired (their reader `read-data/saved-examples.mjs` and kits went with them).

Saving an example as an AI tool (`tool:save-an-example`) moves with the public-fetch rows; the page's save is `tool:answer-the-saved-examples-page`, which reads the link through `tools/read-a-public-web-link-whole-its-card`.

## Files

| File | Purpose |
|------|---------|
| `do-work/answer-the-saved-examples-page.mjs` | `answerTheSavedExamplesPage(input)`, run by `tools/workflows/do-work/run-a-function.mjs`: the page's routes, ported from the tag's `makeSavedExamples` and `handleSavedExamplesRequest`; reads `stored.records`, answers `{ status, body, keep }`. |
| `tool-rows.json` | The one row (`tool:answer-the-saved-examples-page`). |
| `kits/answer-the-saved-examples-page.json` | The kit for the page's route row. |
| `test/answer-the-saved-examples-page.test.mjs` | The tag's `test/saved-examples.test.mjs` and `test/native-saved-example-browser-routes.test.mjs`, ported onto the route row; the row runs as the engine runs it (argv, stdin, `stored`, `keep`). |
| `test/keep-saved-examples-is-the-stores-own.test.mjs` | No row names the records door; the retired tools are gone; the recipe and kit validate; the recipe's example attempts replay to its expected answers. |

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`, the recipe and kit), `tools/read-a-public-web-link-whole-its-card` (and what it imports: `tools/browse-public-page`, `tools/refuse-requests-to-private-addresses`, `tools/http-client`).

## Screens moved from the web client

These files were moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity). Their imports of the web shell's files stay as written; the client build answers them with the shell's files and opens each screen as a screen module named by its row (`screen.module`).

| File | Purpose |
|------|---------|
| `web/src/workspace/saved-examples-screen.tsx` | Saved examples (`workflow:keep-saved-examples` lists them): every post, video and page kept because it worked, as cards or a table, with a paste field to add one. |
| `show/saved-examples-mount.tsx` | The module entry the row names for `saved-examples`: `mount` is `mountSavedExamplesScreen`. |
