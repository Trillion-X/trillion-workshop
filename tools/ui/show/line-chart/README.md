# line-chart/

Fey-grade thin single-weight price line chart with a soft gradient area fill — the canonical trend line for every trading surface (market, account, order).

## Files

| File | Purpose |
|------|---------|
| `LineChart.tsx` | The `LineChart` component, its CVA height variants, and pure geometry projection. |

## Key Types / Functions

| Type / Export | Signature / Shape | Role |
|---------------|-------------------|------|
| `LineChart` | `forwardRef<SVGSVGElement, LineChartProps>` | Renders the line + gradient + optional axis/range row. |
| `lineChartVariants` | CVA — `height: xs \| sm \| md \| lg \| xl` | Height presets; width always fills the container. |
| `LineChartProps` | `{ points, tone?, fill?, strokeWidth?, showAxis?, formatValue?, ranges?, activeRange?, onRangeChange?, emptyTitle?, emptyDescription?, loading? }` | Glyph tier = `points`+`tone`+`height`; hero tier adds `showAxis`+`ranges`. |
| `LineChartPoint` | `number \| { value: number; t?: number }` | Bare number (glyph) or `{value,t}` (carries epoch-ms for x-axis time labels). |
| `LineChartRange` | `{ id: string; label: string }` | One selectable timeframe in the plain-text range row. |
| `LineChartTone` | `'success' \| 'error' \| 'neutral'` | Drives stroke + gradient color (derived from first→last delta if omitted). |

## Two usage tiers (one primitive)

- **Glyph** (account spark, order spark): `points` + `tone` + a small `height`. No axis, no range row.
- **Hero** (fey market chart): additionally `showAxis` (minimal price/time labels), `formatValue`, and a plain-text `ranges` row with `activeRange` + `onRangeChange`. Active range bright, rest dim — never chunky pills.

The hero props are all optional/additive, so glyph callers are untouched: this is the single canonical line chart (no second source).

## Invariants

- NEVER a barcode — one continuous hairline stroke (`vector-effect: non-scaling-stroke`), never bars/candles.
- NEVER invents points — `< 2` points renders an honest empty state (or a soft shimmer when `loading`).
- Pure component — no data reads, no durable state, geometry only. The caller owns the series and tone.

## Dependencies

**Depends on:** `class-variance-authority`, `tools/ui/show/cn`.
**Depended on by:** `tools/live-market-prices` (hero), and any trading surface needing a quiet trend (account/order glyphs).
