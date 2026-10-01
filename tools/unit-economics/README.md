# tools/unit-economics/

Works out a business's unit economics (ARPU, gross margin, CAC, LTV, LTV:CAC, payback) from one period's plain numbers: the Workshop tool `tool:work-out-unit-economics`, run in the deployed tool container. Ported from bitfield-packages `packages/unit-economics`; nothing here is imported by the Worker.

## Files

| File | Purpose |
|------|---------|
| `read-data/unit-economics-types.ts` | `UnitEconomicsInput`, `UnitEconomics` (every figure `number \| null`). |
| `read-data/compute-unit-economics.ts` | Pure `computeUnitEconomics(input)`: formulas only, no I/O. |
| `do-work/work-out-unit-economics.mjs` | The tool's command: the period's numbers as JSON in `argv[2]`, one JSON line out (the figures and the input echoed). |
| `records.json` | The tool's row, listed into the Workshop by `tool-rows.json`. |
| `part.json` | No public files: only the container runs this code. |
| `tool-rows.json` | Lists `records.json` into the Workshop (`source:business-unit-economics-tools`). |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|---|---|---|
| `computeUnitEconomics` | `(input: UnitEconomicsInput) => UnitEconomics` | Pure, total period computation. |
| `UnitEconomicsInput` | `{ net_revenue_cents; gross_revenue_cents; cost_of_delivery_cents?; acquisition_spend_cents?; active_customers; new_customers?; avg_lifetime_periods?; churn_rate? }` | Plain numbers. |
| `UnitEconomics` | `{ arpu_cents; gross_margin; cac_cents; ltv_cents; ltv_to_cac; payback_periods; lifetime_periods }` | Null means these numbers cannot give it. |
| `workOutUnitEconomics` | `(input) => UnitEconomics & { input }` | The tool's work, refusing a missing or non-number field by name. |

## Invariants

- A figure is null exactly when its inputs are absent or a denominator is zero, never a made-up 0; with no cost, margin and LTV stay null rather than assuming 100% margin.

## Dependencies

**Depends on:** Node 24 in the tool container (runs the `.ts` files by stripping their types).

**Depended on by:** Trillion's deploy (it reads `tool-rows.json` and bundles the files a row names), the Workshop's container executor, Trillion's `test/business-tools.test.mjs`.
