# tools/outside-conversations/

## Moved from bitfield-packages (byte for byte, not yet wired to a tool row)

The Talk to people and companies screen and the generic record work graph (a record, its actions and transitions) with the request that moves an outside conversation. Original of bitfield-packages `outside-conversations`.

`moved-from.json` names each moved file, its source path, the full source commit and both identities; every file is the package's own bytes except where its entry names `calls` (a real person's name, address or home path made generic) or an adaptation (`identity_at_move`: relative imports name their file extension, `vitest` reads the shim, a package's own files import each other at their new place). 9 files moved. Files that import the shared ui parts, the screen runtime or `useBitfieldData` run in the app, not in this tree's test command; their data layer is held until it is swapped to the records door.

Tests that do not run in this tree are renamed `.held` (1); the receipt's `held` key says why for each. Every moved feature file has a port contract in `ports/from-bitfield-packages-*.json`.
