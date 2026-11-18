# tools/keep-a-search-that-found-no-tool/

Keep a search that found no tool as a dead end with how often it was asked, so the person sees what their own tools do not cover yet.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion still holds its own copies at that commit until a lane there deletes them. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## Files

| File | Purpose |
|------|---------|
| `src/dead-end-search.mjs` | `deadEndJob(sent, reply)` (values in, values out: the job to keep, or empty) and `deadEndName(job)` (the record name, `choice:tool:dead:` and the BLAKE3 identity of the job). The counting, the refresh window and the sweep are in `workflow:keep-a-search-that-found-no-tool`. |
| `src/dead-end-search.json` | The name family, the shortest job kept, the cut, ignored jobs and the words. |
| `test/dead-end-search.test.mjs` | Written here: the old code had no test of it. Tests the rule only; the record is proven on the store by the workflow. |

## Dependencies

**Depends on:** `@noble/hashes` (BLAKE3). The record's 30-day keep and 24-hour refresh are those of `workflow:remember-which-tool-was-chosen-for-a-job` (`tools/workflows/recipes/remember-which-tool-was-chosen-for-a-job.json`), which share one sweep.

## Where each removed function lives now

| Removed (`deadEndSearches`) | Now |
|---|---|
| `missed(sent, reply)`: count a job, refresh window, write | `workflow:keep-a-search-that-found-no-tool`, operation `missed`, keep step |
| `list()`: every dead end, newest first | the same workflow, operation `list` |
| the sweep of old dead ends | the same workflow, operation `sweep` (the choice keep's sweep) |
| `store` and `keep` arguments | the person's own store, named in the workflow's input |

Proof: lane w33-5, two stores (SQLite and PostgreSQL) with the same answers.
