// packages/group/show/board-history.ts
//
// The board navigation-history leaf — pure, zero I/O. A back-stack of previously-viewed
// boardIds so a board change (switcher OR the #218 board-link chip) has a way back, instead
// of being a one-way trip. Every `switchBoard` pushes the board it left; "Back" pops the
// most-recent still-active board. Kept pure so the transitions are unit-tested; the panel
// holds only the React state.

// The stack with `from` pushed — unless `from` is absent (nothing to go back to) or equals
// `to` (a no-op switch to the same board leaves no history entry).
export function pushBoardHistory(
  stack: readonly string[],
  from: string | undefined,
  to: string,
): readonly string[] {
  return from && from !== to ? [...stack, from] : stack;
}

// Pop the most-recent entry that is still an ACTIVE board (skipping archived/deleted ones —
// self-healing) and is not the current board. Returns the board to land on (or none) plus
// the remaining stack with the consumed/skipped entries removed.
export function popBoardHistory(
  stack: readonly string[],
  activeIds: ReadonlySet<string>,
  current: string,
): { target?: string; rest: readonly string[] } {
  const rest = [...stack];
  while (rest.length > 0) {
    const cand = rest.pop() as string;
    if (cand !== current && activeIds.has(cand)) return { target: cand, rest };
  }
  return { rest };
}
