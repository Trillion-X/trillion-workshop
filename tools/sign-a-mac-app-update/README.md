# sign-a-mac-app-update

Signs the Mac app's update record text with the release key held in the person's vault under `mac-app-update-signing-key`, through the engine's `secrets:sign` operation on `@secrets`.

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:sign-a-mac-app-update` | Signs the payload on stdin; answers `{name, signature_base64}` | in a run on the person's computer |

- The run's capability is on fd 3 (`invoke.records.rights`: `{"secret": "mac-app-update-signing-key", "operations": ["secrets:sign"]}`). The engine refuses the call from a person's key or an AI key without a run.
- The key never leaves the vault: the engine answers only the signature (hex), and this tool converts it to base64.
- The tool reads fd 3 and makes its one call itself, the way `openRecordsDoor` does, because the shared records door exposes no generic resource operation. When it does, this copy goes.

## Files

| File | Purpose |
|------|---------|
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row, with the one right. |
| `do-work/sign-a-mac-app-update.mjs` | The run: reads the payload on stdin, calls `secrets:sign` once on fd 3's door. |
| `test/sign-a-mac-app-update.test.mjs` | A synthetic Ed25519 key on a synthetic account, through a stub door. |

Run the tests: `node --test tools/sign-a-mac-app-update/test/sign-a-mac-app-update.test.mjs`.
