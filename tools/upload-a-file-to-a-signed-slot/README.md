# tools/upload-a-file-to-a-signed-slot/

Uploads one file from a folder the person granted to a signed storage slot a hosted page hands over (an https address and the form fields the storage service signed), only when the slot as a whole fits a destination row of `read-data/guarded-upload.json`. A page cannot send a local file anywhere itself (the browser's cross-origin rules forbid it), so it asks this tool; the tool checks the slot before a byte leaves, reads the file the page never sees, and answers only its size. It runs on the person's own computer as a `computer` row: it reads through the `read-a-folder` capability the person grants, and reaches the slot host through the row's declared network (`"internet": true`, the engine's public-only egress).

Moved one to one from Trillion-X/trillion `computer/guarded-upload.mjs` and `computer/guarded-upload.json` (dc79bb0a87^, deleted in dc79bb0a87 with the Mac host that called it), with `test/guarded-upload.test.mjs`. The Mac host wiring was dropped; `uploadFromFolder` is the one thing added, the Workshop entry that reads the file from the granted folder.

## Files

| File | Purpose |
|------|---------|
| `read-data/guarded-upload.mjs` | `checkSlot`, `makeGuardedUploads` (moved as they were) and `uploadFromFolder`, the entry `tool-rows.json` runs. |
| `read-data/guarded-upload.json` | The destination rows (`host`, `path_prefix`, `max_fields`, `content_types`), `hold_minutes`, `max_hold_bytes` and every word said. The shipped list is empty, so the tool uploads nowhere until a destination row is added. |
| `tool-rows.json` | `tool:upload-a-file-to-a-signed-slot`: a `computer` row with `capabilities: ["read-a-folder"]` and `"internet": true`, run by `tools/records-door`'s `run-an-export.mjs`; stdin is `{ input, folder }`, the folder filled from `grants.read-a-folder.folder`. |
| `part.json` | Nothing here is imported by other code. |
| `test/guarded-upload.test.mjs` | The moved tests (import repointed) and the Workshop entry's tests, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `checkSlot` | `(slot, contentType, settings?) => { row, url }` | The destination row a slot is allowed by, or a refusal in words: https, host equal to a row's, path inside the row's folder, no query, fragment, credentials or port, text-only fields within the field cap, a content type the row lists. |
| `makeGuardedUploads` | `({ settings?, fetchImpl?, now? }) => { prepare, send }` | `prepare` holds a file once for `hold_minutes` and answers `{ id, size }`; `send` checks the slot and posts the form fields, then the file, once. A refused slot does not use the file up; a storage refusal is `retry: true`. |
| `uploadFromFolder` | `({ input: { file, content_type, slot }, folder }, { settings?, fetchImpl? }?) => { sent, size, said }` | Reads `file` only inside the granted `folder` (a name with `..`, an absolute path or a link out of the folder names nothing), refuses one over `max_hold_bytes` before reading it, checks the slot, then holds and sends it. |

## Invariants

- No host or bucket is named in code; destinations are DATA, and this public repository ships none.
- The signed fields are never logged and never in an answer or an error message.
- The file's bytes never reach the page; it learns the size.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library and its `fetch`.

**Depended on by:** `tool-rows.json`. The engine (Trillion-X/trillion-rust `src/runtime/workshop.rs`, kind `computer`) runs the row after the person grants `read-a-folder` to this tool.
