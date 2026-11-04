# tools/keep-a-search-that-found-no-tool/

Keep a search that found no tool as a dead end with how often it was asked, so I see what my Trillion does not cover yet.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion still holds its own copies at that commit until a lane there deletes them. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/dead-end-search.mjs` | `deadEndJob(sent, reply)` and `deadEndSearches({ store, keep, now })`: when find_tool_for_job answers with no candidate, the job is kept as one record per job (its BLAKE3 name under `choice:tool:dead:`), counted up and written at most once per refresh window; `list()` gives every dead end, newest first. `store` and `keep` come from the caller. |
| `src/dead-end-search.json` | The name family, the shortest job kept, the cut, ignored jobs and the words. |
| `test/dead-end-search.test.mjs` | Written here: old trillion had no test of it. |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3); the caller's `keep` is `tools/remember-which-tool-was-chosen-for-a-job`'s `toolChoiceKeep`.
