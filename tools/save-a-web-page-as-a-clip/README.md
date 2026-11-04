# tools/save-a-web-page-as-a-clip/

Save a web page as a clip with its address, title, text and a snapshot picture, and refresh it on a schedule I choose.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion still holds its own copies at that commit until a lane there deletes them. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/saved-pages.mjs` | `makeSavedPages({ files, run, now })`: save a page (read through the capture tool, kept as one JSON file and one index row, keyed by the BLAKE3 of its address), read one or the index, edit its title or refresh policy, refresh the pages that are due (a failed refresh keeps the last good text and records why) and remove one (set aside, not erased). `files` and `run` come from the caller; the module reads no store itself. REA finding F-0416. |
| `src/saved-pages.json` | Every folder, file name, limit, capture tool (`tool:read-a-page-in-my-browser`) and word the module uses. |
| `test/saved-pages.test.mjs` | The module against an in-memory files store and a made-up capture tool. Written here: old trillion had no test of it. |

## Not yet

No tool row lists it yet. A row needs the records door's `files` right for `files` and a tool call for `run`, the way the other door tools hand them in.

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3), Node.

**Depended on by:** nothing in this package yet.
