# tools/find-pictures-by-colour-and-likeness/

Finding pictures by colour and by likeness from the facts a picture carries: its palette (a list of #rrggbb) and, when an encoder made one, its embedding. Colour is compared in CIE-LAB (delta-E 1976), never RGB: a typed hex under a 22 delta-E ceiling over the whole palette, a colour word under 16 over the top three vibrant swatches. A palette is the picture's leading colours plus a diverse top-up from its pixel histogram, and two near-identical colours never both take a slot. "More like this" ranks by embedding cosine (floor 0.30) and never goes silent: no usable embedding, too few pictures or nothing over the floor falls back to palette distance, a deterministic non-AI signal. Thresholds, sizes and colour words are data (`src/colour-search.json`).

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`: `src/colour-search.mjs`, its settings `src/colour-search.json`, the cosine it uses `src/meaning.mjs`, the facts declaration its test reads (`src/workspace/file-facts.json`) and `test/colour-search.test.mjs` (`moved-from.json` names each file's source and both identities). The old copies stay until their callers move: `src/search.mjs` (colour search), and for `src/meaning.mjs` the pool, network and scorer modules that also compare embeddings.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:find-pictures-by-colour-and-likeness` | Ids of the pictures matching a typed or named colour, or like one picture (by embedding, else palette) | in a small container, no internet |

## Files

| File | Purpose |
|------|---------|
| `src/colour-search.mjs` | `rgbOf`, `hexOf`, `labOf`, `deltaE`, `paletteOf`, `matchColour`, `matchNamedColour`, `similarTo`, `coloursIn`. |
| `src/colour-search.json` | Ceilings, palette sizes, the similar-item floor and limits, colour words. |
| `src/meaning.mjs` | `cosine`. |
| `src/workspace/file-facts.json` | The picture facts declaration the original test checks names `palette`. |
| `do-work/find-pictures.mjs` | The row's run: one of question, colour or like. |
| `test/colour-search.test.mjs` | The original test. |
| `test/find-pictures.test.mjs` | The row's run and its refusals. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each moved file came from and its identities. |
| `part.json` | Public files. |
