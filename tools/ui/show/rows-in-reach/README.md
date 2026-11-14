# rows-in-reach

A list draws only the rows a person can reach: its first rows at once, then more as the end of the list comes near the
visible edge of its scroller. Every row stays reachable and the list's own search and filter still read every row. A
list of 738 saved logins drew 42,195 nodes inside Home and froze a page (2026-10-07); drawn in reach it draws a
few dozen.

## Files

| File | Purpose |
|------|---------|
| `rows-in-reach.ts` | `useRowsInReach(total, include?, options?)`: how many rows to draw now and the marker to put after the list. |
| `index.ts` | Barrel export. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `useRowsInReach` | `(total: number, include = -1, { first, more, reach_px }?) => RowsInReach` | Draw the first `count` rows; `include` is a row index that must be drawn (a row opened from elsewhere). |
| `RowsInReach` | `{ count: number; marker: ((node: Element \| null) => void) \| null }` | `marker` goes on an element after the list while rows are left; it is null once every row is drawn. |
| `ROWS_IN_REACH` | `{ first: 40, more: 40, reach_px: 1200 }` | The defaults every list shares. |

## Invariants

1. Nothing here knows what a row is: the caller draws its first `count` rows.
2. A row asked for (`include`) is always drawn.
3. Without IntersectionObserver every row is drawn.
4. The marker sits after the list, never inside it, so a grid of cards keeps its layout.

## Why not VirtualList?

`virtual-list/VirtualList.tsx` places rows absolutely in one column: a card grid and rows that open in place do not
fit it. Drawing in reach keeps the list's own flow, and the cost of a page stays bounded by how far the person scrolls.

## Dependencies

**Depends on:** React, the browser's IntersectionObserver.
**Depended on by:** `coss/guide.tsx` (a section's rows and a catalog's list view).
