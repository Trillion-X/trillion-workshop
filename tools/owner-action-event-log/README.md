# tools/owner-action-event-log/

A descriptor-driven view over action and event records, the actions their owners allow, and the proof behind each. Descriptors say which records are events, which fields play which role, what each action does and who owns it; the code reads only that structure. A missing owner route gives a disabled action with its reason, never a local change to another owner's records. It runs no workflow, no process and no provider call, and holds no credentials.

Moved byte for byte from the old `owner-action-event-log` package of `bitfield-packages` (`moved-from.json` is the receipt). Import paths and the Vitest import (now the repository's shim) changed; nothing else did.

## Files

| File | Purpose |
|------|---------|
| `read-data/universal-action-event-contract.ts` | The open descriptor and model contracts: the shapes a descriptor, a projected event row, an action and a proof row take. |
| `read-data/decode-universal-action-event-inputs.ts` | Decodes the structured inputs a caller hands over, field by field, without parsing compact strings. |
| `read-data/project-universal-action-events.ts` | Projects generic records and descriptors into one serializable model: events, their actions and their proof. |
| `read-data/project-process-proof.ts` | Adapts declared process and session evidence into generic proof rows. |
| `read-data/universal-action-event-fixtures.ts` | Made-up records and descriptors the tests use. |
| `do-work/build-owner-action-event-request.ts` | Builds the request that invokes an owner's action or a workflow from a descriptor's input mapping. |
| `do-work/owner-action-disabled-reason.ts` | Resolves the disabled reason a descriptor owns when an action has no owner route. |
| `ios-jscore/owner-action-event-log-jscore.ts` | The same projection exposed for JavaScriptCore, so the phone draws the same model. |
| `index.ts` | The package entry: re-exports the projection, the request builder and the contract types. |
| `things-to-store-and-run.json` | The package's own boundary file: its capability, its input descriptor and the descriptor set. Kept as data; the old engine's record kinds in it are not wired to a tool row. |
| `__tests__/*.test.ts` | Five test files (nine cases): the contract, the projection, the request builder, the process proof and the JavaScriptCore parity. |
| `do-work/README.md`, `read-data/README.md`, `ios-jscore/README.md`, `__tests__/README.md` | The package's own notes for each folder. |
| `moved-from.json`, `ports/` | The receipt and the port contracts of the move. |

## Key Types / Functions

| Name | Role |
|------|------|
| `projectUniversalActionEvents` | Records plus descriptors in, one model out: labels, field roles, option values, view copy, proof disclosure and action availability all come from the descriptors. |
| `buildOwnerActionEventRequest` | The owner or workflow request for one action, with the inputs the descriptor maps. |
| `ownerActionDisabledReason` | Why an action cannot run, in the descriptor's words. |

## Dependencies

**Depends on:** nothing outside the folder; the tests use `test-helpers/vitest-shim.mjs`.

**Depended on by:** nothing in this repository yet. The screen that draws the model is not in this folder.
