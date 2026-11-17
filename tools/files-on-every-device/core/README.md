# core/ (crate `files-core`)

Every rule a native folder of the person's files needs, written once for every OS, with no I/O of its own (L002: core is pure logic, the host holds every platform call). A shell hands it events (an OS callback, a network answer, the time) and carries out the commands it answers.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | Crate `files-core` (rlib, staticlib, cdylib); depends on `blake3`, `base64`, `serde`, `serde_json` and the formula engine's two crates; `ureq` for tests/real_store.rs only |
| `contract.json` | DATA: the engine door's message (`call.body` with its slots) and where its answer and refusal are, the operation and field names the core uses (live-namespace mcp-tools.json), the refusal-to-problem maps (by code and outcome, and by JSON-RPC error code), the content identity form, the version that means "not there yet", the root's fixed id and name, the item facts ignore rules may name, the conflict copy's name |
| `include/files_core.h` | The C ABI every shell calls (six functions) |
| `src/lib.rs` | Module list and the public types |
| `src/core.rs` | `Core`: the state machine. The contract's bounds asked of every computer before the first job; requests to the account's computers in order with failover and stall detection (a stall counts the answers queued ahead on the same link); one item, listing, anchors, change pages and the change wait; fetches with checked spans, read-ahead and progress; creates, renames, moves, deletes and uploads naming the expected version; conflict copies; pins through the contract's pin rule rows; busy waits; kept state |
| `src/protocol.rs` | `Event` / `EventKind` (shell to core) and `Command` (core to shell), as JSON |
| `src/items.rs` | Stable item ids with current names, versions and `kept`, folder dates from children, the item view a shell shows, the facts ignore rules read |
| `src/check.rs` | The checked copy: a span answer is handed on only if it is the version, offset, size and length asked |
| `src/link.rs` | Round trip, rate, read wait and a span answer's size per file byte, measured from answers; every size and deadline derived from them and the contract's bounds |
| `src/ranges.rs` | Byte spans and merged span sets (held and in-flight bytes per version) |
| `src/rules.rs` | Ignore rule rows compiled by `formula-engine-compile-rules` and decided by `formula-engine-evaluate-over-rows` (pins are the contract's own rows) |
| `src/errors.rs` | The OS-neutral problem set |
| `src/door.rs` | The engine door's message for one operation, and its answer read as a result or a problem |
| `src/names.rs` | Full names, folders, extensions, conflict copy names |
| `src/data.rs` | `Contract` (contract.json), `Setup` (device, computers, root) and `Bounds` (the contract's `bounds` answer) |
| `src/ffi.rs` | The C ABI over `Core` |
| `tests/sim/mod.rs` | A simulated world: the account's computers answering the contract through the door's JSON-RPC envelope over links with a round trip and a rate, faults, a clock the test moves, an OS that keeps the written bytes |
| `tests/f1_bugs.rs` | The 21 bugs of old Trillion's Finder client as regressions |
| `tests/f2_rules.rs` | Apple File Provider's 10 rules and 5 failures |
| `tests/acceptance.rs` | The plan's acceptance, simulated: a 33 GB clip plays fetching only touched bytes plus one read-ahead window (under the old 17 MB baseline), a 40.54 GB video opens in place, sequential reads at 600 ms never stall, a file kept as 32 KiB objects at 100 ms each still plays at 40 Mbit/s, the next computer serves when one is off, ignore and unfinished rules |
| `tests/contract.rs` | Every operation the core asks is one live-namespace's session lists; every call is one door message after the bounds; a conflict keeps a copy and asks no other computer; a refusal no row names asks the next; an operation a computer does not serve is `not_offered`; New Folder made and refused when the name is there; one item by its id |
| `tests/real_store.rs` | Not run by default: reads a large file straight through an engine's door (`FILES_CORE_ORIGIN`, `FILES_CORE_FILE`, `FILES_CORE_CREDENTIAL_FILE`) and prints the rate, each read's wait and the bytes moved; the measurement against the real store |
| `tests/numbers.rs` | No number in code but 0, 1 and one unit; every bounds field the core reads is one live-namespace's `bounds` answers |
| `tests/abi.rs` | The header names exactly the exported functions; a listing end to end through the C ABI |

## Key types

| Type | Shape | Role |
|------|-------|------|
| `Setup` | `{device, device_label, computers: [{origin}], root: {id, name, folder}}` | What only the host knows: this computer's derived id, the person's computer rows in order (an origin is opaque to the core: the shell sends to it, a local socket included), the folder this core shows (the computer row's `shows_folders`) |
| `Event` | `{now_ms, <kind>: {...}}` | One OS callback, answer or tick; bytes beside it |
| `Command` | `{<kind>: {...}}` | One thing for the shell to do; `bytes` beside it when it carries some |
| `Problem` | `unauthorised`, `forbidden`, `missing`, `stale_version`, `unreachable`, `invalid`, `refused_copy`, `not_offered`, `cancelled` | The OS-neutral problems each shell maps to its own |

## Invariants

- No I/O: no file, socket, process, thread, clock or environment call (tests/f2_rules.rs rule 1).
- An item id never changes on a rename or move; a contract row without a stable item id is refused (`not_offered`), never given its path as an id.
- A span is handed on only after its check; a failed check writes nothing and poisons nothing.
- Read-ahead is trained only by copies the OS was handed, and sized from the measured read wait, link rate and reader: `ahead = reader x (read wait + read / rate) + read`, in whole reads, all asked at once, so a slow store is read by as many requests as the reader needs.
- No timer in a shell: the core's `wake {at_ms}` says when the next `tick` is due; an empty change wait is asked again no sooner than the contract's idle bound after the last.
- Every write names the version it expects; a conflict keeps both versions, the edit beside the other under a plain name.
- An item with an edit on its way says `uploaded: false`.
- No number in code: bounds are the contract's `bounds` answer, everything else from measurement.
- No transport status is read: every answer and refusal is read from the door's body; a refusal is `{code, outcome}`, and `namespace_conflict` with outcome `not_started` is a conflict copy, never a reason to ask another computer.
- No credential in the core: the shell adds its device credential to each request.
- Pins are the contract's pin rule rows naming items for this device; the core never decides a pin itself.

## Open

- The read rate on the real store is not measured yet: tests/real_store.rs is the measurement. live-namespace reads one span's objects one after another (read_range_inner), so a file kept as 32 KiB objects costs one store round trip per 32 KiB per read; the core carries that with many reads in flight.
- A span crosses the door base64-encoded and twice (as text and as structured content), 8/3 of its own bytes; the core measures that and plans at the file bytes' rate, and a door answer that carries bytes once, unencoded, would almost triple the read rate on the same link (asked of lane engine-root).
- A door refusal before its JSON-RPC (a missing or refused bearer) carries no code, so the core reads it as `unreachable` (asked of lane engine-root).
- Ignore rule rows have no list yet; until one exists a shell hands `rules {ignore: []}`.

## Dependencies

**Depends on:** `tools/formula-engine/crates/compile-rules`, `tools/formula-engine/crates/evaluate-over-rows`, `blake3`, `base64`, `serde`, `serde_json`.

**Depended on by:** the OS shells (lane finder-folder: macOS and iOS File Provider).
