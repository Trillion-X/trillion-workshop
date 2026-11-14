// parts/ui/show/rows-in-reach/rows-in-reach.ts
//
// NO PRIOR: searched parts/ui/show for the job (drawing only part of a long list): virtual-list/VirtualList.tsx windows
// one column of absolutely placed rows (a card grid and rows that open in place do not fit it), record-views/windowing.ts
// windows a table, gallery or board by a measured pitch, and coss/thread.tsx windows posts through VirtualList. Nothing
// let a list whose rows flow in a grid and open in place draw only the rows a person can reach.
//
// PURPOSE
//   A list draws the rows within reach of the screen, then more as the person scrolls toward its end: the first `first`
//   rows at once, and `more` each time the end marker comes within `reach_px` of the scroller's visible edge. Every row
//   stays reachable (scroll), and the list's own search and filter still read every row, since only the drawing is
//   bounded. A page with 738 saved logins drew 42,195 nodes inside Home and froze (2026-10-07); drawn in reach
//   it draws a few dozen.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows what a row is: the caller hands a count and draws its first `count` rows itself.
//   2. A row the caller asks to show (`include`, an index) is always within `count`, so a row opened from elsewhere is drawn.
//   3. Where the page cannot watch reach (no IntersectionObserver), every row is drawn: never fewer rows than can be seen.
//   4. The marker sits after the list, never inside it, so a list's own layout (a grid of cards) is unchanged.
//   5. Reach is measured against the ancestor that really scrolls: one only marked scrollable but as tall as what it
//      holds shows every row, so it is passed over. Measured against such a box (a Connections screen placed whole
//      inside Waiting on you), the marker was always in reach and every one of 738 rows was drawn (2026-10-07).
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import React from 'react';

/** How many rows a list draws at once, how many it adds, and how far ahead of the visible edge it reaches. */
export const ROWS_IN_REACH = { first: 40, more: 40, reach_px: 1200 } as const;

/** The nearest ancestor that scrolls vertically and holds more than it shows, or null for the page itself (invariant 5). */
function scrollerOf(node: Element | null): Element | null {
  for (let parent = node?.parentElement ?? null; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return null;
}

export type RowsInReach = {
  /** How many of the list's rows to draw now. */
  count: number;
  /** Put on an element after the list while `count` is below the total; null when every row is drawn. */
  marker: ((node: Element | null) => void) | null;
};

/** The rows of a `total`-row list to draw now (invariants 1 to 4). `include` is the index of a row that must be drawn. */
export function useRowsInReach(total: number, include = -1, { first = ROWS_IN_REACH.first, more = ROWS_IN_REACH.more, reach_px = ROWS_IN_REACH.reach_px } = {}): RowsInReach {
  const watching = typeof IntersectionObserver === 'function';
  const [drawn, setDrawn] = React.useState(first);
  const [node, setNode] = React.useState<Element | null>(null);
  const count = watching ? Math.min(total, Math.max(drawn, include + 1)) : total;
  const left = count < total;
  React.useEffect(() => {
    if (!left || !node) return undefined;
    // Watched afresh each time more are drawn: a marker still in reach after drawing more asks again at once.
    const watch = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setDrawn(now => Math.max(now, count) + more);
    }, { root: scrollerOf(node), rootMargin: `0px 0px ${reach_px}px 0px` });
    watch.observe(node);
    return () => watch.disconnect();
  }, [left, node, count, more, reach_px]);
  return { count, marker: left ? setNode : null };
}
