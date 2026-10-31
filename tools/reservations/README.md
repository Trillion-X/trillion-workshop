# tools/reservations/

A finite pool of places (seats, rooms, appointment slots, parking bays, licences) kept in one `capacity-ledger` record in the person's own records, and a person's reservations sorted by status. Ported from bitfield-packages `packages/reservation-tracker`: the ledger steps and the reservation reader are the package's, without the old engine's target wrapper and operation-record shape.

- **The record is the truth.** A hold carries the idempotency key that made it, so the same key sent again finds its own hold. Nothing lives in memory between runs.
- **Classes are data.** `reserved_by_class` holds places kept back for each named class. A class that is not named shares what is left, so an AI can invent a class with no change to the tool.
- **The run's clock is the time.** A caller cannot choose when a step happened, so it cannot end holds early or keep one alive. Expiry is given as seconds from now.
- **One writer per ledger is safest.** The records door has no compare-and-swap. Every step is read, applied, written, and read back; when the read-back does not show the step, the run says so and the same request is sent again (safe, by its key). Two runs writing one ledger in the same instant can still overwrite each other, so a busy ledger should have one writer.
- **Nothing here lists a person's statuses.** `attention_order` is the person's own list.

## Files

| File | Purpose |
|------|---------|
| `do-work/capacity-ledger.ts` | The pure steps: `openCapacityLedger`, `holdUnit`, `joinWaitlist`, `promoteWaitlist`, `releaseUnit`, `expireHolds`, `capacityLedgerProjection`. Each takes a ledger and returns the next one. Copied; the header and the type import changed, and the old package-target dispatcher is gone. |
| `read-data/reservations.ts` | `decodeReservations` (either spelling, rows with no id dropped) and `reservationsByStatus`. The old operation-record builder is not carried. |
| `do-work/reservations.mjs` | The tool seam: each export reads the ledger through the records door, applies one step, writes it and reads it back. |
| `tool-rows.json` | Eight rows. |
| `part.json` | No public files. |
| `test/capacity-ledger.test.mjs` | The package's ledger cases, plus refusals. |
| `test/reservations.test.mjs` | Decoding and grouping. |
| `test/reservations-rows.test.mjs` | Every row run as the container runs it, against the fake records door with exactly its rights. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `capacity-ledger` record | `{ ledger_id, scope_ref, capacity_policy: { total, reserved_by_class, oversubscription_policy, release_policy, policy_ref? }, holds, waitlist_entries, state, sequence }` | One pool. `state` is `open`, `full` or `waitlist_open`. |
| `tool:open-a-capacity-ledger` | `{ ledger_id, scope_ref, total, reserved_by_class? } -> { already_open, ledger_id, state, total, confirmed, waiting }` | Opens once. |
| `tool:hold-a-place` | `{ ledger_id, subject_ref, idempotency_key, unit_class?, expires_in_seconds? } -> { outcome: held \| waitlisted, hold? \| waitlist_entry?, ... }` | Hold or wait. |
| `tool:release-a-place` | `{ ledger_id, idempotency_key, hold_id? \| subject_ref?, promote_next? } -> { released, released_hold?, promoted_hold?, ... }` | Give back, promote the next. |
| `tool:join-a-waitlist` / `tool:promote-from-the-waitlist` | `{ ledger_id, subject_ref, idempotency_key, reason }` / `{ ledger_id, idempotency_key, waitlist_entry_id? }` | The waitlist by hand. |
| `tool:expire-old-holds` | `{ ledger_id, promote_next? } -> { expired_holds, promoted_holds, ... }` | Run on a schedule. |
| `tool:read-a-capacity-ledger` | `{ ledger_id, title? } -> { ledger, projection, ... }` | Changes nothing. |
| `tool:sort-reservations-by-status` | `{ reservations?, attention_order? } -> { count, groups, without_policy }` | Reads the person's `reservation` records when no rows are given. |

## Dependencies

**Depends on:** `tools/records-door` (packed by every row at `/opt/records-door`). Node 24 in the tool container runs the `.ts` files by stripping their types.

**Depended on by:** Trillion's deploy reads `tool-rows.json`. A tool that sells places (a class, a table) holds and releases through these rows.
