# tools/show-the-media-library-and-search-what-was/from-old-trillion/

Files of old trillion whose job is this tool's (show the media library and search what was said or seen in recordings, and change the next-edit suggestion). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `test/work-media-session.test.mjs` | `test/work-media-session.test.mjs.held` | held: ERR_MODULE_NOT_FOUND |
| `test/work-media.test.mjs` | `test/work-media.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/media-run-seam-for-tests.mjs (at the tag, not moved here yet) |
| `src/media-next-edit.json` | `src/media-next-edit.json` | data, read by its module (from 5dc302be) |
| `src/media-next-edit.mjs` | `src/media-next-edit.mjs` | loads here (from 5dc302be) |
| `src/media-search.json` | `src/media-search.json` | data, read by its module (from 5dc302be) |

`src/work-media.mjs` is wired: it is `do-work/answer-the-media-page.mjs` (ported, `ports/answer-the-media-page.json`).
