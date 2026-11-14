# tools/interactive-demo-maker/

A configured, addressed record workspace as DATA: field, relationship, view, action and rule descriptors, structured proposals and proof rows fold into one surface-independent model, and an action descriptor builds the owner-action or process request. It owns no recording, transcription, media analysis, composition, workflow or process execution, storage, publishing, CRM, calendar, mail, provider or campaign behaviour.

Carried byte for byte from bitfield-packages `packages/interactive-demo-maker` into `from-bitfield-packages/interactive-demo-maker/`; `moved-from.json` names each file's source path and commit and both identities. No other file in this repository held any of it.

## Files

| File | Purpose |
|------|---------|
| `from-bitfield-packages/interactive-demo-maker/read-data/configured-record-workspace.ts` | `descriptorSetFromRows`, `materializeStructuredProposalRows`, `readConfiguredRecordWorkspace`: rows and descriptors into the workspace model (records, relationships, actions, proposals). Pure. |
| `from-bitfield-packages/interactive-demo-maker/do-work/configured-record-workspace-actions.ts` | `buildConfiguredRecordWorkspaceActionRequest`, `buildConfiguredRecordWorkspaceRequestByDescriptorId`: the owner-action or process request an action descriptor names. Pure. |
| `from-bitfield-packages/interactive-demo-maker/tests/interactive-demo-maker-backend.test.ts` | The package's backend conformance test; it imports vitest, so it is held (the name ends in `.held`). |
| `from-bitfield-packages/interactive-demo-maker/things-to-store-and-run.json` | The package's records: surface, entry, target, capability, input, fields, relationships, record view, actions, rules, process profiles, projection. Not wired to a row. |
| `moved-from.json`, `part.json` | The receipt; the tree that imports these files. |

## Not done

No tool row yet: wiring a row for the model and the request builder is an adaptation in a commit that names the receipt.

**Depends on:** nothing (both files are pure TypeScript).

**Depended on by:** nothing in this repository.
