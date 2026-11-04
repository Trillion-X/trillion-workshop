# tools/keep-links-i-saved-elsewhere-such/

Keep links I saved elsewhere, such as a browser's pinned tabs and folders and a service's bookmarks, so every AI and screen can read them.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Tests

| File | Purpose |
|------|---------|
| `test/saved-pages-adoption.test.mjs` | Moved from Trillion-X/trillion `test/`. |
| `test/saved-pages.test.mjs` | `src/saved-pages.mjs` (REA finding F-0416) against an in-memory files store and a made-up capture tool: save, read, edit, refresh when due, a failed refresh that keeps the last good text, and removal. Written here: old trillion had no test of it. |
