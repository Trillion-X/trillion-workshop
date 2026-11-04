# tools/browse-and-publish-what-my-ai-can-use

The Marketplace shelf: everything a person's AI can use, theirs and everyone's (tools, workflows, studied screens, design components, looks, layouts, configurations), read the same way for every kind. The screen and its routes (reading each kind from the person's store and the shared shelf, paging, searching, publishing and withdrawing) are the hosted app's; this folder holds the kinds DATA and the shelf reading that runs anywhere.

## Files

| File | Purpose |
|------|---------|
| `marketplace-kinds.json` | DATA: each kind, where its rows come from, which paths of a row fill each shelf fact, who-made-it words, what is the person's own, the verbs and badges |
| `do-work/shelf-item.mjs` | Moved from Trillion `src/work-marketplace.mjs` lines 45-147 (`moved-from.json`, `ports/shelf-item.json`): `firstOf`, `shelfItem` |
| `do-work/tool-title.mjs` | Moved from Trillion `src/work-workshop.mjs` lines 74-88 (`ports/tool-title.json`): `titleOf`, what a tool is called for a person |
| `do-work/read-a-shelf.mjs` | `readAShelf({ kind, rows, published })`: rows of one kind as shelf items (what `tool-rows.json` runs) |
| `moved-from.json` | Where the two moved parts came from, their line ranges and the identity of their source bytes |
| `ports/` | The port contracts of the three do-work files |
| `tool-rows.json` | The row `tool:read-rows-as-marketplace-shelf-items` |
