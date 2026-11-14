# drop-indicator/

The drag-and-drop insertion line: a 2px accent bar that marks where a dragged item will land, fading via opacity in a fixed slot so rows never shift.

## Files

| File | Purpose |
|------|---------|
| `DropIndicator.tsx` | The insertion-line primitive (`active` toggles opacity; zero layout shift) |
| `index.ts` | Barrel export |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `DropIndicator` | `({ active }) => JSX` | Insertion marker for reorderable lists/boards |
| `DropIndicatorProps` | `{ active: boolean }` | Props contract |

## Dependencies

**Depends on:** `@/packages/ui/show/cn`.
**Depended on by:** `@/packages/ui` barrel; visual-database `RecordRow` reorder drags (and any future reorderable surface).

## Invariants

- Generic — no product vocabulary.
- Accent rides `--accent-primary` (blue fallback) — never a hardcoded brand color in consumers.
- Occupies a fixed 2px row at all times; visibility is opacity-only.
