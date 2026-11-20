# tools/edit-text-and-code/

Changes one exact piece of text in a text or code file, so a person's AI can edit a line in a large file without sending the whole file, or several pieces across files in one all-or-nothing step. Ported from the `replace-exact-text` command of the old `file-editor` package; the editor screen that package also held (a code editor with find-and-replace, drawn in the browser) is here too, as moved files (see "The editor screen, moved from the package").

## Files

| File | Purpose |
|------|---------|
| `do-work/replace-exact-text.mjs` | `tool:replace-one-piece-of-text-in-a-file`: the granted folder in argv, `{ file, find, replace }` on standard input, `{ result }` or `{ error }` on the last line. `replaceExactlyOnce` is the pure part; `replaceInFile` adds the folder custody and the atomic write. Changed from the package: the fragment arrives as JSON text (the base64 and file forms existed only because the old command read argv), a trailing newline is part of the fragment, the file must be inside the granted folder, a link anywhere on the path is refused, the permission bits are kept, binary files are refused, and a change made to the file while the edit is prepared stops the write. |
| `do-work/replace-exact-text.mjs` (several) | `tool:replace-several-pieces-of-text-in-files`: `{ edits: [{ file, find, replace }, ...] }` (or a bare list) on standard input, or in a JSON file named after the folder (`node do-work/replace-exact-text.mjs <folder> edits.json`). The edits apply in order, a later one seeing what an earlier one made in the same file; if any is refused, no file is written and the refusal names the edit by its place. Every changed file is staged before any is put in place. Folded in from the film repo's `apply_edit.py`, whose `{file, old, new}` is `{file, find, replace}` here and whose files were relative to that repo; here they are relative to the granted folder. |
| `part.json` | `do-work/replace-exact-text.mjs` is public, so another tool may import `replaceExactlyOnce`. |
| `tool-rows.json` | The two rows. It runs on the person's computer with the `change-a-folder` grant and no internet. |
| `test/replace-exact-text.test.mjs` | The module and the command run as the engine runs it, on a made-up bakery menu: one match changes, none or several change nothing, text is compared as written, permissions kept, and paths that leave the folder, links, folders, missing files and binary bytes are refused; several edits from a file or standard input apply in order, and one refusal writes nothing. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `replaceExactlyOnce` | `(text, find, replaceWith) -> text` | Exactly one occurrence, byte for byte; otherwise throws a `Refusal` that says what to change in the request. |
| `fileInsideFolder` | `(folder, file) -> { target, inside }` | The file's path under the granted folder, with every part a plain directory or the regular file. |
| `replaceInFiles` | `(folder, edits) -> { files: [{ file, bytes_before, bytes_after, replaced }], replaced }` | Several edits, in order, all or nothing. |
| `replaceInFile` | `(folder, { file, find, replace }) -> { file, bytes_before, bytes_after, replaced }` | The whole edit: read, replace, write beside the file, then rename over it. |

## The editor screen, moved from the package

The CodeMirror editor screen and its helpers are here, byte for byte from the package at its last commit (`from-bitfield-packages/moved-from.json` is the receipt). Only `do-work/replace-exact-text.mjs` was not copied: this folder holds the ported, stricter form.

| File | Purpose |
|------|---------|
| `show/FileEditor.tsx` | The editor: CodeMirror with the language picked from the file, its theme, and `@codemirror/search` find-in-file (`search({ top: true })`, the search keymap, the "Find in file" header control). |
| `show/FileEditorSearchPanel.tsx`, `show/create-file-editor-search-panel.ts` | The find panel, styled through the editor theme so CodeMirror keeps the query, regex and match state. |
| `show/AskAiToEditSelectedFileText.tsx` | Ask an AI to change the selected text. |
| `show/mount-file-editor.tsx` | Mounts the screen as the File Editor surface. |
| `do-work/write-file-editor-text-file.ts`, `do-work/ask-file-editor-language.ts` | Write the edited text back to the file; ask which language a file is. |
| `do-work/write-selected-text-for-next-agent-request.ts`, `do-work/use-write-selected-text-for-next-agent-request.ts` | Hand the selected text to the next AI request. |
| `read-data/read-file-editor-text-file.ts`, `read-data/read-selected-file-path.ts` | Read the file's text and the selected path. |
| `things-to-store-and-run.json`, `show/README.md` | The package's boundary file (the surface, the selected-file input, the entry) kept as data, and the package's note for `show/`. |

The screen's data layer (`@bitfield/runtime-kit` and its React hooks, and `@bitfield/runtime-kit/protocol` in the process helpers) and `tools/ui` (the shared parts live in the apps repository) are not in this tree; the imports stay as written, so the screen does not load here and no tool row opens it yet. The package has no tests for these files.

## Dependencies

**Depends on:** nothing (Node's own modules).

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) for its owner, with nothing more to allow (installing it or switching its job on is the one yes); the folder it works on is named in its run input at `computer.change-a-folder`.
