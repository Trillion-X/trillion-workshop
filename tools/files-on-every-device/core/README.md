# core/ (crate `files-core`)

Every rule a native folder of the person's files needs, written once for every OS, with no I/O of its own (L002: core is pure logic, the host holds every platform call). A shell hands it events (an OS callback, a network answer, the time) and carries out the commands it answers.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate `files-core` (rlib, staticlib, cdylib); depends on `blake3`, `base64`, `serde`, `serde_json` and the formula engine's two crates |
| `contract.json` | DATA: how a contract call travels, the operation and field names the core uses (account-files-routes.json `_folder`), the answer-to-problem map, the content identity form, the version that means "not there yet", where each bound is read in the contract's settings, the root's fixed id and name, the item facts ignore rules may name, the conflict copy's name |
| `include/files_core.h` | The C ABI every shell calls (six functions) |
| `src/lib.rs` | Module list and the public types |
| `src/core.rs` | `Core`: the state machine. Requests to the account's computers in order with failover and stall detection; one item, listing, anchors, change pages and the change wait; fetches with checked spans, read-ahead and progress; creates, renames, moves, deletes and uploads naming the expected version; conflict copies; pins through the contract's pin rule rows; busy waits; kept state |
| `src/protocol.rs` | `Event` / `EventKind` (shell to core) and `Command` (core to shell), as JSON |
| `src/items.rs` | Stable item ids with current names, versions and `kept`, folder dates from children, the item view a shell shows, the facts ignore rules read |
| `src/check.rs` | The checked copy: a span answer is handed on only if it is the version, offset, size and length asked |
| `src/link.rs` | Round trip and rate measured from answers; every size and deadline derived from them and the contract's bounds |
| `src/ranges.rs` | Byte spans and merged span sets (held and in-flight bytes per version) |
| `src/rules.rs` | Ignore rule rows compiled by `formula-engine-compile-rules` and decided by `formula-engine-evaluate-over-rows` (pins are the contract's own rows) |
| `src/errors.rs` | The OS-neutral problem set and the map from an answer to it |
| `src/names.rs` | Full names, folders, extensions, conflict copy names |
| `src/data.rs` | `Contract` (contract.json) and `Setup` (device, computers, bounds) |
| `src/ffi.rs` | The C ABI over `Core` |
| `tests/sim/mod.rs` | A simulated world: the account's computers serving the contract over links with a round trip and a rate, faults, a clock the test moves, an OS that keeps the written bytes |
| `tests/f1_bugs.rs` | The 21 bugs of old Trillion's Finder client as regressions |
| `tests/f2_rules.rs` | Apple File Provider's 10 rules and 5 failures |
| `tests/acceptance.rs` | The plan's acceptance, simulated: a 33 GB clip plays fetching only touched bytes plus one read-ahead window (under the old 17 MB baseline), a 40.54 GB video opens in place, sequential reads at 600 ms never stall, the next computer serves when one is off, ignore and unfinished rules |
| `tests/contract.rs` | Every operation the core asks is one the account files door offers; a job it does not offer (New Folder today) is refused by name; one item by its id |
| `tests/numbers.rs` | No number in code but 0, 1 and one unit; every bound named in contract.json is in the contract's settings |
| `tests/abi.rs` | The header names exactly the exported functions; a listing end to end through the C ABI |

## Key types

| Type | Shape | Role |
|------|-------|------|
| `Setup` | `{device, device_label, computers: [{origin}], bounds: {span_most_bytes, piece_most_bytes, idle_ms}}` | What only the host knows; bounds read from the contract's settings |
| `Event` | `{now_ms, <kind>: {...}}` | One OS callback, answer or tick; bytes beside it |
| `Command` | `{<kind>: {...}}` | One thing for the shell to do; `bytes` beside it when it carries some |
| `Problem` | `unauthorised`, `forbidden`, `missing`, `stale_version`, `unreachable`, `invalid`, `refused_copy`, `not_offered`, `cancelled` | The OS-neutral problems each shell maps to its own |

## Invariants

- No I/O: no file, socket, process, thread, clock or environment call (tests/f2_rules.rs rule 1).
- An item id never changes on a rename or move; a contract row without a stable item id is refused (`not_offered`), never given its path as an id.
- A span is handed on only after its check; a failed check writes nothing and poisons nothing.
- Read-ahead is trained only by copies the OS was handed, and sized from the measured link and reader: `ahead = reader x (round trip + read / rate) + read`, in whole reads.
- Every write names the version it expects; a conflict keeps both versions, the edit beside the other under a plain name.
- An item with an edit on its way says `uploaded: false`.
- No number in code: bounds come from the contract's settings, everything else from measurement.
- No credential in the core: the shell adds its device credential to each request.
- Pins are the contract's pin rule rows naming items for this device; the core never decides a pin itself.

## Open with the files contract (lane files-contract)

The core reads the contract by the names in `contract.json` (trillion-workshop 8baf7aeea: items, versions, generations, `list_changes` with `wait` and `device`, `kept`, pin rule rows, `show_item`, `thumbnail`, `expected_version` on every write). Still open there, each answered `not_offered` or `unreachable` here until it lands, never done another way:
- A compare-and-set refusal reaches the page route as 503 `namespace_source_unavailable`, the same as an outage; the core reads 409 `namespace_conflict` (contract.json `problems`), so until the door answers that, a conflict fails over instead of being kept as a conflict copy.
- No call makes a folder (only WebDAV MKCOL); New Folder is `not_offered` (contract.json `operations.make_folder` null).
- The bounds are read from the contract's settings file; a device with no such file needs them answered by a call.

## Dependencies

**Depends on:** `tools/formula-engine/crates/compile-rules`, `tools/formula-engine/crates/evaluate-over-rows`, `blake3`, `base64`, `serde`, `serde_json`.

**Depended on by:** the OS shells (lane finder-folder: macOS and iOS File Provider).
