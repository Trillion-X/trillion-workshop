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

Saving an example (`tool:save-an-example`) reads the link from the internet, so it moves with the public-fetch rows.

## Files

| File | Purpose |
|------|---------|
| `read-data/saved-examples.mjs` | `listSavedExamples`, `removeASavedExample`, run by `tools/records-door/do-work/run-an-export.mjs`. |
| `tool-rows.json` | The two rows. |
| `test/saved-examples.test.mjs` | Both rows run against the fake records door with exactly their rights. |

## Dependencies

**Depends on:** `tools/records-door`.
