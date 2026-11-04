// packages/group/read-data/board-completion.ts
//
// The WHOLE-BOARD completion summary, CARD-EQUAL: how many cards are done and the mean completion across
// every card that tracks progress. The board-level view of the `cardCompletion` SSOT — the same reading
// that drives the "Sort by progress" arrange, the goal rollup, and each card's bottom-edge strip.
//
// This is the UNIFIED sibling of the two existing header readouts: the checklist rollup counts STEPS
// ("18 of 30 steps done" — weights a 10-step card 10x a 1-step card) and the metric summary counts only
// METRIC goals. This counts CARDS — each card gets ONE vote, whether it tracks progress by a metric OR a
// checklist — answering the plainest board question: "what fraction of my cards are done?" Only cards that
// track completion at all are counted (a plain note has no bearing on the total).

import type { BoardItem } from './group-board-model';
import { cardCompletion } from './card-completion';

export interface BoardCompletion {
  /** Cards that track completion (have a metric OR a non-empty checklist). Plain notes are excluded. */
  readonly tracked: number;
  /** Of the tracked cards, how many are 100% complete. */
  readonly complete: number;
  /** Mean completion across the tracked cards, 0..100 (whole percent). 0 when nothing is tracked. */
  readonly avgPct: number;
}

/** Aggregate every card's unified `cardCompletion` into the board-level card-equal summary. */
export function boardCompletion(items: readonly BoardItem[]): BoardCompletion {
  let tracked = 0;
  let complete = 0;
  let sum = 0; // sum of EXACT completions (0..1); averaging rounded percents would double-round
  for (const item of items) {
    const f = cardCompletion(item);
    if (f === undefined) continue;
    tracked += 1;
    sum += f;
    if (f >= 1) complete += 1;
  }
  return { tracked, complete, avgPct: tracked === 0 ? 0 : Math.round((sum / tracked) * 100) };
}
