# tools/remember-which-tool-was-chosen-for-a-job/

Pool a content-free set for a tool choice (how many tools were offered for a job and which position was run), only while the account shares what it decides.

The record half of this folder moved to the workflow recipe `workflow:remember-which-tool-was-chosen-for-a-job` (`tools/workflows/recipes/remember-which-tool-was-chosen-for-a-job.json`, kit beside it). The choices an AI was offered and the one it ran are the person's own rows in the person's own store, and the store keeps and sweeps them (rule a-tool-is-only-what-the-store-cannot-do). What stays here reaches outside the store, so it stays a tool: it turns a choice into the pool row and hands that back, and the caller decides whether to send it.

Old copies: `src/tool-choices.mjs`, `src/tool-choice-keep.mjs` and `src/tool-choice-keep.json` (their keep rules are the recipe's 30 days, 24-hour refresh and sweep) were deleted here. The source tree still holds its own copies at commit 3d4b99409f8fff2ca0558111018f409dce6c1df9 until a lane there deletes them.

## Files

| File | Purpose |
|------|---------|
| `src/pooled-choice-set.mjs` | `pooledChoiceSet({ shares, candidate_count, chosen_index })`: the content-free pool row (source, method, a random choice_key, candidate_count, chosen_index), or `null` when the account does not share. Values in, values out. |
| `test/pooled-choice-set.test.mjs` | The row keeps only its five fields; no sharing gives `null`; each row gets its own key. |

## Dependencies

**Depends on:** `@noble/hashes` (the random key's hex form).
