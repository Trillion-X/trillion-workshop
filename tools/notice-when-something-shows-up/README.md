# tools/notice-when-something-shows-up/

A resident process that reads standing orders (waiter rows), starts the waiting mechanism each one names, and appends one self-describing fact each time something outside became reachable or stopped being reachable: time passing, a storage volume attached or removed, a delivery arriving over the network, a unit of files somebody finished putting in a place. It never dispatches anything; whatever wants to react reads the facts. The clock is one waiter row whose projection reproduces the old clock tick record byte for byte.

Moved byte for byte from the old `notice-when-something-shows-up` package of `bitfield-packages` (`moved-from.json` is the receipt).

## Files

| File | Purpose |
|------|---------|
| `do-work/emit-arrival-fact.mjs` | The resident emitter: reads waiter rows, resolves each row's mechanism leaf by plain file name and proves it answers to the capability reference the row declares, appends one fact per transition, resumes its sequence from the log, records a refused or unwatchable waiter as a fact, and hands over to the supervisor after sustained append failure. |
| `do-work/mechanisms/elapsed-time.mjs` | Waits for a stretch of time; contributes the four clock fields. |
| `do-work/mechanisms/filesystem-volume-attachment.mjs` | Waits for a storage volume to become reachable or stop being reachable under a declared place; identity comes from the volume's own identity file. |
| `do-work/mechanisms/inbound-http-delivery.mjs` | Waits for something delivered over the network on a declared port; answers 503 when the fact could not be written so the sender retries. |
| `do-work/mechanisms/files-someone-finished-putting-here.mjs` | Waits for somebody outside to finish putting a unit in a place; the completion note is the completeness signal and the identity carrier. |
| `tests/emit-arrival-fact.test.mjs`, `tests/files-someone-finished-putting-here.test.mjs` | The clock parity, the unmatched appearance, departure, identity over visible name, refused and unwatchable waiters, and the handover mechanism. Both read `things-to-store-and-run.json`. |
| `things-to-store-and-run.json` | The package's own boundary file: the arrival-fact contract, the retention policy, the waiter descriptor rows (the clock and attached volumes) and the stored-bytes entries. |
| `do-work/README.md`, `do-work/mechanisms/README.md`, `tests/README.md` | The package's own notes for each folder. |
| `moved-from.json`, `ports/` | The receipt and the port contracts of the move. |

## Key Functions (`do-work/emit-arrival-fact.mjs`)

| Export | Role |
|--------|------|
| `readWaiterRow(row)` | Validates one waiter row; refuses a leaf name that is not a plain file in the mechanisms folder. |
| `resolveMechanism(row, { loadModule })` | Loads the leaf and proves its declared mechanism reference equals the row's. |
| `matchedSourceRefs(identity, candidates)` | Evaluates identity predicates; unknown selectors or operators are refused, absence never matches. |
| `runResidentEmitter({ carrier, ... })` | The resident loop. |

## Dependencies

**Depends on:** Node's own modules; the emitter takes the log it appends to as `carrier`.

**Depended on by:** nothing in this repository yet.
