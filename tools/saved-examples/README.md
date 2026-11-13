# tools/saved-examples/

Saved examples: posts, videos and pages other people made that worked, each kept with its link, words, pictures and
why it worked, so a person and any AI can make their own work in a shape that is already proven. Each example is one
record of the shared kind `saved-example` in the person's own records. It is read and written through the run's
records door (`tools/records-door`).

## Tools

| Tool | What it does | Records |
|------|--------------|---------|
| `tool:list-saved-examples` | Every example, newest first, and the count | list `saved-example` |
| `tool:remove-a-saved-example` | Removes one example by its id | read and write `saved-example` |
| `tool:answer-the-saved-examples-page` | The Saved examples page's routes (`GET`/`POST /saved-examples`, `POST /saved-examples/remove`), answered `{ status, body }` as old trillion's `src/saved-examples.mjs` answered them; a save fills what was not given from the public link (internet) | list and write `saved-example` |

Saving an example as an AI tool (`tool:save-an-example`) moves with the public-fetch rows; the page's save is `tool:answer-the-saved-examples-page`, which reads the link through `tools/read-a-public-web-link-whole-its-card`.

## Files

| File | Purpose |
|------|---------|
| `read-data/saved-examples.mjs` | `listSavedExamples`, `removeASavedExample`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `do-work/answer-the-saved-examples-page.mjs` | `answerTheSavedExamplesPage`: the page's routes, ported from the tag's `makeSavedExamples` and `handleSavedExamplesRequest`. |
| `tool-rows.json` | The three rows. |
| `test/saved-examples.test.mjs` | Both rows run against the fake records door with exactly their rights. |
| `test/answer-the-saved-examples-page.test.mjs` | The tag's `test/saved-examples.test.mjs` and `test/native-saved-example-browser-routes.test.mjs`, ported onto the route row. |

## Dependencies

**Depends on:** `tools/records-door`, `tools/read-a-public-web-link-whole-its-card` (and what it imports: `tools/browse-public-page`, `tools/refuse-requests-to-private-addresses`, `tools/http-client`).

## Screens moved from the web client

These files were moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity). Their imports of the web shell's files stay as written; the client build answers them with the shell's files and opens each screen as a screen module named by its row (`screen.module`).

| File | Purpose |
|------|---------|
| `web/src/workspace/saved-examples-screen.tsx` | Saved examples (`tool:list-saved-examples`): every post, video and page kept because it worked, as cards or a table, with a paste field to add one. |
| `show/saved-examples-mount.tsx` | The module entry the row names for `saved-examples`: `mount` is `mountSavedExamplesScreen`. |
