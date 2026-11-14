# parts/ui/show/comparison-table

A side-by-side table of plans: one row per feature, one column per plan, ticks and crosses or a value in each cell.

## Files

| File | Purpose |
|------|---------|
| `ComparisonTable.tsx` | The table, its cell marks, and its styles (comfortable and compact densities, phone widths). |

## Key Types / Functions

| Export | Shape | Role |
|--------|-------|------|
| `ComparisonTable` | `{ caption, featureHeading, columns, rows, density?: 'comfortable' \| 'compact' }` | Renders the table; `compact` tightens rows and type for a table under fuller cards. |
| `ComparisonColumn` | `{ id, name, detail?, highlighted? }` | One plan column; a highlighted column is tinted with `--plan-accent`. |
| `ComparisonRow` | `{ id, label, cells: ComparisonCell[] }` | One feature row. |
| `ComparisonCell` | `{ included, value? }` | A tick, a cross, or a value (values may break after a slash). |

## Dependencies

**Depends on:** `lucide-react` (tick and cross); theme roles `--plan-accent`, `--border-primary`, `--surface-base`, `--text-primary`, `--text-secondary`; font token `--font-display`.
**Depended on by:** the gettrillion.ai red-thread landing (`trillion-site/src/designs/2026-09-27-red-thread`).
