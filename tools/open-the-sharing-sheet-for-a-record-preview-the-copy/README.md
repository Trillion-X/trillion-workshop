# tools/open-the-sharing-sheet-for-a-record-preview-the-copy/

Open the sharing sheet for a record, preview the copy others would see with chosen fields left out, and change who can see it.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/work-sharing.mjs` | The sharing routes the signed-in page reaches, passed to the person's own store unchanged. |
| `web/src/workspace/shared-with-me-screen.tsx` | The Shared with me screen: what other people shared with this person one by one, newest first, each with its name, who it is from, its kind and when; opening one reads it from its owner at that moment and shows the copy beside the page. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/shared-with-me-mount.tsx` | The screen's module entry, the file its row (`tool:screen-shared-with-me`, in the web client's `records/workshop-screen-tool-records.json`) names: `mount` is the screen's own mount function. |
| `ports/shared-with-me-mount.json` | The reference-adaptation contract of that entry file. |
| `from-old-trillion/records/workshop-sharing-tool-records.json` | Old trillion's row, kept as it was. |
| `moved-from.json` | The receipt of the moves: each file's source path and commit, the identity of its bytes there and here, and the web shell files the screen keeps importing (`stays`). |

## Not here yet

`tool:shared-with-me` as a tool a person's AI runs (old trillion's row in `from-old-trillion/records/workshop-sharing-tool-records.json`, an account-action over `src/record-sharing.mjs` `sharedWithMe` and `readSharedWithMe`) has no live row: those read old trillion's offers network (`recordsOffered`, `openOffer`), the engine has no owner of it (the route map lists `/work/api/shared-with-me` as having none), and the engine's own receiving side of a share (`share-given:` records and `sharing.receive`) has no writer or reader a tool run can use yet.
