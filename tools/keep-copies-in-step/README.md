# tools/keep-copies-in-step/

Whether every copy of a person's things is in step, as their own store knows it: each device says how it stands (its state, the changes it still holds, when its writes last reached the store), and every record two copies changed apart is read from the record store's kept-apart records, as the record now and the other versions. The person (or their AI) settles one by keeping one version, both, or a merged one.

- **Moved, not rewritten.** `read-data/catch-up.mjs` and `read-data/catch-up.json` are trillion `src/catch-up.mjs` and `records/catch-up.json` (b4e3c05abe), with only their import paths changed (`ports/catch-up.json`). The engine's Rust copy (trillion-rust `src/catch_up.rs`, `src/local_account/catch_up.rs`, `GET /catch-up`, `POST /catch-up/here`, `/catch-up/conditional-here` and `/catch-up/settle`, and `product/catch-up.json`) is deleted in the same move.
- **The person's own rows.** Read and written only as `read-data/copies-rows.json` names them, and the rows' rights grant no more:

| Row | Record | How |
|-----|--------|-----|
| Device rows | `setting:catch_up_devices` (type `setting`, the list under `value`) | read; written by `tool:say-how-this-device-stands` only |
| Versions kept apart | `kept-apart` records (`kept-apart:<record id>`) | listed and read; removed by `tool:settle-two-versions` once the choice is written |
| The record kept apart | the kind the request names as `thing_type` | read; written by `tool:settle-two-versions` |

- **One kind per call.** A row's rights name one record kind, so a read answers the versions of the kind it names and lists the other kinds kept apart in `other_kinds`, to ask about next.
- **Every write stands on what was read.** Each write carries `expected`: a row changed meanwhile answers `conflict: true` and nothing is written. The `request_key` makes the same change safe to send again.
- **How far each copy took.** The engine's copy positions are not a record; a caller that has them sends them as `positions` (`[{ copy, settled_at }]`).

## Files

| File | Purpose |
|------|---------|
| `read-data/catch-up.mjs` | `catchUp` (`here`, `settle`, `read`), `apartOf`, `KEPT_APART`, `handleCatchUpRequest` |
| `read-data/catch-up.json` | How often a device row is written again, how many are read, the words of each version |
| `read-data/copies-rows.json` | Which record holds the device rows, and the read bounds |
| `do-work/copies.mjs` | `seeIfMyCopiesAreInStep`, `sayHowThisDeviceStands`, `settleTwoVersions`, run by `tools/records-door/do-work/run-an-export.mjs` |
| `ports/catch-up.json` | The port contract for the move |
| `part.json` | The public modules |
| `tool-rows.json` | The three Workshop rows |
| `test/catch-up.test.mjs` | The original trillion tests, assertions unchanged |
| `test/copies.test.mjs` | Each row over made-up rows against the records door stand-in: the read, a report, keep one, keep both, a conflict, a resent report |

## The rows

| Row | Function | What it does |
|-----|----------|--------------|
| `tool:see-if-my-copies-are-in-step` | `seeIfMyCopiesAreInStep` | `{ devices, versions, other_kinds }` |
| `tool:say-how-this-device-stands` | `sayHowThisDeviceStands` | keeps one device's report, written only when it changed |
| `tool:settle-two-versions` | `settleTwoVersions` | keep `one`, `both` or `merged`, written on condition |

## Dependencies

**Depends on:** `tools/records-door` (the door and `run-an-export.mjs`), `tools/content-identity`.
