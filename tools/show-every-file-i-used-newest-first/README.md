# tools/show-every-file-i-used-newest-first/

Show every file I used, newest first, whether I opened, watched, edited or published it, and let any screen or AI record a use.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

The screen of this tool's list of file uses.

| File | Purpose |
|------|---------|
| `web/src/workspace/recent-screen.tsx` | The Recent screen (`tool:recent-files`): every file the person used, newest first and split by day, each with its picture, what happened last and when. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/recent-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
