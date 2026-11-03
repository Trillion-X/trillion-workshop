# tools/edit-text-and-code/

Changes one exact piece of text in a text or code file, so a person's AI can edit a line in a large file without sending the whole file, or several pieces across files in one all-or-nothing step. Ported from the `replace-exact-text` command of the old `file-editor` package; the editor screen that package also held (a code editor with find-and-replace, drawn in the browser) is a screen and lives with the screens, not here.

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

## Dependencies

**Depends on:** nothing (Node's own modules).

**Depended on by:** `tool-rows.json`. The local engine runs the rows on the person's computer (`computer` kind) after the person grants `change-a-folder`.
