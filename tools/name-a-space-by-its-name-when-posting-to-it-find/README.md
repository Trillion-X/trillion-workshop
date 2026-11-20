# tools/name-a-space-by-its-name-when-posting-to-it-find/

Name a space by its name when posting to it, find items in it by their words and pick things of mine to share into it.

This folder has no row yet. Two pure modules are in `do-work/`, not wired into any tool row, waiting for the owner's word:
- `do-work/resolve-a-space-name.mjs` turns a space's name into its id (exact title, else title contains; one match only; refusals name each space and its id). Settings words are passed in by the caller.
- `do-work/search-a-spaces-posts.mjs` finds one space's posts by their words, as the reader sees them (every word, newest first, `next_before` paging, bounded scan), with limits in `do-work/search-a-spaces-posts.json`. Not carried from the old search: withdrawn, hidden and kind rules, since current posts have no such fields.

Its files from the older Workshop copy are in `from-an-older-version/`: the bytes of the tag made before the Worker retired, under their old paths. `from-an-older-version/README.md` says which load here and which are held until what they import is here. Wiring them into a row is adapting them, in a commit that names `moved-from.json`.
