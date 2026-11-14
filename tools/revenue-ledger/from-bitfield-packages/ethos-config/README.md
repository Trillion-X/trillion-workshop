# ethos-config

Field-mapping rationale for the Ethos School of Tennis revenue projection config.

## SSOT — where the config DATA actually lives

**The single source of truth is the admitted record** `package::revenue-ledger::published-record::revenue-projection-config` in `../things-to-store-and-run.json`. That is the payload the runtime reads (`show/mount-revenue-finance.tsx` → `readRevenueProjectionConfig`) AND the e2e proves (`__tests__/revenue-pipeline-e2e.test.ts` loads it from there). The former duplicate `ethos-config/revenue-projection-config.json` was DELETED (2026-06-29) — it had diverged from the admitted copy (a one-side edit left the live config wrong), exactly the SSOT hazard this dedup removes. Do NOT re-create a separate config file here; edit the admitted record.

## Key Types / Functions

This folder contains no code and no separate DATA file — only this rationale. The reducer in `read-data/project-revenue.ts` consumes the admitted config row; it does not name any of these fields in code.

Field mapping rationale (verified from `packages/checkout/do-work/gate-checkout.ts` `sessionSource()` and `things-to-store-and-run.json` payment-complete event template):
- `amount_field_path: ["amount_due_today_cents"]` — the charged amount in the session source
- `recurring_field_path: ["recurring_amount_cents"]` — subscription recurring amount
- `active_predicate.field_path: ["subscription_status"]` — Stripe subscription status string
- `cohort_key_path: ["offer_id"]` — groups revenue by commercial offer

## Dependencies

**Depends on:** `read-data/revenue-types.ts` (for the `RevenueProjectionConfig` schema shape)

**Depended on by:** operator finance surface (runtime consumer of this config row)
