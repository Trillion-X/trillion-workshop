# tools/check-deleted-code-names-its-home/

Refuses a commit or a push, in trillion, trillion-rust, trillion-workshop or trillion-apps, that deletes a source or test file without naming where it went or who decided it should go. Each deleted file must be named by a moved-from receipt (`moved-from.json`, as `tools/move-code-between-trees` writes it) in one of those checkouts, or covered by a row of the tree's `retired-paths.json` that quotes the decision (`decision: { by, words, source }`, or a `reason` that names the decision). "Nothing imports it" and "no row names it" are not decisions: they are a missing importer or a missing row, so they never pass.

Why (the owner, 2026-11-04 12:20 AM MST): "code that was written, much of it reverse-engineered over the past 2-3 weeks, was deleted from old trillion instead of being ported to its correct place, abandoned and covered up." From 2026-10-10 to 2026-11-04 old trillion lost 2,427 files that had no home in any new repository and no backlog row.

It runs from the person's Checks list: the row `record:check:deleted-code-names-its-home` (`read-data/check-row.json`, as their list holds it) names this judge in `workshop_run`, and their check list runner (`tools/check-every-tool-call`) runs it before each `git commit` and `git push`. No hook code: the row is the check.

## Files

| File | Purpose |
|------|---------|
| `do-work/check-deleted-code-names-its-home.mjs` | The judge: `judgeDeletions({ root, span, repository?, repositories?, rules? })`, and the same as a command (`--root`, then `--staged`, `--range <from>..<to>` or `--for-command <command>`). What a command publishes is read by `tools/check-a-port-against-its-source`'s `spanForCommand`, the one owner of that reading. A path's identity is `tools/content-identity`'s BLAKE3. Prints the refusal in words, then the JSON judgement on the last line; exit 0 passes, 1 refuses, 2 could not judge. `--granted <checkout>` is the tool row's run: `{ range, repository? }` on stdin, `{ result }` or `{ error }` out. |
| `read-data/rules.json` | DATA: the repositories whose receipts count, which deleted files are judged (source and test files; documents and data are not), where receipts and retirements are read, and every word the judge says. |
| `tool-rows.json` | `tool:check-deleted-code-names-its-home`: the same judge over a range of commits in a checkout the person grants, from any AI or screen that runs Workshop tools. |
| `read-data/check-row.json` | The check row, `record:check:deleted-code-names-its-home`, as the person's Checks list holds it. |
| `test/check-row.test.mjs` | That exact row run by the check list runner against a made-up door and made-up checkouts side by side: a deletion with no home refused in words; a receipt beside it by path or by path identity, a receipt staged in the same commit, a retirement that quotes its decision, a rename and a deleted document pass; a retirement with no decision, and a receipt from another repository, do not; a push is judged over the commits it publishes. |
| `ports/check-deleted-code-names-its-home.json` | The NO_PRIOR_OWNER claim and the search that found no owner. |
| `part.json` | The judge is public; the check list runner starts it. |

## Dependencies

**Depends on:** `tools/check-a-port-against-its-source` (`spanForCommand`), `tools/content-identity` (`makeHashCodeHexFromBytes`), git, Node.

**Depended on by:** the person's Checks list row `record:check:deleted-code-names-its-home`, run by `tools/check-every-tool-call`; the tool row `tool:check-deleted-code-names-its-home`.
