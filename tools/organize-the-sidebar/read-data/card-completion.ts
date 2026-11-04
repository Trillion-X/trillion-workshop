// packages/group/read-data/card-completion.ts
//
// THE one "how done is this card?" reading — a pure leaf over a card's own DATA. A card can track
// progress two ways: an explicit METRIC (current toward a target) or a CHECKLIST (tasks ticked). This
// unifies them into a single 0..1 completion so every consumer agrees: the "Sort by progress"
// arrangement, the goal-ROLLUP's per-node fraction, a future card-face progress bar, a report column.
//
// Metric WINS when a card has both (an explicit target is a stronger statement of "done" than a task
// tally). Metric completion is CLAMPED to [0,1] (over-achievement caps at "done", never 1.5 in an
// aggregate); a checklist fraction is already done/total ∈ [0,1]. A card with NEITHER returns undefined
// (nothing to measure — the caller decides whether that sorts last / contributes null to a rollup).
//
// Time-INDEPENDENT (a ratio, never a clock), so it stays a pure `(item) => number | undefined`. Lives in
// read-data (the bedrock, L088) — NOT in a heavy do-work module — so both the arrange comparators and the
// rollup accessor reuse the SAME reading with zero import cycle.

import type { BoardItem } from './group-board-model';
import { metricFromRaw, completion } from './board-metric';
import { checklistFromRaw, checklistProgress } from './board-checklist';

/** A card's unified completion in [0,1]: its metric completion if it has a metric (clamped, target-beat
 *  caps at 1), else its checklist fraction, else undefined (no metric and no checklist → unmeasurable). */
export function cardCompletion(item: BoardItem): number | undefined {
  const metric = metricFromRaw(item.extra?.metric);
  if (metric) return completion(metric);
  const list = checklistFromRaw(item.extra?.checklist);
  return list.length > 0 ? checklistProgress(list).fraction : undefined;
}
