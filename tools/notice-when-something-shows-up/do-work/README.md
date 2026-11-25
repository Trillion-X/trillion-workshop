# notice-when-something-shows-up/do-work

The resident emitter and the mechanism leaves it mounts.

## Files

| File | Purpose |
|---|---|
| `emit-arrival-fact.mjs` | The resident process. Reads waiter descriptor rows from the log, resolves each row's mechanism leaf by plain filename inside `mechanisms/`, proves the leaf answers to the declared capability reference, appends one fact per transition, resumes sequence from the log, records a refused or unwatchable waiter as a fact, and hands over to the supervisor after sustained append failure. Zero source names, zero dispatch. |
| `mechanisms/` | One leaf per way of waiting. See its README. |
| `tell-the-engine.mjs` | The noticer run as a Workshop tool: the same resident emitter with a carrier that tells each fact at the engine door's `wake:arrive`, keeping each waiter's last fact and state in its place store (`kept-places.mjs`: the run's kept folder, or the database `places_in` names) only after the engine took it, under keys that name the wake that started the run (`--wake`, the task's `cause.wake`), so the copies of one wake keep apart; each waiter's own folder in the kept folder is the wake's too, its first one copied from the folder every copy shared. A waiter whose place another run claimed tells nothing more and ends with that refusal as its fact. A door call that does not answer within `door-call.json` `timeout_ms` is refused `door_timeout` and told again. |
| `kept-places.mjs` | Where each waiter's place (its last fact and its mechanism's state) is kept, under its kept key (`keptKeyOf`: the wake that started the run, `|`, the waiter ref and its address, such as `keep-noticing-row-changes/notes|waiter:row-changes@where::something-changed`; a run no wake started keeps under the key without a wake). A wake's first read of a key no store holds carries over once from the key without a wake, the one every copy shared (the database's own row, its shared row, the folder's own file, its shared file, in that order); the shared row or file is only ever read, so every copy can carry over from it. The store is the run's kept folder (`folderPlaces`, one file per kept key, as before), or, when the run's input names `places_in` (a vault name held on descriptor 63, `PLACES_FD`), that database's `kept_waiter_places` table (`databasePlaces`: one row per tool and kept key, made by `PLACES_SETUP_SQL` when missing; a table with a trigger of its own is refused). A run claims each place it reads (its version moves on and names the run, the computer and the time); every write is compare-and-set on the version it holds, so of two runs of one wake the one that started last holds the place and the other is refused (`placeTaken`). A database place wins over a kept-folder place; the folder is read only for a key the database has no row for. A store that cannot be read is a crash, never an empty place. |
| `door-call.json` | DATA for door calls, each with its why: `timeout_ms` (the longest one door call may take) and `tell_again_codes` (refusals whose fact is fine and is told again after a wait: `owed_full`, `door_timeout`). |

## Key Functions

| Export | Signature | Role |
|---|---|---|
| `readWaiterRow` | `(row) -> declared` | Validate one descriptor row; refuse a leaf name that is not a plain file. |
| `resolveMechanism` | `(row, {loadModule}) -> {declared, mechanism, described}` | Load the leaf and prove its `mechanism_ref` equals the row's; refuse a leaf that shadows an arrival field. |
| `evaluateIdentityClaim` / `identityMatches` / `matchedSourceRefs` | pure | Identity predicates over `observed_identity`, `op:core.equals` only; unknown selectors or operators are refused; absence never matches. |
| `candidatesFromFeedEntries` | `(entries, feed) -> candidates` | Read the candidate identity feed by the field names the row declared. |
| `nextObservedAt` | `(nowMs, previousIso) -> iso` | Floored so time never moves backward. |
| `selectPayload` / `buildScope` | pure | The projection that lets one emitter write the clock record and the arrival fact with no branch. |
| `resumeSequenceFrom` | `(record) -> int` | Continue from `sequence`, or from a predecessor `counter`. |
| `shouldHandOverAfterFailures` | `(n, threshold) -> bool` | Supervisor handover rule. |
| `makeCarrier` | `({url, partition}) -> carrier` | The one address this process talks to; refreshes its basis on 428. |
| `runResidentEmitter` | `({carrier, loadModule, signal, nowMs, onRefusal})` | The resident loop. |

## Dependencies

**Depends on:** `node:path`, `node:url`, the mechanism leaves under `mechanisms/`, and the owner carrier's `engine.operation.label-addressed` target.
**Depended on by:** `../things-to-store-and-run.json` (stored bytes mounted by the start action), `../tests/`.
