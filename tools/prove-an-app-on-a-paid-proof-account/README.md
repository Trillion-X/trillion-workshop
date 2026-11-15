# tools/prove-an-app-on-a-paid-proof-account/

Gives a proof account the paid plan, reads the credential that does it from its own file, and checks the captures of a first-paint proof, for the proofs of Trillion's apps that watch what a paid person gets (a free account keeps nothing a computer or an AI sends it). Not a tool a person runs: the proof scripts of trillion-apps (`scripts/prove-chrome-notices.mjs`, `scripts/prove-iphone-*.mjs`) and its `test/persons-device-guard.test.mjs` import it.

Moved here byte for byte from Trillion-X/trillion-apps `web/scripts/` and `web/test/`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here.

## Files

| File | Purpose |
|------|---------|
| `scripts/paid-proof-account.mjs` | Grants a proof account the paid plan (asked again every 10 seconds, up to 12 times, while the operator's store answers late) and verifies the proof owner before it does. |
| `scripts/credential-file.mjs` | A credential kept in its own mode-600 file and read into memory only: never argv, logs or a file others can read. |
| `scripts/first-paint-evidence.mjs` | Validates one run's captures and selected test result; visual inspection remains a separate check. |
| `test/paid-proof-account.test.mjs` | The grant's request, retries and refusals on a made-up operator. |
| `test/paid-proof-account-grant.test.mjs` | The grant itself. |
| `test/paid-proof-owner.test.mjs` | Who may be a proof owner. |
| `test/credential-file.test.mjs` | A credential is read from its own mode-600 file, never a file others can read. |
| `part.json` | `imported_by`: the repository that imports these files. |
| `moved-from.json` | The receipt: each file's source path and commit, its source identity and its identity here. |

## Dependencies

**Depends on:** Node. **Depended on by:** the proof scripts and tests of Trillion-X/trillion-apps.
