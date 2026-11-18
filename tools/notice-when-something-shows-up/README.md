# tools/notice-when-something-shows-up/

A resident process that reads standing orders (waiter rows), starts the waiting mechanism each one names, and appends one self-describing fact each time something outside became reachable or stopped being reachable: time passing, a storage volume attached or removed, a delivery arriving over the network, a unit of files somebody finished putting in a place. It never dispatches anything; whatever wants to react reads the facts. The clock is one waiter row whose projection reproduces the old clock tick record byte for byte.

Moved byte for byte from the old `notice-when-something-shows-up` package of `bitfield-packages` (`moved-from.json` is the receipt).

## Files

| File | Purpose |
|------|---------|
| `do-work/tell-the-engine.mjs` | The noticer as a Workshop tool (`tool:notice-when-something-shows-up`, `tool-rows.json`): the same emitter with a carrier that tells the person's engine each fact at `wake:arrive`, of the waiter's kind, its fields as text. Its waiter rows are the run's input; kept running by its wake (`running`), or given `for_seconds` it watches that long and answers `{told, refused}`. A fact's event id is the waiter's address and the transition's own event key when it names one (`clock::due@<instant>`), so telling it again is one fact to the engine. Given `--keep <folder>` (the row's `invoke.kept_folder`, one folder per account and tool that lasts between runs), each waiter's last fact and its mechanism's state are kept there, written whole after the engine accepted the fact, and a restarted waiter resumes from them. |
| `tool-rows.json`, `kits/notice-when-something-shows-up.json` | The row (fact rights: one `{at, id: <kind>, operations: ["wake:arrive"]}` per kind it may tell) and its kit, drafted from its real sample run. |
| `do-work/emit-arrival-fact.mjs` | The resident emitter: reads waiter rows, resolves each row's mechanism leaf by plain file name and proves it answers to the capability reference the row declares, appends one fact per transition, resumes its sequence from the log, records a refused or unwatchable waiter as a fact, and hands over to the supervisor after sustained append failure. |
| `do-work/mechanisms/elapsed-time.mjs` | Waits for a stretch of time; contributes the four clock fields. |
| `do-work/mechanisms/due-time.mjs` | Waits for a due time, once (`at_ms`) or a repeat (`every_ms`, `from_ms`, `zone`), and tells it under its instant; contributes `due_ms` and `missed`. It replaces the engine's own time wakes (trillion-rust src/wake.rs `On::Time`, `Repeat`; T4.3, then T4.7 deletes them). See "Time as a fact" below. |
| `do-work/mechanisms/filesystem-volume-attachment.mjs` | Waits for a storage volume to become reachable or stop being reachable under a declared place; identity comes from the volume's own identity file. |
| `do-work/mechanisms/inbound-http-delivery.mjs` | Waits for something delivered over the network on a declared port; answers 503 when the fact could not be written so the sender retries. |
| `do-work/mechanisms/files-someone-finished-putting-here.mjs` | Waits for somebody outside to finish putting a unit in a place; the completion note is the completeness signal and the identity carrier. |
| `tests/due-time.test.mjs` | The engine's own time wake tests, given by the leaf: a new repeat waits for its first due time, a missed repeat fires once with its count, a restart resumes, a zone keeps its wall-clock time (Denver, the same numbers as wake's test), a skipped and a repeated wall time, a quarter-hour and a half-hour-moving zone, a once-at time told once, a refused tell counted as missed, and the carrier's event key and kept folder. |
| `tests/emit-arrival-fact.test.mjs`, `tests/files-someone-finished-putting-here.test.mjs`, `tests/tell-the-engine.test.mjs` | The clock parity, the unmatched appearance, departure, identity over visible name, refused and unwatchable waiters, and the handover mechanism. Both read `things-to-store-and-run.json`. |
| `things-to-store-and-run.json` | The package's own boundary file: the arrival-fact contract, the retention policy, the waiter descriptor rows (the clock and attached volumes) and the stored-bytes entries. |
| `do-work/README.md`, `do-work/mechanisms/README.md`, `tests/README.md` | The package's own notes for each folder. |
| `moved-from.json`, `ports/` | The receipt and the port contracts of the move. |

## Time as a fact (T4.3)

The engine's time wakes keep their memory in the engine's cause book. The noticer keeps nothing of its own between runs. So the question was where the leaf's memory lives. The answer uses only parts that already exist:

- **Exactly once is the engine's.** The engine admits one fact per teller, kind and event id, and its marker lasts (trillion-rust src/wake.rs `fact`). The leaf names each due time by its instant. Telling it again after a restart, or after a crash between the tell and the keep, is the same fact and starts nothing.
- **Missed counts and "starts from now" are the leaf's own state, in the row's kept folder.** That folder already exists for every tool row that declares `invoke.kept_folder` (trillion-rust src/tool_runs/tools/container.rs `kept_folder`). It needs no new engine code. Every mechanism now gets its waiter's kept state (`state`) and a way to keep more (`keepState`), so a volume or files waiter can resume too.
- **A lost kept folder never fires twice.** The event id is the instant, not a counter, so a reset can never collide with an old fact. It acts as a first start: due times before it are not told, as in wake.
- **A clock change follows wake's own words** ("the first instant after the gap", "its first instant"), through tools/wall-time (`next-valid`, `earlier`). No wake test pinned a skipped time. Wake's code uses jiff `compatible()`, which may move a skipped 2:30 to 3:30. That would contradict its own doc. Its words and the timed-action port agree on 3:00, so the leaf follows them.
- **Left out:** wake's spread (moving round-minute due times a little, spread.rs). It shapes load on one computer serving many people and is no part of a time's meaning. It is not in T4.3's list.

## Key Functions (`do-work/emit-arrival-fact.mjs`)

| Export | Role |
|--------|------|
| `readWaiterRow(row)` | Validates one waiter row; refuses a leaf name that is not a plain file in the mechanisms folder. |
| `resolveMechanism(row, { loadModule })` | Loads the leaf and proves its declared mechanism reference equals the row's. |
| `matchedSourceRefs(identity, candidates)` | Evaluates identity predicates; unknown selectors or operators are refused, absence never matches. |
| `runResidentEmitter({ carrier, ... })` | The resident loop. |

## Dependencies

**Depends on:** Node's own modules; the emitter takes the log it appends to as `carrier`.

**Depended on by:** any tool whose wake hears its facts (`on: {fact: {kind, from: ["run"], match}}`, trillion-rust src/wake.rs).
