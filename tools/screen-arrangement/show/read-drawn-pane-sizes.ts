// packages/screen-arrangement/show/read-drawn-pane-sizes.ts
//
// PURPOSE
// Report the size every tiled pane is drawn at right now, so the arrangement
// owner can give a newly added pane its neighbour's size and push the others
// over instead of narrowing them (keep_drawn_pane_sizes in the slot).
//
// NON-NEGOTIABLE INVARIANTS
// 1. Layout pixels: offsetWidth/offsetHeight ignore the arrangement zoom, the
//    same unit a dragged pane edge records.
// 2. A pane's size is its box in the split (the flex item), or the pane itself
//    when it is the only one.
// 3. Every screen draws the saved split as it is, so a phone reports its
//    drawn sizes the same way a desktop window does.

export type DrawnPaneSizes = Record<string, { w: number; h: number }>

export function readDrawnPaneSizes(): DrawnPaneSizes {
  if (typeof document === 'undefined') return {}
  const sizes: DrawnPaneSizes = {}
  for (const shell of document.querySelectorAll<HTMLElement>('[data-arrangement-viewport-shell]')) {
    for (const pane of shell.querySelectorAll<HTMLElement>('[data-container-id]')) {
      const id = pane.dataset.containerId
      if (!id || sizes[id]) continue
      const box = pane.closest<HTMLElement>('[data-split-child]') ?? pane
      if (!shell.contains(box) || box.offsetWidth <= 0 || box.offsetHeight <= 0) continue
      sizes[id] = { w: box.offsetWidth, h: box.offsetHeight }
    }
  }
  return sizes
}
