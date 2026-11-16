# tools/reservations/

A finite pool of places (seats, rooms, appointment slots, parking bays, licences) worked out on one `capacity-ledger` record the person's AI holds in their own records, and a person's reservations sorted by status. The tools read and keep nothing: each takes the ledger (or the reservation rows) in the request and answers its whole result, the next ledger included. Moved byte for byte from bitfield-packages `packages/reservation-tracker` (receipt `moved-from.json`): the ledger steps with their dispatcher, the reservation reader with its operation-record feed, and the package's two test files.

- **The ledger you give is the truth.** A hold carries the idempotency key that made it, so the same key sent again with the ledger it made finds its own hold. Nothing lives in memory between runs and nothing is kept by the tool: the person's AI keeps the ledger each step answers.
- **Classes are data.** `reserved_by_class` holds places kept back for each named class. A class that is not named shares what is left, so an AI can invent a class with no change to the tool.
- **The run's clock is the time.** A caller cannot choose when a step happened, so it cannot end holds early or keep one alive. Expiry is given as seconds from now.
- **One writer per ledger is safest.** Each step works on the ledger it is given, so two callers working from the same ledger produce two next ledgers and the later one kept wins. The ledger's `sequence` says which one a ledger is; a busy ledger should have one caller at a time.
- **Nothing here lists a person's statuses.** `attention_order` is the person's own list.

## Files

| File | Purpose |
|------|---------|
| `do-work/capacity-ledger.ts` | The pure steps: `openCapacityLedger`, `holdUnit`, `joinWaitlist`, `promoteWaitlist`, `releaseUnit`, `expireHolds`, `capacityLedgerProjection`. Each takes a ledger and returns the next one. Moved from the package unchanged; it also holds the old package-target dispatcher `applyCapacityLedgerOperation`. |
| `read-data/reservation-tracker.ts` | `decodeReservations` (either spelling, rows with no id dropped), `reservationsByStatus`, and the operation-record feed `buildReservationOperations` / `decodeReservationOperationFeed`. Moved from the package unchanged. |
| `do-work/capacity-ledger.test.ts`, `read-data/reservation-tracker.test.ts` | The package's own tests, moved with only their import paths changed. |
| `do-work/reservations.mjs` | The tool seam: each export applies one step to the ledger it is given and answers the next ledger. |
| `tool-rows.json` | Eight rows. |
| `part.json` | No public files. |
| `test/capacity-ledger.test.mjs` | The package's ledger cases, plus refusals. |
| `test/reservations.test.mjs` | Decoding and grouping. |
| `test/reservations-rows.test.mjs` | Every row run as the container runs it, with no records door: the ledger comes in the request, the next ledger comes back. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `capacity-ledger` record | `{ ledger_id, scope_ref, capacity_policy: { total, reserved_by_class, oversubscription_policy, release_policy, policy_ref? }, holds, waitlist_entries, state, sequence }` | One pool. `state` is `open`, `full` or `waitlist_open`. |
| `tool:open-a-capacity-ledger` | `{ ledger_id, scope_ref, total, reserved_by_class?, ledger? } -> { already_open, ledger, ledger_id, state, total, confirmed, waiting }` | Opens once; the ledger you already hold, given, is answered unchanged. |
| `tool:hold-a-place` | `{ ledger, subject_ref, idempotency_key, unit_class?, expires_in_seconds? } -> { outcome: held \| waitlisted, hold? \| waitlist_entry?, ledger, ... }` | Hold or wait. |
| `tool:release-a-place` | `{ ledger, idempotency_key, hold_id? \| subject_ref?, promote_next? } -> { released, released_hold?, promoted_hold?, ledger, ... }` | Give back, promote the next. |
| `tool:join-a-waitlist` / `tool:promote-from-the-waitlist` | `{ ledger, subject_ref, idempotency_key, reason }` / `{ ledger, idempotency_key, waitlist_entry_id? }` | The waitlist by hand. |
| `tool:expire-old-holds` | `{ ledger, promote_next? } -> { expired_holds, promoted_holds, ledger, ... }` | Run on a schedule. |
| `tool:read-a-capacity-ledger` | `{ ledger, title? } -> { projection, ... }` | Changes nothing. |
| `tool:sort-reservations-by-status` | `{ reservations, attention_order? } -> { count, groups, without_policy }` | Groups the rows given. |

## Dependencies

**Depends on:** `tools/records-door` (the export command, packed by every row at `/opt/records-door`). Node 24 in the tool container runs the `.ts` files by stripping their types.

**Depended on by:** Trillion's deploy reads `tool-rows.json`. A tool that sells places (a class, a table) holds and releases through these rows.
