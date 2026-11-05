# tools/show-every-file-i-used-newest-first/

Show every file I used, newest first, whether I opened, watched, edited or published it, and let any screen or AI record a use.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## The route tool

`tool:answer-the-recent-files-page` (`do-work/answer-the-recent-files-page.mjs`, `tool-rows.json`) answers the Recent
screen's route `GET` and `POST /recent-files` the way old trillion's `src/work-media.mjs` and `nativeRecentFiles` did. It
runs `src/recent-files.mjs` unchanged, on an in-memory SQLite built from the person's `recent-file-use` records, one
record per file and kind, and writes back only what changed. Files are found with the files door's `find_file`. The
engine runs it as a `@workshop-routes` tool. `test/answer-the-recent-files-page.test.mjs` ports the tag's
`test/recent-files-store.test.mjs`.
