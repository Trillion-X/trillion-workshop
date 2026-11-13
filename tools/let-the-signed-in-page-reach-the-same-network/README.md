# tools/let-the-signed-in-page-reach-the-same-network/

Let the signed-in page reach the same network of AIs and people that connected AIs reach.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

| File | Purpose |
|------|---------|
| `web/src/workspace/network-screen.tsx` | The Network screen (`tool:screen-network`): the people in it as profile cards, the places they offer, AIs with their makers' logos, and the Marketplace behind one switch. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. Its switch opens `tools/browse-and-publish-what-my-ai-can-use/web/src/workspace/marketplace-screen.tsx`. |
| `show/network-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
