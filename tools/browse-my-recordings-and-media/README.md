# tools/browse-my-recordings-and-media

The Media section's rows: every recording the person's library knows and every video, sound or picture file their tools made or they saved, each with what has been worked out about it (title, length, how many edits use it, how many words are said in it, the facts kept about the file). `media-library.mjs`, moved from old trillion's `src/media-library.mjs`.

## Files

| File | Purpose |
|------|---------|
| `media-library.mjs` | `mediaLibraryPage(sql, options)`: one recent-first page; `mediaLibrary` (the whole library) and `mediaLibraryRecent` |
| `media-library.json` | Which result kind makes a recording row, which kinds and fields join onto a row, which folders hold made and saved media |
| `media-name-index.mjs`, `media-recording-index.mjs` | The seek indexes a page reads its candidates through |
| `do-work/list-my-media.mjs` | `listMyMedia({ files, results?, set_aside?, page? })`: a page over files and results handed in, in an in-memory SQLite store (what `tool-rows.json` runs) |
| `moved-from.json` | Where `media-library.json` and the two index files came from, with the identity of their bytes |
| `tool-rows.json` | The row `tool:list-my-recordings-and-media`, with a sample of a recording, a made video, a note and a deleted photo |

`media-library.json`, `media-name-index.mjs` and `media-recording-index.mjs` came in byte for byte from old trillion's `src/` at b6ae0ebf815f (4ffa1dc4a2^). `media-library.mjs`'s other imports are not copied here: the row packs `namespace-set-aside.mjs`, `file-type.mjs`, `workspace/file-previews.json` and the namespace store from `tools/recently-deleted-and-storage`, and `table-generation.mjs` from `tools/keep-and-wake-ai-sessions-on-this-computer/src`, beside this folder's files in the run (`/opt/src`).

## The row

`tool:list-my-recordings-and-media` names the files in the namespace with `namespaceStore`'s `putNames`, lays the results in a `namespace_results` table made by the statement old trillion's `src/namespace-results.mjs:200` used, and reads one page with `mediaLibraryPage`. That module itself is not here, since it also keeps the search feed, which a Media page does not read. No bytes are held, so every row says `stored: false`. Nothing is kept after the run, no file is written and nothing is sent; playing a row, suggesting the next edit and searching for a moment stay with the screen.
