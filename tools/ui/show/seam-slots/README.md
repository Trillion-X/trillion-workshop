# ui/show/seam-slots

The room a thing takes on a seam of the window's arrangement (the line between two panes): a thing claims the seam with its thickness, the arrangement that holds the window's panes lays a slot of that thickness there so the panes beside it give up exactly that room, and the thing draws itself into the slot.

## Files

| File | Purpose |
|---|---|
| `seam-slots.ts` | Claims, slots and the shown-seams reader: one seam, one slot, the newest claim wins; a slot says which way it lies (`axis`). |
| `index.ts` | Public exports. |

## Key types / functions

| Name | Signature / shape | Role |
|---|---|---|
| `SeamClaim` | `{ seam: DockSeam; thickness: number }` | One thing's hold on one seam. |
| `SeamSlot` | `{ element; axis: 'vertical' \| 'horizontal' }` | The slot the arrangement laid, and which way it lies. |
| `claimSeam` | `(owner: symbol, claim: SeamClaim \| undefined) => void` | Claim a seam, or leave it (undefined). |
| `useSeamClaims` | `() => readonly SeamClaim[]` | The arrangement reads the claims to lay slots. |
| `placeSeamSlot` | `(seam, slot \| null) => void` | The arrangement hands back (or takes back) a slot's element. |
| `useSeamSlot` | `(seam \| undefined) => SeamSlot \| null` | The thing reads its slot to draw into it. |
| `ShownSeam`, `readShownSeams` | `(root?) => ShownSeam[]` | The seams on screen now with their rectangles, for a drag to find the seam under the pointer. |
| `SEAM_MARK`, `seamMark` | `'data-seam-of'`, `(seam) => string` | The attribute a seam's element carries. |

## Dependencies

**Depends on:** react, `../dockable-placement` (`DockSeam`, `decodeDockSeam`, `dockSeamKey`).
**Depended on by:** `parts/screen-arrangement/show/SplitTreeArranger.tsx` (lays slots when `windowSeams`), `parts/sidebar/show/DesktopSidebar.tsx` and `place-drag.tsx` (the sidebar on a seam).

## Invariants

- A seam is named by its split's path and the child it follows, never a pane or a screen.
- Only the arrangement holding the window's panes lays slots; one drawn inside a screen lays none.
- The thing reads the slot's `axis`, never the device or the window's width.
