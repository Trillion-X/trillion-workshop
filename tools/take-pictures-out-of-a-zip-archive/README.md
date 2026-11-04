# tools/take-pictures-out-of-a-zip-archive/

The files inside a zip archive as bytes, `{ title, media_type, bytes }` for each entry an importer may take, so a folder of pictures is brought in the way a single picture is (through the importer's one pipeline), never unpacked to disk. An entry's name is never a path: it only gives a title. Only entries of an admitted extension are inflated; archive litter and folders never are. Entry count, one entry's bytes, all bytes and the expansion ratio are bounded, and an archive over a limit is refused whole, naming the limit. Which entries count and the limits are data (`src/archive-entries.json`, with named profiles such as `chat_export`).

Moved byte for byte from Trillion-X/trillion (commit b92aa549f2) by `tools/move-code-between-trees`: `src/archive-entries.mjs`, its rules `src/archive-entries.json` and the test `test/archive-entries.test.mjs` (`moved-from.json` names each file's source and both identities). The old copy stays until its caller, Trillion's chat import (`src/chat-import.mjs`), moves.

## Tools

| Tool | What it does | Runs |
|------|--------------|------|
| `tool:take-pictures-out-of-a-zip-archive` | The admitted entries of a base64 zip, in archive order, as titled base64 bytes | in a small container, no internet |

## Files

| File | Purpose |
|------|---------|
| `src/archive-entries.mjs` | `archiveEntries(zip, limits)`, `profile(name)`, `ArchiveRefused`. |
| `src/archive-entries.json` | Admitted extensions, litter patterns, limits and profiles. |
| `do-work/take-pictures-out.mjs` | The row's run: base64 in, base64 entries out, refusals in words. |
| `test/archive-entries.test.mjs` | The original test. |
| `test/take-pictures-out.test.mjs` | The row's run: litter, a traversal name, a limit and an unreadable archive. |
| `tool-rows.json` | The Workshop row. |
| `moved-from.json` | Where each moved file came from and its identities. |
| `part.json` | Public files. |
