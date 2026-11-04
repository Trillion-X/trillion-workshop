# tools/show-the-posts-and-the-posting-calendar-on-the-signed-in-page/from-old-trillion/

Files of old trillion whose job is this tool's (show the posts and the posting calendar on the signed-in page, the same posts their AIs list and change). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/work-posts.mjs` | `src/work-posts.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/activity.mjs (already gone at the tag), src/typed-on-signed-in-screen.mjs (at the tag, not moved here yet) |
| `test/work-posts.test.mjs` | `test/work-posts.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/activity.mjs (already gone at the tag), src/local-store.mjs (at the tag, not moved here yet), src/social-posts.json (at the tag, not moved here yet) |
