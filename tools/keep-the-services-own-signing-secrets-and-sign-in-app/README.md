# tools/keep-the-services-own-signing-secrets-and-sign-in-app/

Keep the service's own signing secrets and sign-in app values sealed in a locked box, and change the master keys without ever reading one back.

## What is here

| Path | What it does |
|------|--------------|
| `do-work/sign-in-app-values.mjs` | Ported from the retired repository `src/service-values.mjs` (tag `before-worker-retire`, b6ae0ebf81). Names the values a service holds from its DATA, seals and removes them in the account's locked box, keeps the sign-in app id readable, says which names are held, keeps an account's own sign-in app, and answers the `/work/service-values` request (`answerServiceValuesRequest`). The box, plain-fact store and addresses are arguments. |
| `test/sign-in-app-values.test.mjs` | The old held file's outcomes as 17 assertions over the port, with an in-memory box. |
| `test/operator-keeps-sign-in-apps.test.mjs` | The tool row's assertions: `tool:keep-the-services-sign-in-apps` (account action `keep-service-values`) in `tools/keep-and-wake-ai-sessions-on-this-computer/records/workshop-account-tool-records.json`. |
| `moved-from.json` | The receipt: source commit, old paths, and the new home of each old file (`ported_to`). |

The old `from-an-older-version/` folder is gone; its bytes are in git history at `b6ae0ebf81` and at the commit that removed them (named in `moved-from.json`).

## Still open (the gaps, with evidence)

- **No runner for the account actions.** `tool:keep-the-services-sign-in-apps` (workshop-account-tool-records.json:3331-3400, invoke line 3398) and `tool:use-my-own-sign-in-app` (lines 3247-3320, invoke line 3314) declare `account-action` invokes. trillion-rust `src/tool_runs/tools.rs:1125-1129` `KINDS` has only `container`, `computer` and `http`. Engine change, not small: a new kind module with operator-only admission, the vault write and remove path, and tests. Written as a To do row.
- **Lending the operator's sign-in app to other accounts (old `lendSignInClient`, `borrowSignInClient`) is LOST.** Current path: `tools/connect-a-service-and-seal-its-key/do-work/connect-by-signing-in.mjs:112-115` reads the id from the account's own `sign-in-app` row, and `do-work/process-scripts/acquire-credential.mjs:75-76` takes the secret from the account's own vault. Another account cannot use the operator's secret. Needs a handle store in the engine: To do row.
- **DATA shape.** The port reads the old `rows.tools` / `rows.event_sources` shape. The current DATA uses `sign-in-app` list rows (`sign-in-settings.json:7`). A small adapter maps one to the other before anything calls the port.
- **Route not mounted.** `answerServiceValuesRequest` is not mounted at `/work/service-values`; Connections is the owner of that surface.

## Retired

- Operator store and record reader for the Worker (old `operatorStore`, `serviceRecordReader`): retired by commit `4ffa1dc4a2` (2026-11-03 19:11 -0700), "Retire the retired repository's Worker and everything only it reached". The engine replacement is the vault, `trillion-rust src/secrets.rs`.

## Dependencies

**Depends on:** nothing outside this folder at runtime (the port is pure).
**Depended on by:** nothing yet; see the gaps above.
