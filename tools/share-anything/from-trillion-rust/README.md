# tools/share-anything/from-trillion-rust/

The engine's sharing-grant code, moved here byte for byte (one made-up address in a test aside, named under `calls` in the receipt) from trillion-rust (`src/account_rights/share_grant.rs`, `share_grant/reach.rs`, `share_given.rs`, `share_given/tests.rs`, `share-grant.json` and `share-given.json`), where it lived until the engine was cut down to its five jobs (the owner, Nov 15 2026: "anything that is not one of the five core jobs is a tool and leaves the engine"; `account_rights` keeps `run_capability`, `resource_authority` and `auth_pass`). It is not wired: this tool writes the `sharing:<label>` record whose `reach` the engine's reader read on every read. Adapting a file into this tool is a later commit that names the receipt.

The run grant (`Act`: a share that lets named people run some of the sharer's tools at the sharer's door) has gone back to the engine: trillion-rust `src/account_rights/share_grant.rs` and its `share-grant.json` `act`, where the engine reads it from the sharer's vault alone; the share-anything tool makes, stops and lists it through the engine's `sharing.keep` and `sharing.list`. Each file's `returned` field in the receipt says which lines went back.

`moved-from.json` names each file's source path and commit, the identity of its source bytes and of its bytes here. Paths under `src/` keep the engine's own layout, so each `.rs` file still finds its `.json` beside it.

| File | Job |
|------|-----|
| `src/account_rights/share_grant.rs` | The giving side: a sharer's grant to read one of their records, honored on their own account routes, by the BLAKE3 of a bearer |
| `src/account_rights/share_grant/reach.rs` | The reach shape: a key-free, read-only share of a mixed collection of typed records |
| `src/account_rights/share-grant.json` | The giving side's DATA, including `door_grant.reach` |
| `src/account_rights/share_given.rs` | The receiving side: which shares a person was given, read at the sharer's door |
| `src/account_rights/share-given.json` | Its DATA |
| `src/account_rights/share_given/tests.rs` | The tests of what a person has been given |
