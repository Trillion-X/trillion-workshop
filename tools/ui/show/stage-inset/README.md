# parts/ui/show/stage-inset

The one owner of the room docked chrome keeps at the window's edges: each docked thing (the sidebar, the message box) adds its size to `--stage-inset-<edge>` on one owner element, and the arrangement stage lays itself out inside. Extracted from the sidebar so every dockable thing shares one sum.

## Files

| File | Purpose |
|------|---------|
| `stage-inset.ts` | Register, update and leave the sum; tells each registrant the insets of everything registered before it. |
| `index.ts` | Public exports (declared public in `parts/ui/part.json`). |
| `README.md` | This file. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `registerStageInset` | `(owner: HTMLElement, id: symbol, onPlace?: (before: StageInsets) => void) => void` | Joins with nothing reserved; `onPlace` hears where to sit whenever the sum moves. |
| `updateStageInset` | `(owner, id, { position, size, dragging }) => void` | This thing's edge and size. |
| `unregisterStageInset` | `(owner, id) => void` | Leaves; the last one out restores what another layout owner had set before. |
| `StageInsetContribution` | `{ position: DockPosition; size: number; dragging: boolean }` | One thing's reserved room. |
| `StageInsets` | `Record<'left' \| 'right' \| 'top' \| 'bottom', number>` | Pixels per edge. |

## Invariants

- A thing contributes only its own edge and size; the owner sums over the baseline another owner set before the first one joined.
- A later thing sits beside earlier ones (it is told their insets), never under them.
- The stage moves in one step (`--stage-inset-transition: none`).

## Dependencies

**Depends on:** `../dockable-placement` (the `DockPosition` type).
**Depended on by:** `parts/sidebar/show/DesktopSidebar.tsx`, `../composer/Composer.tsx` (docked to an edge).
