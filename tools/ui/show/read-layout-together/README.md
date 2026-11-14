# parts/ui/show/read-layout-together

Runs the layout reads many parts ask for during one render together, after the render has written the page, so the browser lays the page out once for all of them.

## Files

| File | Purpose |
|------|---------|
| `read-layout-together.ts` | The shared queue: reads asked for in one task run in one microtask flush, in order, before the next paint; a cancelled read never runs. |

## Key types / functions

| Name | Shape | Role |
|------|-------|------|
| `readLayoutTogether` | `(read: () => void) => () => void` | Queue one read; the returned function cancels it (a layout effect's cleanup). |

## Dependencies

**Depends on:** nothing (the platform's `queueMicrotask`).

**Depended on by:** `parts/group/show/item-renderers.tsx` (each note measures its text height through it, so a board of many notes is laid out once).
