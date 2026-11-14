// parts/ui/show/hour-grid/neighbor.mjs
//
// PURPOSE
//   Which pill an arrow key moves focus to. Up and down walk the pills of one lane in the order they are drawn (by
//   start, then by overlap column); left and right go to the nearest lane that holds a pill and take the pill whose
//   start is closest to the one focused (the earlier on a tie). Pure functions over plain lane data, so the tests prove
//   them without a page and HourGrid.tsx only moves the focus.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing here knows what a pill is: { key, startMinute, column? } in lanes of { key, items } is all it reads.
//   2. It never wraps and never invents a target: at the first or last pill, or past the last lane, it answers null and
//      focus stays where it is.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

const order = (a, b) => a.startMinute - b.startMinute || (a.column ?? 0) - (b.column ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * The key of the pill an arrow moves focus to from the pill `from`, or null.
 * @param {{ key: string, items: { key: string, startMinute: number, column?: number }[] }[]} lanes
 * @param {string} from
 * @param {'up' | 'down' | 'left' | 'right'} direction
 */
export function neighborKey(lanes, from, direction) {
  const laneIndex = lanes.findIndex(lane => lane.items.some(item => item.key === from));
  if (laneIndex < 0) return null;
  const sorted = [...lanes[laneIndex].items].sort(order);
  const index = sorted.findIndex(item => item.key === from);
  if (direction === 'up') return sorted[index - 1]?.key ?? null;
  if (direction === 'down') return sorted[index + 1]?.key ?? null;
  const step = direction === 'left' ? -1 : 1;
  for (let next = laneIndex + step; next >= 0 && next < lanes.length; next += step) {
    const candidates = lanes[next].items;
    if (!candidates.length) continue;
    const start = sorted[index].startMinute;
    return [...candidates].sort((a, b) => Math.abs(a.startMinute - start) - Math.abs(b.startMinute - start) || order(a, b))[0].key;
  }
  return null;
}
