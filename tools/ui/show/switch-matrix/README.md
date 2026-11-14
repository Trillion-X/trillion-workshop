# Switch matrix

One table of on/off switches: rows (kinds of thing) by columns (ways or places). A fixed-width label column that stays put while the columns scroll sideways, equal-width columns so every switch sits under its heading, and a fade at the edge when more columns are past it. Built on the shared `Table` and `Switch`.

## Files

| File | Purpose |
|------|---------|
| `SwitchMatrix.tsx` | The matrix; measures whether columns run past the edge (`data-more`). |
| `index.ts` | Public exports. |
| `README.md` | This file. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `SwitchMatrixColumn` | `{ id, label }` | A column heading. |
| `SwitchMatrixRow` | `{ id, label, on: string[] }` | A row and the column ids switched on. |
| `SwitchMatrixProps` | `{ columns, rows, onChange(row, columnId, on), labelWidth?, cellWidth?, label? }` | Widths in CSS pixels (224 and 112 by default). |

## Usage

```tsx
import { SwitchMatrix } from '../../parts/ui';

<SwitchMatrix label="What it tells you about" columns={ways} rows={kinds} onChange={(row, id, on) => save(row, id, on)} />
```

## Accessibility

- Row labels are row headers; every switch is named "<row>: <column>".
- When columns scroll, the scroller is a focusable, named region.

## Appearance

`screen-look/show/switch-matrix.css`: sticky label column, fixed cell widths, centred switches, right-edge fade while `data-more`.
