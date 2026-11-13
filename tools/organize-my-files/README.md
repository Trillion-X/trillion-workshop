# tools/organize-my-files/

Files more than one moved group imports, kept once.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

The screen of this tool's suggestions.

| File | Purpose |
|------|---------|
| `web/src/workspace/file-tidy-screen.tsx` | The Tidy up screen (`tool:list-file-tidy`): the titles and folders the person's AI suggested, each with what it is based on, accepted or rejected one by one or several together, applied as one tidy-up and undone. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/file-tidy-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
