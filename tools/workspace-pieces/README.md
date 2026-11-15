# tools/workspace-pieces/

Src/workspace-pieces.json at the tag.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `scripts/workshop-shell-imports.mjs` | An esbuild plugin: a Workshop tool a page bundles may still import a file that stayed with the web shell, found by the homes in `workshop-shell-homes.json`. Moved byte for byte from trillion-apps `web/scripts/`. |
| `scripts/workshop-shell-homes.json` | Its DATA: each Workshop file and the shell file it still reaches, with why. |
