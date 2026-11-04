# tools/hand-off-jobs-between-agents/

Files more than one moved group imports, kept once.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Moved from old trillion main (5dc302be)

Byte for byte under their old paths, only import paths changed; `moved-from.json` names each.

| Old path | Here | Status |
|---|---|---|
| `src/close-many.json` | `src/close-many.json` | data, read by its module |
| `src/close-many.mjs` | `src/close-many.mjs` | loads here |
| `src/lapsed-asks.json` | `src/lapsed-asks.json` | data, read by its module |
| `src/lapsed-asks.mjs` | `src/lapsed-asks.mjs` | loads here |
