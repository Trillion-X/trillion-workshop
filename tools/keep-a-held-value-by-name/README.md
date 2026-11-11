# keep-a-held-value-by-name

Keeps one secret value under a name in the person's own Trillion vault, through the engine's `held-values:put` door operation.

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:keep-a-held-value-by-name` | Stores the value on stdin under the one name argument | on the person's computer |

- The door admits the call as the account's own signed-in principal: the full key reaches `@held-values` `held-values:put` (src/account/sign_in/reach.json). A personal key issued with the `vault` scope reaches it too.
- The value is read from stdin and sent only in the request body. It is never an argument, never logged and never in the answer.
- At a computer that is not the writer the engine queues the value sealed to the writer and settles it there.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row. |
| `do-work/keep-a-held-value.mjs` | The run: reads stdin, calls the door with the shell program's client. |
| `test/keep-a-held-value.test.mjs` | Made-up door answers only, through a stub door. |

Run the tests: `node --test tools/keep-a-held-value-by-name/test/keep-a-held-value.test.mjs`.
