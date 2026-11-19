# tools/browse-the-recordings-in-my-media-library-in-a-stable-order/

Cut suggestions for one recording, as values.

`src/media-tools.mjs` now holds one function, `suggestMediaCuts({ identity, mode, transcript, kept })`. The recording's words
(with word times) and the cut suggestions already kept for it come in; the answer is the suggestion's lines and proposals, and
`keep`: the entries the caller keeps. A later ask with the same mode and words answers from the kept entry, marked cached.

The store half is `workflow:keep-cut-suggestions-for-a-recording` (`tools/workflows/recipes/keep-cut-suggestions-for-a-recording.json`
and its kit). It reads the words and the kept entries from the person's own store, calls `suggestMediaCuts`, and keeps each new entry.

## Moved out (rule a-tool-is-only-what-the-store-cannot-do)

| Old part | Now |
|---|---|
| `list_media` (a recent-first page of the Media library through the `/media/library` route) | the Media page is read by `tools/browse-my-recordings-and-media` (values over the files and results handed in); the route belongs to its own owner |
| `next_media_edit` (the next edit suggestion read through the media owner) | removed here: its owner reads it |
| `mediaTools` (the MCP wrappers that read and merged through `call`) | removed: the recipe is the store path |
| `mediaAnnotations` | removed with the wrappers |

`src/media-tools.mjs` is no longer the bytes listed in `moved-from.json`: its cut function is the change the receipt does not
describe. The proof is in the lane: the old `suggest_media_cuts` (run with a call that serves the words and records each merge)
against the values function in PostgreSQL (PGlite) and a JSON folder: the lines, proposals, cached flags and kept entries are equal.
