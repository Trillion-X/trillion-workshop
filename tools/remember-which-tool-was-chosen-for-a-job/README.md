# tools/remember-which-tool-was-chosen-for-a-job/

Remember which tools were offered for a job and which one was run, as training pairs, and drop old choices after a set number of days.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion still holds its own copies at that commit until a lane there deletes them. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/tool-choices.mjs` | `toolChoices({ store, keep, keepsOffers, shares, pooled })`: the candidates find_tool_for_job offered for a job and the one a run chose, kept as the account's own training pairs; a content-free choice set is pooled only while the account shares what it decides. |
| `src/tool-choice-keep.mjs`, `src/tool-choice-keep.json` | `toolChoiceKeep({ eeaf, now })`: how long choices are kept (`keep_days`), when a kept choice is due to be written again, and the sweep that drops old ones. |
| `test/tool-choices.test.mjs` | Moved with them from Trillion-X/trillion `test/`. |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3).
