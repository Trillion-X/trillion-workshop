# metric-row/

A horizontal strip of labeled metric cells joined by 1px hairline dividers — the dense, quiet supporting-metrics row (fey.com stock-detail anatomy: `Mkt cap | P/E | EPS`).

## Files

| File | Purpose |
|------|---------|
| `MetricRow.tsx` | The strip + `MetricCell`/`MetricRowProps`/`MetricCellTone` types. Pure renderer — caller pre-formats every value and picks each cell's tone; empty cells list → null. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `MetricCell` | `{ label, value, tone?, mono? }` | One cell: tiny muted label over a value. `tone` = neutral/success/error. `mono` (default `true`) = mono+tabular numerals; set `false` for a categorical text value (e.g. a state label) so words render in the proportional font. |
| `MetricCellTone` | `'neutral' \| 'success' \| 'error'` | Value tone — gain/loss/default. |
| `MetricRowProps` | `{ cells, align?, className? }` | `align` = `'between'` (default, even spacing) or `'start'` (hug left). |
| `MetricRow` | `({ cells, align?, className? }) → JSX` | Renders the hairline-divided strip. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn`, `@/packages/ui/show/text` (`Text`).
**Depended on by:** `packages/visual-database/show/MetricView.tsx` (metric-strip composition), the `ui` barrel.

## Why This Design?

Values are mono+tabular by default (the financial-numeral discipline — digit columns align). `mono` is per-cell DATA so a categorical value ("Locked in") opts into the proportional font without the row learning any domain (L090): the caller sets `mono` from the value's own shape (numeric-leading → mono). Hairline dividers only, never card chrome — this row lives inside a section.
