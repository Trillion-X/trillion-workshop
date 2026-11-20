# tools/interactive-demo-maker/

A configured, addressed record workspace as DATA: field, relationship, view, action and rule descriptors, structured proposals and proof rows fold into one surface-independent model, and an action descriptor builds the owner-action or process request. It owns no recording, transcription, media analysis, composition, workflow or process execution, storage, publishing, CRM, calendar, mail, provider or campaign behaviour.

The old package (bitfield-packages `packages/interactive-demo-maker`) was moved into this folder as `from-bitfield-packages/` and is now ported into the tool's own parts: `read-data/`, `do-work/` and `test/`. The old bytes stay in the private repository named in `moved-from.json`; nothing was removed from this tool in this port. `moved-from.json` still names the old `from-bitfield-packages/` paths as the receipt.

## Files

| File | Purpose |
|------|---------|
| `read-data/configured-record-workspace.ts` | `descriptorSetFromRows`, `materializeStructuredProposalRows`, `readConfiguredRecordWorkspace`: rows and descriptors into the workspace model (records, relationships, actions, proposals, proof counts). Pure. |
| `read-data/descriptor-kinds.json` | DATA: which descriptor row kind fills which descriptor set key, and the payload array that holds it. Read by `descriptorSetFromRows`. |
| `do-work/configured-record-workspace-actions.ts` | `buildConfiguredRecordWorkspaceActionRequest`, `buildConfiguredRecordWorkspaceRequestByDescriptorId`: the owner-action or process request an action descriptor names. Pure. |
| `test/interactive-demo-maker-backend.test.ts` | The backend conformance test on `node:test`: the contract's shape, walkthrough and relationship profiles reading the same descriptors, blocked actions, request building, proposal rows, and the owner-boundary source check. |
| `things-to-store-and-run.json` | The package's records (byte copy of the old contract): surface, entry, target, capability, input, fields, relationships, record view, actions, rules, process profiles, projection. Not wired to a row. |
| `moved-from.json`, `part.json` | The receipt; the tree that imports these files. |

## Presentation projection

`readConfiguredRecordWorkspace` returns the old `state` (empty, sparse, dense, loading, error, proposal-ready, taken from the inputs `state` or `process_state` when given) and `reader_key` (default `browser`, desktop, mobile, ios-jscore), ported per the lane ruling. The `view`, `sections` and `empty` values are read from the record-view descriptor as DATA.

## Not wired

- Publish and share actions (`publish-handoff`, `share-handoff`) are in the contract as DATA. Their requests can be built and their block rule is read, but wiring them to any route is a share or publish path and waits for the owner's word.
- The default targets `slot::workflow` and `engine.operation.write-batch` are the old contract's names. The trillion-rust HEAD has no `write-batch` target and no `slot::` name (grep, Nov 20 2026); the workflow route is `tool:run-a-workflow`. Naming the current target is a wiring decision and is not made here.
- No tool row yet. Wiring a row for the model and the request builder is an adaptation in a commit that names the receipt.

**Depends on:** nothing (the TypeScript is pure; the test runs under Node with type stripping, and the test imports `.ts` files by their extension).

**Depended on by:** nothing in this repository.
