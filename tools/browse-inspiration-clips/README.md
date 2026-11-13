# tools/browse-inspiration-clips

Inspiration: everything worth making from, as named rows of cards (the next pick, recordings no edit has used, files used lately, formats, saved examples, prepared posts, finished videos, fresh recordings). Moved from Trillion-X/trillion `src/inspiration.mjs` (a9ee258, #76); its DATA and the shared card-sections reader came byte for byte from the old tree (`moved-from.json`).

## Files

| File | Purpose |
|------|---------|
| `inspiration.mjs` | `inspiration(read)`, unchanged from the old tree |
| `inspiration.json` | The rows, sources, card fields, layouts and card actions (from old trillion `src/inspiration.json`) |
| `card-sections.mjs` | The shared reader: each source read once, each row's tests, items into cards (from old trillion `src/card-sections.mjs`) |
| `browse-inspiration.mjs` | `browseInspiration({ sources })`: the rows of cards over the source answers handed in, as one run (what `tool-rows.json` runs) |
| `moved-from.json` | Where each brought-in file came from, and both identities |
| `tool-rows.json` | The row `tool:sort-inspiration-clips-into-card-rows`, with a sample run over a made-up clip and format |
| `web/src/workspace/inspiration-screen.tsx` | The Inspiration screen (`tool:inspiration`): the rows this tool answers, drawn by the shared card layouts as named rows, a shuffled wall or a grid, with the actions each card offers. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/inspiration-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |
| `README.md` | This file |

## The row

`tool:sort-inspiration-clips-into-card-rows` runs `browse-inspiration.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads only what it is given and writes nothing. Drawing the rows, wall or grid, opening a card and starting a new edit (Make this, Edit these) stay with the app's Inspiration screen.
