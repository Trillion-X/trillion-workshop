// packages/group/do-work/board-finish-line-actions.ts
//
// The GRAPH bridge for the FINISH-LINE lens — the THIRD configuration of the ONE weighted-signal engine
// (read-data/board-weighted-signals), after "Needs attention" (risk) and "On a roll" (momentum). It feeds
// that blind engine a DATA registry `FINISH_LINE_SIGNALS` whose members are PROXIMITY-TO-DONE only —
// nothing about deadlines, effort, or streaks. That is what makes it a genuinely distinct lens, not a
// slice of momentum: the score is the closeness itself, so a goal 98% done but UNTOUCHED for weeks ranks
// #1 here, whereas momentum buries it under a 76%-done goal that was worked on today (momentum weights the
// recent effort). This is the "what can I CLOSE OUT?" list — the highest-ROI move on a goal board is
// finishing something already almost finished. Every signal is DERIVED from the already-shipped metric +
// checklist leaves; adding a signal is ONE row (L069/L090/enum-dissolution). Connectors + furniture are
// never targets — you finish CONTENT.
//
// Item-local by contract: a signal reads ONE card's DATA (the engine hands `(item, now)`), so a
// hierarchy-aware "sub-goals nearly all done" (rollup) signal is deliberately NOT here — rollup needs the
// sibling graph + the board's relation spec, which this per-card contract does not carry. Adding graph
// context is a separate primitive extension, not a fake per-card signal.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import { type WeightedSignal, type SignalScore, weightedSignalScore, rankByWeightedSignals } from '../read-data/board-weighted-signals';
import { metricFromRaw, completion, isComplete as metricIsComplete } from '../read-data/board-metric';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist';

/** A goal/checklist counts as "nearly complete" at/above this fraction — shared with the momentum lens. */
const NEAR_COMPLETE_FRACTION = 0.75;

/** A signal descriptor: how to derive ONE finish-line signal for a card from the other primitives' DATA. */
interface FinishLineSignalDef {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  /** Returns 0..1 (0 = inactive) from the card's DATA. `now` is unused here (proximity is clock-free) but
   *  kept in the signature so the registry matches the engine's `(item, now)` contract. */
  readonly compute: (item: BoardItem, now: number) => number;
}

/**
 * The finish-line signal registry — PROXIMITY-TO-DONE only. Magnitude is the EXACT completion fraction, so
 * the engine's weighted sum orders cards by how close they are to done (a nearer card scores higher). A
 * fully-complete track contributes nothing (it is already finished — not a finish-line CANDIDATE). Below
 * the threshold it is not "almost there" yet, so it stays off this list. Add a proximity signal → add a
 * row; the blind engine never changes.
 */
export const FINISH_LINE_SIGNALS: readonly FinishLineSignalDef[] = [
  {
    key: 'metric-almost-done',
    label: 'Metric almost done',
    weight: 1,
    compute: (item) => {
      const metric = metricFromRaw(item.extra?.metric);
      if (metric === null || metricIsComplete(metric)) return 0;
      const c = completion(metric); // EXACT 0..1 (not display-rounded) — the ranking key, no boundary wobble
      return c >= NEAR_COMPLETE_FRACTION ? c : 0;
    },
  },
  {
    key: 'checklist-almost-done',
    label: 'Checklist almost done',
    weight: 1,
    compute: (item) => {
      const p = checklistProgress(checklistFromRaw(item.extra?.checklist));
      return p.total >= 2 && !p.complete && p.fraction >= NEAR_COMPLETE_FRACTION ? p.fraction : 0;
    },
  },
];

/** An item is a finish-line TARGET iff it is real content, not a connector or furniture. */
export function itemIsFinishLineTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** Derive one card's finish-line signals from the registry (all signals; the engine filters the inactive). */
export function itemFinishLineSignals(item: BoardItem, now: number): WeightedSignal[] {
  return FINISH_LINE_SIGNALS.map((def) => ({ key: def.key, label: def.label, weight: def.weight, magnitude: def.compute(item, now) }));
}

/** One card's finish-line verdict (score = proximity to done + the reasons). */
export function finishLineOf(item: BoardItem, now: number): SignalScore {
  return weightedSignalScore(itemFinishLineSignals(item, now));
}

/** One finish-line row: the item + a human label + its score + the reason labels (strongest first). */
export interface FinishLineRankRow {
  readonly memberId: string;
  readonly label: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

function labelOf(items: readonly BoardItem[]): (id: string) => string {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  return (id: string): string => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
}

/**
 * The "Almost there" rows — every content card that is nearly (but not fully) done, CLOSEST first, each
 * with the reasons that fired. `now` is injected (unused — proximity is clock-free — but kept for a
 * uniform bridge signature). Pure read-model composing the shipped metric + checklist leaves through the
 * shared blind engine.
 */
export function finishLineRows(items: readonly BoardItem[], now: number): FinishLineRankRow[] {
  const label = labelOf(items);
  const targets = items.filter(itemIsFinishLineTarget);
  return rankByWeightedSignals(targets, (it) => itemFinishLineSignals(it, now)).map(
    (r): FinishLineRankRow => ({
      memberId: r.item.memberId,
      label: label(r.item.memberId),
      score: Math.round(r.result.score * 100) / 100,
      reasons: r.result.reasons.map((reason) => reason.label),
    }),
  );
}
