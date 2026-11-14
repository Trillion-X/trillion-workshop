# read-data

Pure projection logic and canonical types for the revenue-ledger package.

## Files

| File | Purpose |
|------|---------|
| `revenue-types.ts` | All exported types: `PaymentEvent`, `RevenueProjectionConfig`, `ActivePredicate`, `RevenueView`, `CohortBucket`, `RoleBucket` |
| `project-revenue.ts` | `projectRevenue(events, config)` — pure config-driven reducer, no hardcoded field names |

## Key Types / Functions

| Name | Signature | Role |
|------|-----------|------|
| `projectRevenue` | `(events: PaymentEvent[], config: RevenueProjectionConfig) => RevenueView` | Reduces a payment event stream into a revenue view using config-specified field paths and role map |
| `PaymentEvent` | `{event_id, occurred_at, event_kind, attributes}` | Open self-describing event; `attributes` is `Record<string,unknown>` |
| `RevenueProjectionConfig` | see revenue-types.ts | Society DATA shape — all field paths come from here |

## Dependencies

**Depends on:** none

**Depended on by:** `__tests__/project-revenue.test.ts`; future operator finance surface via package entry
