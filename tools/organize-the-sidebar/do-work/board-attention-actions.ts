// packages/group/do-work/board-attention-actions.ts
//
// The GRAPH bridge for the attention primitive (read-data/board-attention): assemble each card's DERIVED
// attention signals from the ALREADY-SHIPPED primitives' leaves (dueDate/metric/checklist/timeLog/habit),
// then let the blind engine reduce them to a score + reasons. The signal SET is a DATA registry
// (`ATTENTION_SIGNALS`) — each entry is a self-describing descriptor {key,label,weight,compute}; adding a
// new signal is ONE array row, ZERO engine change (L090/enum-dissolution). Nothing here is user-rated or
// voted (distinct from `scores`/`votes`): every magnitude is computed from the objective state of the
// other primitives. Connectors + furniture are never attention targets — you triage CONTENT.

import type { BoardItem } from '../read-data/group-board-model';
import { itemIsConnector } from '../read-data/group-board-model';
import { itemIsBoardFurniture } from './batch-actions';
import { type WeightedSignal, type SignalScore, weightedSignalScore, rankByWeightedSignals } from '../read-data/board-weighted-signals';
import { dueDateFromRaw, relativeDue, isDueSoon } from '../read-data/board-due-date';
import { metricFromRaw, completion, isComplete as metricIsComplete } from '../read-data/board-metric';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist';
import { timeLogFromRaw, timeInWindowMs } from '../read-data/board-time-log';
import { habitLogFromRaw } from '../read-data/board-habit';
import { cadenceFromRaw, habitPulse } from '../read-data/board-habit-cadence';

/** Trailing window (ms) that "recent effort" is measured over, for the stalled signal. */
const RECENT_WINDOW_MS = 7 * 24 * 3_600_000;

/** A measured goal counts as "low progress" below this completion fraction (low-progress-near-due signal). */
const LOW_PROGRESS_FRACTION = 0.75;

/** A signal descriptor: how to derive ONE attention signal for a card from the other primitives' DATA. */
interface AttentionSignalDef {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  /** Returns 0..1 (0 = inactive) from the card's DATA + injected `now`. Reads the other leaves only. */
  readonly compute: (item: BoardItem, now: number) => number;
}

/** True once a card carries any work that a timeLog would advance (an incomplete metric or checklist). */
function hasOpenWork(item: BoardItem): boolean {
  const metric = metricFromRaw(item.extra?.metric);
  if (metric && !metricIsComplete(metric)) return true;
  const cl = checklistProgress(checklistFromRaw(item.extra?.checklist));
  return cl.total > 0 && !cl.complete;
}

/**
 * The signal registry — the goal board's Society DATA (extensible). Each signal reads ONLY existing
 * leaves. Weights are relative importance. This is the ONE place the meaning of "attention" lives; the
 * engine (Physics) stays blind. Add a signal → add a row here, nothing else changes.
 */
export const ATTENTION_SIGNALS: readonly AttentionSignalDef[] = [
  {
    key: 'overdue',
    label: 'Overdue',
    weight: 3,
    compute: (item, now) => {
      const due = dueDateFromRaw(item.extra?.dueDate);
      return due !== null && relativeDue(due, now).overdue ? 1 : 0;
    },
  },
  {
    key: 'due-soon',
    label: 'Due soon',
    weight: 1.5,
    compute: (item, now) => {
      const due = dueDateFromRaw(item.extra?.dueDate);
      if (due === null) return 0;
      const rel = relativeDue(due, now);
      return !rel.overdue && isDueSoon(due, now) ? 1 : 0;
    },
  },
  {
    key: 'low-progress-near-due',
    label: 'Low progress, deadline near',
    weight: 2,
    // A measured goal that is near/past its deadline AND genuinely low (< LOW_PROGRESS_PCT). This is an
    // HONEST composition of two objective facts (low metric + near due) — it makes NO elapsed-plan claim
    // (there is no start/created anchor to compute true pace against; claiming "behind pace" would be
    // fake precision, per the Codex convergence). Magnitude = how far below done.
    compute: (item, now) => {
      const metric = metricFromRaw(item.extra?.metric);
      const due = dueDateFromRaw(item.extra?.dueDate);
      if (metric === null || due === null || metricIsComplete(metric)) return 0;
      const c = completion(metric); // EXACT 0..1 (not display-rounded) — no boundary wobble at the threshold
      if (c >= LOW_PROGRESS_FRACTION) return 0; // not low enough to flag
      const near = relativeDue(due, now).overdue || isDueSoon(due, now);
      return near ? 1 - c : 0; // magnitude = how far below done
    },
  },
  {
    key: 'stalled',
    label: 'Stalled — no recent work',
    weight: 1.5,
    // Constrained (per the Codex convergence): only cards that WERE being tracked (have a timeLog history)
    // and have open work but no effort in the recent window. Without the has-history gate, EVERY untracked
    // card with an open checklist would flag "stalled" — a moralizing false positive.
    compute: (item, now) => {
      const log = timeLogFromRaw(item.extra?.timeLog);
      if (log.length === 0 || !hasOpenWork(item)) return 0;
      return timeInWindowMs(log, now, RECENT_WINDOW_MS) > 0 ? 0 : 1;
    },
  },
  {
    key: 'streak-broken',
    label: 'Habit lapsed',
    weight: 1,
    // A tracked habit that has fallen off its target. Cadence-aware: a "3x/week" habit is lapsed only when
    // it has NO period streak AND nothing done this period — NOT merely for skipping a day (which is on
    // cadence). Daily habits are byte-identical (broken == currentStreak fell to 0).
    compute: (item, now) => {
      const log = habitLogFromRaw(item.extra?.habitLog);
      if (log.length === 0) return 0;
      return habitPulse(log, cadenceFromRaw(item.extra?.habitCadence), now).broken ? 1 : 0;
    },
  },
];

/** An item is an attention TARGET iff it is real content, not a connector or furniture. */
export function itemIsAttentionTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** Derive one card's attention signals from the registry (all signals, engine filters the inactive ones). */
export function itemAttentionSignals(item: BoardItem, now: number): WeightedSignal[] {
  return ATTENTION_SIGNALS.map((def) => ({
    key: def.key,
    label: def.label,
    weight: def.weight,
    magnitude: def.compute(item, now),
  }));
}

/** One card's attention verdict (score + reasons). */
export function attentionOf(item: BoardItem, now: number): SignalScore {
  return weightedSignalScore(itemAttentionSignals(item, now));
}

/** One attention row: the item + a human label + its score + the reason labels (strongest first). */
export interface AttentionRankRow {
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
 * The "Needs attention" rows — every content card whose derived attention score is > 0, most-urgent
 * first, each with the reasons that fired. `now` is injected. Pure read-model composing every shipped
 * primitive's leaf through the blind engine.
 */
export function attentionRows(items: readonly BoardItem[], now: number): AttentionRankRow[] {
  const label = labelOf(items);
  const targets = items.filter(itemIsAttentionTarget);
  return rankByWeightedSignals(targets, (it) => itemAttentionSignals(it, now)).map(
    (r): AttentionRankRow => ({
      memberId: r.item.memberId,
      label: label(r.item.memberId),
      score: Math.round(r.result.score * 100) / 100,
      reasons: r.result.reasons.map((reason) => reason.label),
    }),
  );
}
