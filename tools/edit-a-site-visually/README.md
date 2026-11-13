# tools/edit-a-site-visually/

Edit a site's pages in a visual editor and save the result back as the site's own page files.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

| File | Purpose |
|------|---------|
| `web/src/workspace/public-apps-screen.tsx` | The Sites screen (`tool:screen-public-apps`): edit an installed site, its versions, collaborators and visitor activity. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `web/src/workspace/public-app-assembly-panel.tsx` | The panel that assembles a site's project from checked sources; only the Sites screen mounts it. |
| `web/src/workspace/public-app-source-panel.tsx` | The panel that chooses a site's source and where it goes; only the Sites screen mounts it. |
| `show/public-apps-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
