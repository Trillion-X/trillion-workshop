# tools/gather-audience-questions/

Files more than one moved group imports, kept once.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

Moved byte for byte from the web client (`moved-from.json` names each file's source path, commit and identity); the client build opens each from this folder as a screen module and shares the web shell's files it imports with the page.

| File | Purpose |
|------|---------|
| `web/src/workspace/audience-questions-screen.tsx` | The screen: Audience questions review desk (`tool:screen-audience-questions`) |
| `show/audience-questions-mount.tsx` | Its mount entry: the one `mount(element, props)` export the row's `screen.module.entry` names |
