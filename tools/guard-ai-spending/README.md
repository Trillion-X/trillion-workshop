# tools/guard-ai-spending/

Keeps an AI's own spending inside the budget its person set. Before a spend, the AI reserves it within budget or the spend is refused. Just before paying, it checks the reservation still holds. After paying, it records what it spent, once. Each day the day's total goes back to zero. The ways the AI may pay (a card, a bank, x402 and the next one) are DATA rows that must go through the budget reservation and the spend record. Every row reaches the person's own spend records through the run's records door (`tools/records-door`). Ported from bitfield-packages `packages/agent-wallet` and the rail half of `packages/payment-adapter`.

## Files

| File | Purpose |
|------|---------|
| `do-work/decide-budget.mjs` | The package's budget gate, unchanged: limits and totals as JSON arguments, an admit or deny decision with its check and reservation records. Fail-closed; idempotent on a current reservation with the same key. |
| `do-work/record-spend.mjs` | The package's ledger step, unchanged: prior totals plus one paid amount, the new totals and a payment record. |
| `do-work/decide-daily-reset.mjs` | The package's UTC-day roll-over gate. Only its header comment changed. Exit 0 means reset, exit 3 means the same day. |
| `read-data/spend-budget.mjs` | The tools: each reads the person's records, runs one script above, and writes what it decided. |
| `read-data/read-agent-budget-authority.ts` | `budgetDecisionForOperation`: the latest check, and exactly one current matching reservation, or no spend. |
| `read-data/spend-rails.ts` | `readPaymentRail(s)`: a rail is valid only when its guard is `tool:reserve-a-spend-within-budget` and its ledger is `tool:record-a-spend`. |
| `read-data/spend-rails.json` | The shipped rails (x402, disabled), as DATA a person's own `payment-rail` record replaces. |
| `read-data/spend-authority.ts` | `SpendAuthority`: the one type of the person's `spend-authority` record. |
| `tool-rows.json` | The five rows. |
| `part.json` | No public files: only the container runs this code. |
| `test/decide-budget.test.mjs` | The package's 4 gate cases. |
| `test/read-agent-budget-authority.test.ts` | The package's 7 go-ahead cases. |
| `test/spend-rails.test.ts` | The package's 3 rail cases and payment-adapter's 1 rail contract case. |
| `test/guard-ai-spending-rows.test.mjs` | Each row run as the container runs it, against the fake records door with exactly its rights. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `tool:reserve-a-spend-within-budget` | `{ spend_authority_ref, operation_ref, estimated_cost, rail_ref?, spender_id?, idempotency_key?, ttl_seconds? } -> { approved, reason, idempotent, budget_check, budget_reservation, spend_snapshot }` | Before a spend. Writes the check and the reservation. |
| `tool:may-this-spend-go-ahead` | `{ spend_authority_ref, operation_ref, idempotency_key } -> { available, reason, amount, fencing_token }` | Just before paying. Changes nothing. |
| `tool:record-a-spend` | `{ spend_authority_ref, operation_ref, amount, payment_ref?, rail_ref?, spender_id?, facilitator_response? } -> { already_recorded, total_spent_today, total_spent_all_time, amount, payment_record }` | After paying. One `payment_ref` is added once. |
| `tool:reset-daily-spend` | `{ spend_authority_ref } -> { reset, day, total_spent_today }` | Once per UTC day; later runs the same day change nothing. |
| `tool:read-spend-rails` | `{} -> { rails, refused }` | The rails that may pay, and the rows refused. |
| Records | `spend-authority` `<ref>`: `SpendAuthority`; `spend-budget-check` `spend-budget-check:<operation>`; `spend-budget-reservation` `spend-budget-reservation:<operation>`; `spend-payment` `<payment_ref>`; `payment-rail` `<rail id>` | The person's own records. |

## Invariants

- Money is whole cents. No authority record, or one that is not both enabled and `active`, refuses every positive spend. A zero-cost operation is checked and fenced without using the budget.
- The run's clock is the time: a caller's `now_iso` is dropped, so a caller cannot keep a reservation alive or move a day.
- No tool here sets a limit or turns an authority on. Those are the person's own to set, never their AI's. `record-a-spend` and `reset-daily-spend` write only the totals and the reset day.
- No key, card number or wallet secret is in a row, a record or a fixture. A rail names its credential by `credential_ref` only.

## Dependencies

**Depends on:** `tools/records-door` (packed by every row at `/opt/records-door`). Node 24 in the tool container: it runs the `.ts` files by stripping their types, and it runs the `do-work/` scripts as child processes.

**Depended on by:** any rail's settlement tool (each must reserve before paying and record after). Trillion's deploy reads `tool-rows.json`.
