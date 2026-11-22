# notice-when-something-shows-up/do-work

The resident emitter and the mechanism leaves it mounts.

## Files

| File | Purpose |
|---|---|
| `emit-arrival-fact.mjs` | The resident process. Reads waiter descriptor rows from the log, resolves each row's mechanism leaf by plain filename inside `mechanisms/`, proves the leaf answers to the declared capability reference, appends one fact per transition, resumes sequence from the log, records a refused or unwatchable waiter as a fact, and hands over to the supervisor after sustained append failure. Zero source names, zero dispatch. |
| `mechanisms/` | One leaf per way of waiting. See its README. |
| `tell-the-engine.mjs` | The noticer run as a Workshop tool: the same resident emitter with a carrier that tells each fact at the engine door's `wake:arrive`, keeping each waiter's last fact and state in the run's kept folder only after the engine took it. A door call that does not answer within `door-call.json` `timeout_ms` is refused `door_timeout` and told again. |
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
