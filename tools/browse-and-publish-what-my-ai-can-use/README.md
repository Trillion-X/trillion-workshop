# tools/browse-and-publish-what-my-ai-can-use

The Marketplace shelf: everything a person's AI can use, theirs and everyone's (tools, workflows, studied screens, design components, looks, layouts, toolkits; the toolkit kind keeps its id `configuration`, which rows already call, and reads the person's own `record:toolkit` list rows with `records:list`, so it needs no page route), read the same way for every kind. The screen and its routes (reading each kind from the person's store and the shared shelf, paging, searching, publishing and withdrawing) are the hosted app's; this folder holds the kinds DATA and the shelf reading that runs anywhere.

## Files

| File | Purpose |
|------|---------|
| `marketplace-kinds.json` | DATA: each kind, where its rows come from, which paths of a row fill each shelf fact, who-made-it words, what is the person's own, the verbs and badges |
| `do-work/shelf-item.mjs` | Moved from Trillion `src/work-marketplace.mjs` lines 45-147 (`moved-from.json`, `ports/shelf-item.json`): `firstOf`, `shelfItem` |
| `do-work/tool-title.mjs` | Moved from Trillion `src/work-workshop.mjs` lines 74-88 (`ports/tool-title.json`): `titleOf`, what a tool is called for a person |
| `do-work/read-a-shelf.mjs` | `readAShelf({ kind, rows, published })`: rows of one kind as shelf items (what `what-this-tool-does-and-how-to-run-it.json` runs) |
| `moved-from.json` | Where the two moved parts came from, their line ranges and the identity of their source bytes |
| `ports/` | The port contracts of the three do-work files |
| `test/make-shelf-tiles.test.mjs` | Tiles against a made-up icons folder: own icons, an alias, the kind icon, machine titles left out, the job cut, the page file, icon files read and never run |
| `what-this-tool-does-and-how-to-run-it.json` | The rows `tool:read-rows-as-marketplace-shelf-items` and `tool:make-marketplace-tiles-with-their-icons` (on the person's computer) |

## Screens

| File | Purpose |
|------|---------|
| `web/src/workspace/marketplace-screen.tsx` | The Marketplace screen (`tool:screen-marketplace`): one shelf of everything a person's AI can use, read through the kinds in `marketplace-kinds.json`. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/marketplace-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |

## Restored from bitfield-packages `marketplace`

The package was one boundary file, kept as written under `from-bitfield-packages-marketplace/things-to-store-and-run.json`: the `marketplace-templates` input descriptor (a table of id, name, description, category, trigger type, config and published flag), the publish-marketplace-templates action and its two triggers (on a data change, on the workspace loading), and the marketplace landing page records. It has no code; the shelf in this folder reads the kinds file instead, and the publish action ran on the retired workflow engine.

| File | Purpose |
|------|---------|
| `from-bitfield-packages-marketplace/things-to-store-and-run.json` | Data the package carried as written. |
| `from-bitfield-packages-marketplace/moved-from.json` | Source path and commit of each file, identities, call rows, held tests, files that still call the retired runtime. |
