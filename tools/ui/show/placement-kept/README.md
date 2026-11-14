# placement-kept

What a screen keeps about itself in the place it is put (a pane, a piece of an arranged screen): its selection, grouping, view and depth, as DATA in the placement's own input under `kept`, so each placement of one screen keeps its own and the arrangement saves it everywhere.

## Files

| File | Purpose |
|------|---------|
| `placement-kept.ts` | The one key (`kept`), the one event a screen keeps with, and the reader and listener. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `KEPT_KEY` | `'kept'` | Where a placement's input holds what its screen kept. |
| `KEEP_EVENT` | `'trillion:placement-keep'` | Bubbles from the screen's element with `{ kept }`. |
| `keptIn` | `(input?) => Kept` | What the placement kept, or `{}`. |
| `keepInPlacement` | `(element, kept) => void` | A screen keeps its whole `kept` (left out = forgotten). |
| `hearKept` | `(host, heard) => () => void` | Whoever holds placements hears what is kept inside them. |

## Dependencies

**Depends on:** nothing.

**Depended on by:** `parts/screen-arrangement/show/ContainerHost.tsx` (writes `kept` into the pane's tab through `updateTabMeta`), `parts/ui/show/source-bytes-screen-mount/SourceBytesScreenMount.tsx` (a screen's own `kept` never remounts it), `src/workspace/record-set-screen.tsx` (a record set keeps its rules, grouping, view and depth).
