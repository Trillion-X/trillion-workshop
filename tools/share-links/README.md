# tools/share-links/

Files more than one moved group imports, kept once.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `web/src/link-page-screen.mjs` | The Link in bio screen's facts (`linkPageFacts`: the page on or off, its address for each place, the person's own links, the posts it lists, what people opened by item and by place) and `screenChange`, which turns its buttons into the owner's changes. Moved byte for byte from the web client (`moved-from.json`). |
| `web/src/link-page.json` | The screen's words and the page's settings, as DATA. |
| `web/test/link-page.test.mjs` | The screen against the owner's two read answers: facts, buttons and refusals. |
| `web/test/catalogue-screen-link-page.test.mjs` | The catalogue screen's facts: ids for each row, places most-opened first, nothing counted until someone came. |
| `moved-from.json` | The receipt of the move: each moved file's source path and commit and the identity of its bytes there and here. |
