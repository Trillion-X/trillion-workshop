# tools/revenue-ledger/

Adds up revenue, refunds, net revenue and active recurring revenue from any provider's payment events, read through the caller's own field paths: the Workshop tool `tool:add-up-revenue`, run in the deployed tool container. Ported from bitfield-packages `packages/revenue-ledger` (its read side; the finance screen was not brought in); nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/revenue-types.ts` | `PaymentEvent`, `RevenueProjectionConfig`, `RevenueView` and its buckets. |
| `read-data/project-revenue.ts` | Pure `projectRevenue(events, config)`: field paths and event roles come from config, never from code; bad amounts, duplicates and conflicting amounts go to `review`. |
| `do-work/add-up-revenue.mjs` | The tool's command: `{ payments, how_to_read }` in `argv[2]`, one JSON line out (the RevenueView plus `payments_read`). |
| `records.json` | The tool's row, listed into the Workshop by `tool-rows.json`. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-revenue-tools`). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `projectRevenue` | `(events: PaymentEvent[], config: RevenueProjectionConfig) => RevenueView` | The reducer. |
| `RevenueProjectionConfig` | `{ amount_field_path; currency_field_path; recurring_field_path; event_role_map; active_predicate?; cohort_key_path? }` | Where each fact lives and which kinds add, subtract or are ignored. |
| `RevenueView` | `{ gross_cents; refunds_cents; net_cents; recurring_active_cents; recurring_active_count; by_cohort; by_event_role; review }` | Whole cents and open maps. |
| `addUpRevenue` | `({ payments, how_to_read }) => RevenueView & { payments_read }` | The tool's work, listing every input problem at once. |

## Invariants

- An event kind not in `event_role_map` is ignored, never guessed; money is integer cents.

## Dependencies

**Depends on:** Node 24 in the tool container.

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's container executor, Trillion's `test/business-tools.test.mjs`.
