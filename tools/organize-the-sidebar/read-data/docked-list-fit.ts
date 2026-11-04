// parts/sidebar/read-data/docked-list-fit.ts
//
// PURPOSE
// Whether a list docked beside the work leaves the work room to be used. The list is measured, never the device: the
// room along the docked axis, minus what the list would take there, against the smallest pane the work can be used in
// (screen-arrangement's minUsableContainerWidthPx(), the size the person's screens keep their layout at, for a list docked left or right). A list whose open size leaves
// too little floats over the work when opened instead of pushing it aside; a list whose collapsed rail also leaves too
// little shows only a button that opens it, so the work keeps the whole width.
//
// NON-NEGOTIABLE INVARIANTS
// 1. The answer depends only on the numbers given: the same room, sizes and minimum answer the same everywhere, a
//    phone, a narrow desktop window or a panel inside the work.
// 2. The open list and the collapsed rail are judged separately, each by what it would take.
// 3. Room not yet measured (undefined) answers beside/rail: nothing moves until there is a measurement.

/** How the open list and the collapsed list sit against the work. */
export interface DockedListFit {
  /** `beside`: the open list takes its room from the work. `over`: it floats over the work and leaves it whole. */
  readonly open: 'beside' | 'over';
  /** `rail`: the collapsed list keeps its rail beside the work. `button`: only a button that opens it, over the work. */
  readonly closed: 'rail' | 'button';
}

export interface DockedListMeasure {
  /** The room along the docked axis, list and work together, in pixels; undefined before it was measured. */
  readonly room: number | undefined;
  /** What the open list takes of that room. */
  readonly openSize: number;
  /** What the collapsed rail takes of it. */
  readonly railSize: number;
  /** The smallest the work may be and still be used. */
  readonly workMinimum: number;
}

/** Whether the work keeps at least its minimum beside a list of this size. */
export function leavesWorkUsable(room: number, listSize: number, workMinimum: number): boolean {
  return room - listSize >= workMinimum;
}

/** How the list sits against the work at this room. */
export function dockedListFit({ room, openSize, railSize, workMinimum }: DockedListMeasure): DockedListFit {
  if (room === undefined) return { open: 'beside', closed: 'rail' };
  return {
    open: leavesWorkUsable(room, openSize, workMinimum) ? 'beside' : 'over',
    closed: leavesWorkUsable(room, railSize, workMinimum) ? 'rail' : 'button',
  };
}
