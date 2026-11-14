# Reference-Grounded Screen Contract — Revenue Finance Surface

Per `.claude/rules/1000x-package-ui-reference-lock.md`: UI implementation is illegal until this contract exists.

## Live package + boundary

- Package: `revenue-ledger` (`dev/bitfield-packages/packages/revenue-ledger/`).
- Boundary file: `things-to-store-and-run.json`.
- Data source: `presentRevenue(RevenueView)` → `RevenueFinanceDisplay` (`show/revenue-finance-display.ts`). `RevenueView` comes from `projectRevenue(payment events, config)`.

## Product job + dominant action

The operator wants to answer, in one glance: **"How much money is coming in, net of refunds, and where is it coming from?"** The dominant action is *reading* — scanning headline totals, then drilling into which offers and which payment types drive them. No editing; this is an observability surface.

## Capability inventory (what the screen must expose)

- Headline KPIs: gross revenue, refunds, net revenue, recurring (MRR) + active count — from `display.metrics`.
- Per-offer breakdown — from `display.cohorts` (highest gross first).
- Per-payment-type breakdown — from `display.roles`.
- Honest empty/zero state when no revenue exists yet.

## Reference inventory (opened via Mobbin MCP, web, 2026-06-26)

| App | Screen | Anatomy borrowed |
|-----|--------|------------------|
| Whop | [Milestones dashboard](https://mobbin.com/screens/c647e37e-5faa-4aa3-951e-4f34565a858b) | KPI tiles (MRR/ARR/Gross — big number) + "Payments breakdown" labeled rows (Paid/Refunded/Failed + $ and %). |
| Kajabi | [Net Revenue](https://mobbin.com/screens/7093fb4a-f880-4948-9f8d-08e53fb352c6) | All-time big number; Revenue/Refunds by offer; Summary table; **"No Data" honest empty state + skeleton rows**. |
| Stripe | [Billing/MRR](https://mobbin.com/screens/63cb4560-7a4b-4d47-9952-d02c9d113a19) | MRR-by-product table; retention (churn rate, churned revenue). |
| Mixpanel | [SaaS KPIs](https://mobbin.com/screens/22eb1fe3-2c20-4547-9292-49520fc7feee) | MRR composition by plan / by segment — breakdown-of-a-total pattern. |

## Reference-derived anatomy

- **KPI strip** at the top: 4 quiet tiles (label over a big formatted currency value). → reuse `ui/show/stat-strip` `StatStrip` (2–4 stats, pre-formatted value strings).
- **Breakdown sections** below: labeled-value rows (label left, money right), one section per breakdown (by offer, by type) — the Whop "payments breakdown" anatomy. → `ui/show/card` `Card` + `ui/show/container` `Container` + `ui/show/text` `Text`.
- **Empty state**: icon + calm message when there is no revenue (the Kajabi "No Data" pattern). → `ui/show/empty-placeholder` `EmptyPlaceholder`.
- Currency-formatted numerals; money right-aligned against labels.

## Data-to-human translation boundary

- Amounts are integer cents in the model; the surface formats them with `Intl.NumberFormat` (currency) — formatting is the renderer's job.
- Labels are already human in the model (`metrics[].label`; cohort/role labels humanized via DATA + `humanizeKey`). **Banned internal terms** in the UI: `cents`, `event_role`, `by_cohort`, `RevenueView`, `gross_cents`, role tokens (`add`/`subtract`). The surface shows "Gross revenue", "By offer", offer names.

## Shared primitive inventory (reuse, do not duplicate)

`StatStrip`, `Card`, `Container`, `Text`, `EmptyPlaceholder` — all from `packages/ui/show`. No new shared primitive needed; no package-local CSS.

## Render-state matrix

| State | Behavior |
|-------|----------|
| empty (all metrics 0, no breakdowns) | `EmptyPlaceholder` — "No revenue yet…" |
| sparse (some revenue, one offer/type) | KPI strip + one breakdown card |
| dense (many offers/types) | KPI strip + both breakdown cards, highest-first |
| (loading / error handled upstream by the mount/model: `presentRevenue` is total) | — |

## Visual proof

- **This pass:** jsdom render-state-matrix test (`__tests__/revenue-finance-surface.test.tsx`) renders empty/sparse/dense and asserts the human-visible output (no internal vocabulary).
- **Remaining (live-ops):** browser screenshot once the surface is mounted live with real revenue data (gated on a real charge + composition-seam wiring of events + config → `presentRevenue`).
