# tools/set-storage-release-rules/

The rules a person sets for when stored bytes are released.

Moved here byte for byte from Trillion-X/trillion by `tools/move-code-between-trees`; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Trillion-X/trillion imports these files from this package. The folder keeps the source tree's own paths under it, so the files import each other as they did.

## What runs now

| What a person or their AI does | Where |
|---|---|
| Change the rules (replace the list, each row checked) | `tool:set-release-rules`, `do-work/release-rules-setting.mjs` over `setting:release_rules` (`storage-release-live.json`) |
| Say what leaves now and when every other item leaves, for the items their AI read | `tool:plan-storage-release`, `do-work/release-by-rules.mjs` `planStorageRelease` over the same setting, by `src/namespace-release-rules.mjs` (unchanged from the older repository) and the formula engine |
| Read storage from the files door (kept, waiting, leaving per day, each item with its rule or keep-for, what was given back, the rules) | `readStorage` in `do-work/release-by-rules.mjs` |
| Release now (forget for good what the rules say, give the bytes back in the same run; `dry_run`) | `releaseDeletedFiles` in the same file, over `forgetSetAsideNow` of `tools/recently-deleted-and-storage` and the engine's `queue_release` and `release_gone_bytes` |

The last two are written and tested over a stand-in of the engine's files door (`test/release-by-rules.test.mjs`, 8 tests), but have no tool row: a run's door answers records only (`tools/records-door/read-data/values-door.mjs` refuses every other files operation as `door_does_not_grant`), the same wait as the Recently Deleted actions (`tools/recently-deleted-and-storage/README.md`). Until a door carries the effect, a person's AI reads the items and the bytes through the files tool, asks `tool:plan-storage-release`, and forgets and releases with the files tool's `forget_set_aside`, `queue_release` and `release_gone_bytes`. No daily pass is armed here: the engine drops it on purpose (`tools/live-namespace/src/account_files/release.rs` header), so a person's own schedule or rule runs the release.

`records/old-storage-release-tool-descriptors.json` is the old tool descriptors (`tool:read-storage`, `tool:set-release-rules`, `tool:release-deleted-files`) at the older repository's `5dc302be37`, kept as the reference the tests read.
