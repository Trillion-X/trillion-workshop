
## Moved from bitfield-packages (byte for byte, not yet wired to a tool row)

The rest of the original `operation-records` package: the operation work store, the projection of operations into modes and lenses, the source-linked record review and the tests of the whole package.

`from-bitfield-packages/moved-from.json` names each moved file, its source path, the full source commit and both identities; every file is the package's own bytes except where its entry names `calls` (a real person's name, address or home path made generic) or an adaptation (`identity_at_move`: relative imports name their file extension, `vitest` reads the shim, a package's own files import each other at their new place). 8 files moved. Files that import the shared ui parts, the screen runtime or `useBitfieldData` run in the app, not in this tree's test command; their data layer is held until it is swapped to the records door.

Tests that do not run in this tree are renamed `.held` (2); the receipt's `held` key says why for each. Every moved feature file has a port contract in `ports/from-bitfield-packages-*.json`.

## Split (W3.3)

The work-record part is a recipe now: `workflow:keep-operation-work-records` (`tools/workflows/recipes/keep-operation-work-records.json`), proven on PostgreSQL and a JSON folder. The projection, decoding and source-linked review stay here as values-in, values-out code.

Still here, to retire in a later commit: `read-data/operation-work-store.ts` (`createEngineAtomicOperationWorkStore`, the client of the retired Bitfield runtime, used by `tools/run-experiments/packages/choose-per-observer/write-data/observe-saved-work-result-target.ts`) and `do-work/invoke-operation-transition.ts` (sends through the retired `#workspace-records` sender, imported by `tools/chat/show/ChatView.tsx` and `tools/messages-screen/packages/chat/show/ChatView.tsx`). Their callers must take the store or the action owner as a value first; that repoint is in the owners of those screens.
