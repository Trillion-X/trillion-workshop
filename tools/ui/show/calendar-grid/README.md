# calendar-grid

Domain-blind date-bucket grid primitive.

## Files

| File | Purpose |
|------|---------|
| `CalendarGrid.tsx` | Fixed-column grid (default 7 = a week) of date cells with an optional column-header row, per-cell state (current/selected/muted/disabled/dropTarget), a `density` CVA variant, and a `renderCell` render-prop slot for arbitrary content. A cell with slot content is a `gridcell` holding its own day button beside the content (never content inside a button), so the content may be interactive or draggable. |
| `index.ts` | Barrel re-export of `CalendarGrid` and its types. |

## Key Types

| Type | Shape / Signature | Role |
|------|-------------------|------|
| `CalendarGridProps` | `{ cells; columns?=7; columnLabels?; density?; countLimit?=3; ariaLabel; className?; onSelectCell?; renderCell? }` | Component props. |
| `CalendarGridCell` | `{ key; label?; ariaLabel?; count?; muted?; current?; selected?; disabled?; dropTarget? }` (`count` draws a badge, `countLimit+` above the limit; `dropTarget` rings the cell a drag would land on) | One date cell; identity + visual state only. Every cell carries `data-calendar-cell-key`. |
| `CalendarGridDensity` | `'comfortable' \| 'compact' \| 'picker'` (`picker` = square date-picker cells for narrow containers) | Cell-sizing variant owned by this primitive (L088 bedrock). |

## Dependencies

**Depends on:** `class-variance-authority`, `@/packages/ui/show/cn`.
**Depended on by:** feature packages needing a month/week date grid (e.g. `timed-action`), `../coss/time-slot-picker.tsx` (picker density), `../schedule-calendar` (the month board with draggable cards).

## Rule

This primitive knows nothing about what a cell contains. All visible strings
(`label`, `columnLabels`, `ariaLabel`) are caller-supplied; all content arrives
through `renderCell`. Selection is routed (`onSelectCell` fires the cell key) —
selection truth lives with the caller. Zero domain vocabulary lives here.
