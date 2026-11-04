# tools/turn-a-finished-decision-into-an-anonymous-public/from-old-trillion/

Files of old trillion whose job is this tool's (turn a finished decision into an anonymous public story of what was weighed, what was chosen and how it turned out, and keep or take it down). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/stories.mjs` | `src/stories.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/story-settings.json (at the tag, not moved here yet), src/private-rewrite.mjs (at the tag, not moved here yet), src/answer-words.mjs (at the tag, not moved here yet) |
| `test/stories.test.mjs` | `test/stories.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/private-rewrite.mjs (at the tag, not moved here yet), src/story-pages.mjs (at the tag, not moved here yet), src/local-store.mjs (at the tag, not moved here yet), src/story-shelf.mjs (at the tag, not moved here yet) and 1 more |
