# tools/make-packages-match-their-source/

## Moved from bitfield-packages (byte for byte, not yet wired to a tool row)

Making a chosen package match its current source in a chosen installed app: the byte builders, the scope writer, the declared-path report and the package-delta writer, with their tests. Original of bitfield-packages `make-packages-match-their-source`.

`moved-from.json` names each moved file, its source path, the full source commit and both identities; every file is the package's own bytes except where its entry names `calls` (a real person's name, address or home path made generic) or an adaptation (`identity_at_move`: relative imports name their file extension, `vitest` reads the shim, a package's own files import each other at their new place). 66 files moved. Files that import the shared ui parts, the screen runtime or `useBitfieldData` run in the app, not in this tree's test command; their data layer is held until it is swapped to the records door.

Tests that do not run in this tree are renamed `.held` (18); the receipt's `held` key says why for each. Every moved feature file has a port contract in `ports/from-bitfield-packages-*.json`.
