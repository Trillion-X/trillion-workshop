// parts/ui/show/hour-grid/neighbor.d.mts
//
// PURPOSE
//   The types of neighbor.mjs, so HourGrid.tsx reads the pure focus-neighbour function typed.

export function neighborKey(
  lanes: { key: string; items: { key: string; startMinute: number; column?: number }[] }[],
  from: string,
  direction: 'up' | 'down' | 'left' | 'right',
): string | null;
