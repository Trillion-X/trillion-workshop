# tools/model-response/

Asking a model for an answer on a person's behalf: whose money pays for the request (a spend gate), content parts materialized from addresses, and an answer read while it is still arriving (words so far, the documents in the run, an unfinished JSON value).

Carried byte for byte from bitfield-packages `packages/model-response` into `from-bitfield-packages/model-response/`; `moved-from.json` names each file's source path and commit and both identities. No other file in this repository held any of it.

## Files

| File | Purpose |
|------|---------|
| `from-bitfield-packages/model-response/do-work/whose-money-pays-for-this.ts` | `spendGateAskForModelRequest`, `spendGateApproved`, `spendGateRefusalMessage`. Pure; loads here. |
| `from-bitfield-packages/model-response/do-work/materialize-addressed-content-parts.mjs` | `materializeAddressedContentParts` with its policy and error class. Pure; loads here. |
| `from-bitfield-packages/model-response/read-data/an-answer-arriving-in-documents.ts` | `valueAtPath`, `documentsInTheRun`, `wordsInTheRun`, `oneAnswerFromTheRun`, `readUnfinishedJson`, `textSoFarAt`. Pure; loads here. |
| `from-bitfield-packages/model-response/do-work/request-model-response.ts.held`, `index.ts.held` | The request itself (provider request assembly, structured-output check, workflow launch). Held: it calls the old package runtime (`sendRequestToBitfieldTarget`, a trusted id minter) and sends `slot::workflow` requests, which no longer exist; it needs the records door and this repository's model call before it can load. |
| `from-bitfield-packages/model-response/**/*.test.*` | The package's tests. They import vitest, or read a fixture of another package's tree, so they are held (names end in `.held`) or named with their reason in `moved-from.json` under `held`. |
| `from-bitfield-packages/model-response/things-to-store-and-run.json` | The package's records: checks, contract (what the package does not own), the HTTP workflow action, the materialization contract and the entries. Not wired to a row. |
| `moved-from.json`, `part.json` | The receipt; the tree that imports these files. |

**Depends on:** nothing that loads (the held request needs the old package runtime).

**Depended on by:** nothing in this repository.
