# tools/move-records-through-declared-states/

A record (a deal, an order, an applicant) is in one of a declared set of stages, moves only where a declared move allows it, and its current stage is read from its moves, never stored beside them. Ported from bitfield-packages `move-records-through-declared-states`, which had no runtime imports; its engine file is unchanged. The two Workshop tools that run it in the tool container are rows in `tool-rows.json`.

## Files

| File | Purpose |
|------|---------|
| `do-work/move-records-through-declared-states.mjs` | The engine, unchanged: pure functions over stage descriptors and moves, no disk, no clock, no storage. Its header explains the three refusals (a finished stage with a way out, a move naming an undeclared stage, a stored current stage). |
| `do-work/check-a-stage-move.mjs` | `tool:check-a-stage-move`: where a record is now, every next stage with why it is or is not open, and whether it may move to the stage asked for, with the move to keep. |
| `do-work/check-a-pipeline.mjs` | `tool:check-a-pipeline`: every mistake in a set of stages (duplicate keys, a way out of a finished stage, a move to an undeclared stage, stages the start never reaches), reported rather than thrown. |
| `part.json` | The engine file is public. |
| `tool-rows.json` | The Workshop rows Trillion reads for this folder: `tool:check-a-stage-move`, `tool:check-a-pipeline`. |
| `test/move-records-through-declared-states.test.mjs` | Tests for this folder, run by `npm test` at the top of the repository. |

## Key Types / Functions

| Function | Signature | Role |
|----------|-----------|------|
| `statesByKey` | `(descriptors) -> Map<key, descriptor>` | Every declared stage; a duplicate key throws. |
| `transitionsFrom` | `(descriptors, states) -> Transition[]` | The allowed moves, checked once against the stages they name. |
| `conditionHolds` | `(condition, signals) -> boolean` | The closed condition algebra: `all`, `any`, `equals`, `at_least`, `at_most`, `absent`. |
| `currentState` | `(moves, states, startKey) -> key` | The last move's stage; no moves is the start stage. |
| `movesAvailable` | `({states, transitions, from, signals}) -> {to, allowed, reason}[]` | Every option with its refusal reason. |
| `moveIsAllowed` | `({states, transitions, from, to, signals}) -> {allowed, reason}` | The one answer to "may it move there". |
| `moveRecordFor` | `({..., at, because}) -> {from, to, at, because}` | The move to keep; refuses an illegal move. |
| `reachableFrom` / `unreachableStates` | `(transitions, start)` / `(states, transitions, start)` | Which stages the design connects. |

Each tool script reads the run's input as JSON from its first argument and prints its result as JSON on its last line.

## Dependencies

**Depends on:** nothing (Node 24 in the tool container runs the scripts).

**Depended on by:** `tool-rows.json` (the tool rows), Trillion's deploy (it bundles the files a row names), `test/move-records-through-declared-states.test.mjs`, Trillion's `test/crm-tools.test.mjs`.
