# keep-a-secret-by-name

Keeps one secret value under a name in the person's own Trillion vault, through the engine's `secrets:put` door operation, and with `--remove` removes the value held under a name through `secrets:remove`.

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:keep-a-secret-by-name` | Stores the value on stdin under the one name argument, or with `--remove NAME` removes the value held under that name | on the person's computer |

- The door admits the call as the account's own signed-in principal: the full key reaches `@secrets` `secrets:put` (src/account/sign_in/reach.json). A personal key issued with the `vault` scope reaches it too.
- `NAME --hosts api.example.com,mcp.example.com` keeps the value with the only hosts it may be sent to (the input's `hosts`); the answer is `{name, accepted, hosts}`. Without `--hosts` a new value goes nowhere and a replaced one keeps the hosts it had.
- The value is read from stdin and sent only in the request body. It is never an argument, never logged and never in the answer.
- At a computer that is not the writer the engine queues the value sealed to the writer and settles it there.
- `--remove NAME --issuer-status revoked|unknown` reads no stdin and answers `{name, removed, issuer_status}` (`removed` true when a value was held, false when none was), or `{name, queued: true, issuer_status}` away from the writer. Removing a secret does not revoke it at its issuer, so the caller says which it knows. The request key is stable per name, so a retry is the same call. A service connection's own names are refused.

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row. |
| `do-work/keep-a-secret.mjs` | The run: reads stdin, calls the door with the shell program's client. |
| `test/keep-a-secret.test.mjs` | Made-up door answers only, through a stub door. |

Run the tests: `node --test tools/keep-a-secret-by-name/test/keep-a-secret.test.mjs`.
