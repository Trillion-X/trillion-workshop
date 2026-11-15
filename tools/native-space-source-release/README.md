# tools/native-space-source-release/

Src/native-space-source-release.json at the tag.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `scripts/workspace-source-record.mjs` | What the web client was built from: the commit and repository a workspace build records beside its inputs, and the refusal of a source nobody recorded. Imported by trillion-apps `scripts/native-frontend-wrapper.mjs` and `macos/carry-local-runtime.mjs`. Moved byte for byte from `web/scripts/`. |
