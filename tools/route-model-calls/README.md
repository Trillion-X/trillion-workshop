# tools/route-model-calls/

Which model route each kind of call takes (its reader src/model-routes.mjs is held).

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Moved from old trillion main (5dc302be)

Byte for byte under their old paths, only import paths changed; `moved-from.json` names each.

| Old path | Here | Status |
|---|---|---|
| `src/model-waits.mjs` | `src/model-waits.mjs` | loads here |
| `test/model-waits-continuation.test.mjs` | `test/model-waits-continuation.test.mjs` | runs here: 6/6 pass |
