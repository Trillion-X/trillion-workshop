# agent-wallet

The rail-agnostic autonomous spend guard: generic budget/reservation/ledger/reset workflows, a rail-descriptor DATA row, and the spend-authority status UI. Any payment rail — x402, bank, Stripe, or the next twenty — is swappable DATA; none owns the spend invariant.

## Files

| File | Purpose |
|------|---------|
| `things-to-store-and-run.json` | EEAF data model: one disabled `payment-rail:x402` descriptor (including its stable legacy `service_connection:x402-agent-wallet` and signing-source references) + seed spend-check/reservation records + the `agent-wallet` package entry. |
| `things-to-store-and-run.json` | Canonical package boundary with generic workflow DATA: `action:budget-gate` (pre-spend reservation gate), `action:reset-daily-spend` (daily reset), `action:record-spend` (post-settlement ledger), and the 3 `do-work/` scripts as stored-bytes. Every workflow binds its selected `spend_authority_ref` dynamically. |
| (removed 2026-09-09) | `budget-gate.things.json`, `x402-signing.things.json`, `deliver-budget-gate.mjs` and `deliver-x402-signing.mjs` are deleted. The budget-gate rows were already in `things-to-store-and-run.json` (the manifest copies are the newer ones); the `build-eip712-digest-mjs` stored-bytes row was lifted into the manifest the same day. Every record is delivered with the package by `make-packages-match-their-source`; nothing is delivered by hand. |
| `entry-to-package-data-map.json` | Maps the `agent-wallet` entry to the live data addresses its UI reads. |
| `do-work/` | Pure Node decision scripts run as `compute.process` steps (see `do-work/README.md`). |
| `show/AgentWalletPanel.tsx` | Spend-authority status + budget UI (reference-grounded, reads live rail DATA). |
| `read-data/` | SSOT type decoders: `read-agent-wallet.ts` (`SpendAuthority`, with legacy `X402Wallet` alias), `read-agent-budget-authority.ts` (spend check/reservation). |
| `.bitfield-entry-scope/` | Entry scope descriptor for the `agent-wallet` package entry. |

## Key Workflow Actions (declared in things-to-store-and-run.json)

| Definition | Shape | Role |
|-----------|-------|------|
| `action:budget-gate` | input `{operation_ref, estimated_cost, spend_authority_ref, rail_ref, spender_id?, idempotency_key?, ttl_seconds?}` → `{approved, reason, check_ref, reservation_ref}` | Structural pre-operation spend authorization. Reads the selected rail authority (5 read-current steps) + existing reservation → `decide-budget.mjs` → writes spend_budget_check + spend_budget_reservation. Fail-closed; idempotent on a current same-key reservation. |
| `action:reset-daily-spend` | input `{spend_authority_ref, rail_ref}`; clock-tick triggered (trigger `is_active:false`) | Zeroes that authority's `total_spent_today` once per UTC day (single-flight via marker + exit-code-gated edge). |
| `action:record-spend` | input `{amount, operation_ref, spend_authority_ref, rail_ref, spender_id?, payment_ref?, facilitator_response?}` → `{total_spent_today, total_spent_all_time, amount}` | Post-settlement rail-agnostic ledger increment + `spend_payment_processed` audit record. |

## Invariants

- **Live-log reads use `engine.operation.read-current` by address** — NOT `find-current-items` (which only sees the package-admission projection, not write-batch facts).
- **Fail-closed for money:** every rail descriptor ships `enabled:false`, and absent authority facts decode as `status:pending_setup` / `enabled:false`; the gate DENIES every positive-cost spend until that selected rail is explicitly funded + activated. A declared zero-cost operation receives an auditable zero-amount reservation without consuming authority.
- **A rail cannot bypass the guard:** `guard_invoke` must target `action:budget-gate`, `ledger_invoke` must target `action:record-spend`, and settlement credentials stay in credentials-vault references. x402 signing remains rail DATA, not the spend owner.
- **Integer minor units of USD (cents)** throughout. No closed status/result enums.

## Dependencies

**Depends on:** the workflow slot (`slot::workflow` `execute_definition`), `compute.process` (Node script execution), `notice-when-something-shows-up` (its clock waiter emits the `clock::tick` topic for the daily-reset trigger; superseded `clock-ticker` 2026-09-05), and the live log (`engine.operation.read-current` / `write-batch`).
**Depended on by:** every autonomous positive-cost operation — it calls `action:budget-gate` before the selected rail and `action:record-spend` after confirmed settlement.

## Not Yet Built (fork-blocked)

The x402 settlement action remains disabled rail DATA. Until every rail-specific settlement action is present, the generic gate + ledger remain live and fail-closed.
