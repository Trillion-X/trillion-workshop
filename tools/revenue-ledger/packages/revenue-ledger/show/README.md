# revenue-ledger/show

The translation boundary that turns the internal revenue projection (`RevenueView`) into a finished, human-facing finance display model, plus the reference-grounded operator finance surface that renders it.

## Files

| File | Purpose |
|------|---------|
| `revenue-finance-display.ts` | `presentRevenue(view, options?)` → `RevenueFinanceDisplay` (finished, render-ready finance model) + `humanizeKey`. |
| `revenue-finance-surface.tsx` | `RevenueFinanceSurface({ display })` — pure presentational operator surface (KPI strip + per-offer/per-type breakdowns + honest empty state) built from shared `ui/` primitives. |
| `reference-grounded-screen-contract.md` | The package-ui-reference-lock contract (Whop/Kajabi/Stripe/Mixpanel anatomy, render-state matrix, translation boundary). |
| `__tests__/present-revenue.test.ts` | Model render-state matrix + ordering + DATA labels. 8 tests (node). |
| `__tests__/revenue-finance-surface.test.tsx` | Surface visual proof (jsdom): empty/sparse/dense + no internal-vocabulary leak. 4 tests. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `presentRevenue` | `(view: RevenueView, options?: PresentRevenueOptions) => RevenueFinanceDisplay` | Pure, total translation; every view (incl. empty) yields a well-formed model. |
| `humanizeKey` | `(key: string) => string` | Generic Title-Case of an open data key; names no specific key. |
| `RevenueFinanceDisplay` | `{ metrics: RevenueMetric[]; cohorts: RevenueBreakdownRow[]; roles: RevenueBreakdownRow[]; currency: string }` | The finished model a surface renders verbatim. |
| `RevenueMetric` | `{ id; label; amount_cents; currency; count? }` | One headline KPI reading (gross/refunds/net/recurring). Amount stays integer cents. |
| `RevenueBreakdownRow` | `{ id; label; gross_cents; net_cents; count }` | One per-cohort or per-role row; open shape, no closed enum. |
| `PresentRevenueOptions` | `{ currency?; cohortLabels?: Record<string,string>; roleLabels?: Record<string,string> }` | Presentation DATA; label maps are open (a new label is a data row, not code — L090). |
| `RevenueFinanceSurface` | `({ display: RevenueFinanceDisplay }) => JSX` | Pure presentational surface; `StatStrip` KPIs + breakdown cards + `EmptyPlaceholder`; currency-formats cents at the host boundary. |

## Architecture / Why This Design

**Decoupling (NON-NEGOTIABLE).** This module imports **nothing** from any other package. It does not know whether the finished model will be rendered by `visual-database`, a `metric-row` strip, or a primitive invented later. The data owner (revenue-ledger) produces a finished model **in the consumer's language** (L098); the mapping from `RevenueFinanceDisplay` onto a specific shared surface primitive's input lives at the **composition/surface seam**, never inside revenue-ledger. This keeps revenue-ledger and any surface primitive free of compile-time coupling.

**Presentation vs DATA.** Amounts stay as integer cents — currency/locale string formatting is the renderer's concern, not the data owner's. This keeps the model pure data, deterministic, and unit-testable without a DOM.

**Generic / data-driven.** KPI labels describe the fixed shape of `RevenueView` itself (Physics for this projection), not a business enumeration. Cohort/role labels resolve from open DATA maps with a generic `humanizeKey` fallback — adding a cohort or role never edits this code.

## Render States

`presentRevenue` is total over the render-state matrix, proven in tests:
- **empty** — all-zero view → four zeroed KPI readings, empty cohorts/roles.
- **sparse** — single cohort/role, labels humanized from keys.
- **dense** — many cohorts/roles, sorted highest-gross-first with deterministic tie-break by id.

## Dependencies

**Depends on:** `../read-data/revenue-types` (type-only import of `RevenueView`); the surface additionally uses shared `ui/show` primitives (`StatStrip`, `Card`, `Container`, `Text`, `EmptyPlaceholder`) and `lucide-react` — the shared UI layer, not another feature package (no feature coupling).

**Depended on by:** the composition/surface seam that supplies live events + config → `projectRevenue` → `presentRevenue` → `RevenueFinanceSurface`. The model imports nothing from other feature packages.
