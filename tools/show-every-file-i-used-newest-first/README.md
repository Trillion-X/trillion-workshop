# tools/show-every-file-i-used-newest-first/

Show every file I used, newest first, whether I opened, watched, edited or published it, and let any screen or AI record a use.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Screens

The screen of this tool's list of file uses.

| File | Purpose |
|------|---------|
| `web/src/workspace/recent-screen.tsx` | The Recent screen (`tool:recent-files`): every file the person used, newest first and split by day, each with its picture, what happened last and when. Moved byte for byte from the web client (`moved-from.json`); it imports the web shell's files as it was written, and the client build answers those imports with the shell's files. |
| `show/recent-mount.tsx` | The screen's module entry, the file its row names: `mount` is the screen's own mount function. |

## Removed: the uses list and its store (lane w33-3b)

The store half of `src/recent-files.mjs` is deleted: its work is the recipe `workflow:show-every-file-i-used-newest-first` (landed by lane w33-3, commit 2efc4a6c9). The shipped numbers and words stay in `src/recent-files.json`. The old copy lives in the old tree at `src/recent-files.mjs` (commit b6ae0ebf8).

| What the removed code did | Where it lives now |
|------|---------|
| `recentFilesStore.record`: keeps one use per file and word with the newest time; refuses a word that does not match `kind_pattern` | the recipe's keep step (the store refuses by its own rule); the "is this a file the person keeps" check is the caller's file lookup |
| `recentFilesStore.recent`: newest-first page by a time cursor, each row with name, title, last word and each word's newest time | the recipe's read step |
| `trim`: keeps at most `keep` files, the one used longest ago leaves first | the recipe's keep step; the number is `keep` in `src/recent-files.json` |
| `shaped`, `useWords`, `baseName`: a row's name, title and words | the recipe's read step (words as the recipe's list answer gives them) |
