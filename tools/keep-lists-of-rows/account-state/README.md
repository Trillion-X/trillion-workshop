# tools/keep-lists-of-rows/account-state/

The Rust code that keeps an account's rows and their stores: where the engine of Trillion held state until the engine was cut down to its five core jobs ("anything that is not one of the five core jobs is a tool and leaves the engine"; state is a tool). Old Trillion kept an account in many small stores, each with its own writer; this folder is the code that does the same in the engine's model, now under the tool that keeps lists of rows.

Moved here byte for byte from Trillion-X/trillion-rust; `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. Paths below this folder are the source's own, so `src/storage/mod.rs` is `src/storage/mod.rs` of the engine.

| Folder | What it keeps |
|--------|---------------|
| `src/storage/` | the stores: the record store and its resources (per-list homes among them), the SQLite and hosted-SQL stores, the old record tables, the families data |
| `src/local_account/` and `src/local_account.rs` | the account this computer holds: its own records and their writer and delivery, the command journal, live heads, enrolment, connection credentials |
| `src/local_workspace/` and `src/local_workspace.rs` | the workspace this computer holds: heads, personal reads, records, show rules, tool screens |
| `src/account/computers/` | the account's computers: placement, the copies between them, the sealed key check, the writer row |
| `src/legacy_records/`, `src/legacy_kept/` | the older record and kept-run reads: batches, current heads and indexes, ids, ranges, points and filters |
| `simulation/`, `examples/`, `ports/` | the simulation scenarios, the examples and the port contracts of the files above |

The account's data on disk is untouched by this move; no engine runs from here.

## Files the engine still holds that belong with these

Twins and neighbours that the move did not name, so they stay in Trillion-X/trillion-rust until the engine's own cut (src/lib.rs, Cargo.toml, build.rs and tests/) is made:

- `src/import.rs`, `src/legacy_kept.rs`, `src/legacy_records.rs`, `src/account/computers.rs` (the `.rs` twins of folders moved here)
- record parts: `src/record_canonical.rs`, `src/record_indexes*`, `src/record_log*`, `src/record_model_policy*`, `src/record_sealed*`, `src/record_source*`, `src/record_stamps.rs`, `src/record_value*`, `src/record_write_model*`, `src/records*`, `src/current_record_keys*`, `src/kept_runs.rs`
- account create, erase and rows: `src/account/create.rs`, `src/account/create.json`, `src/account/erase*`, `src/account/rows*`
- native entry: `src/native_entry/computer/account_create.rs`, `src/native_entry/module_computer/tests/rows.rs`, `src/native_entry/computer*` and `src/native_entry/parent_kept.rs`

The tool runner's ties to state (`store`, `ecma_json`, `record_model_policy`, `record_value`, `sqlite_work`) are cut by the engine's own lane, not here.
