# tools/keep-copies-in-step/

Whether every copy of a person's things is in step: each of their devices says how it stands, and every record two copies changed apart is read from the record the record store kept its versions in (`kept-apart`), as the record now and each other version. The person (or their AI) settles such a record by keeping one version, both, or a merged value; the choice is written and the kept versions removed in one write. The tool reads and writes only the person's own rows, through the records door, and sends nothing.

- **The decisions moved here as they were.** `read-data/catch-up.mjs` is trillion `src/catch-up.mjs` (`catchUp`, `apartOf`, `CatchUpError`) with its invariants: blind to kinds of device, state and record; a device row written only when what the person would see changed; settling as ordinary writes, nothing removed before what was chosen is written; bounded; a copy of the records shown once. `read-data/catch-up.json` is trillion `records/catch-up.json`, byte for byte. Not carried: the store's transport (`GET /catch-up`, `POST /catch-up/here`, `POST /catch-up/settle`, `handleCatchUpRequest`) and the MCP tools `copies_in_step` and `settle_two_versions` (trillion `src/tools.mjs:235-236`); the rows below take their place.
- **The person's own rows**, as `read-data/copies-rows.json` names them, and the rows' rights grant no more:

| Row | Record | How |
|-----|--------|-----|
| Device rows | `setting:catch_up_devices` (type `setting`, the list under `value`) | read; written by `tool:say-how-this-copy-stands` only |
| Versions kept apart | `kept-apart` records, `kept-apart:<record id>` | listed and read; removed by `tool:settle-two-versions` |
| The record kept apart | any kind: the one the request names in `kind` | read; written by `tool:settle-two-versions` (the row's right is filled from `kind`, so a run reaches that kind only) |

- **One read per kind.** A run reads the records of the kind it names; `other_kinds` counts the records kept apart of other kinds, so a page asks for those next.
- **Copies of the records.** How far each copy that settles with the store took (record-sync `copyPositions`) is not a record the door offers; a caller that knows it sends `positions` (`[{ copy, settled_at }]`).
- **Every write is conditioned on what was read.** A device row or record changed meanwhile answers `conflict: true` and nothing is written; `request_key` makes the same change safe to send again.

## Files

| File | Purpose |
|------|---------|
| `read-data/catch-up.mjs` | The moved decisions: `catchUp(store, { records, positions, now, limits })` → `{ here, settle, read }`, `apartOf`, `KEPT_APART` |
| `read-data/catch-up.json` | How often a device row is written again, how many rows are read, the words |
| `read-data/copies-rows.json` | Which records hold the device rows and the versions kept apart |
| `do-work/copies.mjs` | `seeCopiesInStep`, `sayHowThisCopyStands`, `settleTwoVersions`, run by `tools/records-door/do-work/run-an-export.mjs` |
| `part.json` | The public modules |
| `tool-rows.json` | The three Workshop rows |
| `test/catch-up.test.mjs` | trillion `test/catch-up.test.mjs` with its assertions, then each row against the records door stand-in (made-up rows) |

## The rows

| Row | Does |
|-----|------|
| `tool:see-copies-in-step` | `kind` (and `positions`) in; `devices`, `versions` of that kind and `other_kinds` out. Changes nothing |
| `tool:say-how-this-copy-stands` | A device's report in; `{ device, written }` out |
| `tool:settle-two-versions` | `kind`, `id`, `keep` (`one` with `side`, `both`, `merged` with `value`) and `request_key` in; `{ settled, written }` out |
