# packages/revenue-ledger

Generic, config-driven projection of signed payment events into a revenue view.

## Files

| File | Purpose |
|------|---------|
| `read-data/revenue-types.ts` | `PaymentEvent`, `RevenueProjectionConfig`, `RevenueView`, `CohortBucket`, `RoleBucket` |
| `read-data/project-revenue.ts` | Pure `projectRevenue(events, config)` — generic reducer, no hardcoded field names |
| `read-data/read-payment-events.ts` | `readPaymentEvents(rows)` + `readRevenueProjectionConfig(rows)` — fold opaque runtime rows into the projection's typed inputs |
| `show/revenue-finance-display.ts` | `presentRevenue(view)` → finished finance display model (see `show/README.md`) |
| `show/revenue-finance-surface.tsx` | `RevenueFinanceSurface` — reference-grounded operator finance UI (see `show/README.md`) |
| `show/mount-revenue-finance.tsx` | Thin live mount: rows → events+config → project → present → surface |
| `ethos-config/revenue-projection-config.json` | Society DATA: Ethos field mappings for the real checkout event attributes |
| `things-to-store-and-run.json` | Package boundary: stored_bytes, contract record, entity-type descriptors |
| `vitest.config.mjs` | Isolated vitest runner config |
| `__tests__/project-revenue.test.ts` | 14 tests: ethos config correctness, genericity proof, Stonehenge, unknown-role safety |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `PaymentEvent` | `{event_id, occurred_at, event_kind, attributes: Record<string,unknown>}` | Self-describing open event record projected from the signed event log |
| `RevenueProjectionConfig` | `{amount_field_path, currency_field_path, recurring_field_path, active_predicate?, event_role_map, cohort_key_path?}` | Society DATA row — drives all field resolution in the reducer |
| `RevenueView` | `{gross_cents, refunds_cents, net_cents, recurring_active_cents, recurring_active_count, by_cohort, by_event_role}` | Projection output, all amounts integer cents, maps open-keyed |
| `ActivePredicate` | `{field_path, active_values}` | Determines if a recurring subscription is active for the recurring aggregate |

## Dependencies

**Depends on:** none (pure TypeScript, zero runtime imports)

**Depended on by:** operator finance surface (bitfield-studio, future); Part A Stripe webhook route (ethos shell, gated)

## Design

The projection is a generic reduce: for each event, look up `event_kind` in `event_role_map` (open Record, never a closed enum), read the amount via `amount_field_path`, fold into buckets. A new provider, new event kind, or different field names = one DATA edit in `ethos-config/revenue-projection-config.json`, zero code change. Passes the Stonehenge test: empty config produces honest-zero output without error.
