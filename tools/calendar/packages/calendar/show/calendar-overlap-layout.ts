// packages/calendar/show/calendar-overlap-layout.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure column-packing layout for overlapping timed blocks (the Amie/Cron
// anatomy locked in reference/2026-07-19-w11-reference-lock-screen-contract.md
// §6): blocks that overlap in time split the day column into equal-width
// sub-columns ordered by start time; non-overlapping blocks take full width.
// Never a cascade/stagger, never a hash-based lane.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure geometry — input is (id, startMinute, endMinute); no block semantics.
// 2. Deterministic: ties order by start, then end, then id.
// 3. A cluster (maximal set of transitively-overlapping blocks) shares ONE
//    column count, so widths inside a visual clump are uniform.

export type OverlapInput = {
  id: string;
  startMinute: number;
  endMinute: number;
};

export type OverlapPlacement = {
  id: string;
  /** 0-based sub-column inside the cluster. */
  column: number;
  /** Total sub-columns in this block's cluster (denominator for width). */
  columnCount: number;
};

export function packOverlappingBlocks(inputs: OverlapInput[]): OverlapPlacement[] {
  const sorted = [...inputs].sort((left, right) =>
    left.startMinute - right.startMinute
    || left.endMinute - right.endMinute
    || left.id.localeCompare(right.id),
  );

  const placements: OverlapPlacement[] = [];
  let cluster: { item: OverlapInput; column: number }[] = [];
  let clusterEnd = -Infinity;
  let columnEnds: number[] = [];

  const flush = () => {
    const count = columnEnds.length || 1;
    for (const entry of cluster) {
      placements.push({ id: entry.item.id, column: entry.column, columnCount: count });
    }
    cluster = [];
    columnEnds = [];
  };

  for (const item of sorted) {
    if (item.startMinute >= clusterEnd) {
      flush();
      clusterEnd = item.endMinute;
    } else {
      clusterEnd = Math.max(clusterEnd, item.endMinute);
    }
    // First column whose latest block has ended by this start; else a new column.
    let column = columnEnds.findIndex((end) => end <= item.startMinute);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(item.endMinute);
    } else {
      columnEnds[column] = item.endMinute;
    }
    cluster.push({ item, column });
  }
  flush();

  return placements;
}
