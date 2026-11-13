# keep-a-held-value-by-name

Keeps one secret value under a name in the person's own Trillion vault, through the engine's `held-values:put` door operation, and with `--remove` removes the value held under a name through `held-values:remove`.

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:keep-a-held-value-by-name` | Stores the value on stdin under the one name argument, or with `--remove NAME` removes the value held under that name | on the person's computer |

- The door admits the call as the account's own signed-in principal: the full key reaches `@held-values` `held-values:put` (src/account/sign_in/reach.json). A personal key issued with the `vault` scope reaches it too.
- The value is read from stdin and sent only in the request body. It is never an argument, never logged and never in the answer.
- At a computer that is not the writer the engine queues the value sealed to the writer and settles it there.
- `--remove NAME --issuer-status revoked|unknown` reads no stdin and answers `{name, removed, issuer_status}` (`removed` true when a value was held, false when none was), or `{name, queued: true, issuer_status}` away from the writer. Removing a held value does not revoke it at its issuer, so the caller says which it knows. The request key is stable per name, so a retry is the same call. A service connection's own names are refused.

## Files

| File | Purpose |
|------|---------|
| `tool-rows.json` | The Workshop row. |
| `do-work/keep-a-held-value.mjs` | The run: reads stdin, calls the door with the shell program's client. |
| `test/keep-a-held-value.test.mjs` | Made-up door answers only, through a stub door. |

Run the tests: `node --test tools/keep-a-held-value-by-name/test/keep-a-held-value.test.mjs`.
