# tools/choose-where-shares-from-the-phone-browser/

Choose where shares from the phone, browser and Android go, which AI action each site starts, and look back at what was shared before.

This folder has no row yet. Its old Trillion files are in `from-old-trillion/`: the bytes of tag `old-trillion-before-worker-retire`, under their old paths. `from-old-trillion/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.

## Screens

| File | Purpose |
|------|---------|
| `web/src/workspace/sharing-screen.tsx` | The Sharing screen (`tool:screen-sharing`): where a share from the iPhone, Chrome or Android can go, which AI action each site starts, and everything shared before. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/sharing-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
