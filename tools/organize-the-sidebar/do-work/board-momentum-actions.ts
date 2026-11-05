// packages/group/do-work/board-momentum-actions.ts
//
// The GRAPH bridge for the MOMENTUM lens — the positive mirror of the attention lens. It reuses the EXACT
// same blind engine (read-data/board-weighted-signals) fed a DIFFERENT DATA registry `MOMENTUM_SIGNALS`,
// proving the engine is the generative primitive ("weigh opaque signals") and attention/momentum are two
// configurations of it (L069). Momentum is genuinely distinct from inverted-attention: "not slipping"
// (no risk signal) is not the same as "has positive evidence of movement." Every signal is DERIVED from
// the already-shipped primitives' leaves — nothing user-rated. Connectors + furniture are never targets.
//
// Signals are the honest set (per the Codex convergence): only what the existing leaves actually support.
// Cut: `metric-moving` (velocity is LIFETIME progress/effort, not proof of RECENT movement) and
// `checklist-steps-recently-completed` (checklist steps carry no timestamps) — both would be fake signals.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { itemIsConnector } from '../read-data/group-board-model.ts';
import { itemIsBoardFurniture } from './batch-actions.ts';
import { type WeightedSignal, type SignalScore, weightedSignalScore, rankByWeightedSignals } from '../read-data/board-weighted-signals.ts';
import { metricFromRaw, completion, isComplete as metricIsComplete } from '../read-data/board-metric.ts';
import { checklistFromRaw, checklistProgress } from '../read-data/board-checklist.ts';
import { timeLogFromRaw, timeInWindowMs } from '../read-data/board-time-log.ts';
import { habitLogFromRaw } from '../read-data/board-habit.ts';
import { cadenceFromRaw, habitPulse } from '../read-data/board-habit-cadence.ts';

/** Trailing window (ms) that "recent effort" is measured over. */
const RECENT_WINDOW_MS = 7 * 24 * 3_600_000;
/** Effort in the window that saturates the recent-effort signal (2h of logged work = full strength). */
const EFFORT_SATURATION_MS = 2 * 3_600_000;
/** Streak length that saturates the active-streak signal (a week-long streak = full strength). */
const STREAK_SATURATION = 7;
/** A goal/checklist counts as "nearly complete" at/above this fraction. */
const NEAR_COMPLETE_FRACTION = 0.75;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** A signal descriptor: how to derive ONE momentum signal for a card from the other primitives' DATA. */
interface MomentumSignalDef {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  /** Returns 0..1 (0 = inactive) from the card's DATA + injected `now`. Reads existing leaves only. */
  readonly compute: (item: BoardItem, now: number) => number;
}

/**
 * The momentum signal registry — the goal board's Society DATA (extensible). Each reads ONLY existing
 * leaves. The engine (Physics) stays blind. Add a positive signal → add a row here, nothing else changes.
 */
export const MOMENTUM_SIGNALS: readonly MomentumSignalDef[] = [
  {
    key: 'recent-effort',
    label: 'Recent effort',
    weight: 1.5,
    compute: (item, now) => clamp01(timeInWindowMs(timeLogFromRaw(item.extra?.timeLog), now, RECENT_WINDOW_MS) / EFFORT_SATURATION_MS),
  },
  {
    key: 'active-streak',
    label: 'Active streak',
    weight: 1.25,
    // Cadence-aware: a "3x/week" habit meeting its target is ON A ROLL via its PERIOD streak, not scored ~0
    // for lacking consecutive days. Daily habits are byte-identical (habitPulse(log,null).streak == currentStreak).
    compute: (item, now) => {
      const log = habitLogFromRaw(item.extra?.habitLog);
      if (log.length === 0) return 0;
      const streak = habitPulse(log, cadenceFromRaw(item.extra?.habitCadence), now).streak;
      return clamp01(streak / STREAK_SATURATION);
    },
  },
  {
    key: 'metric-near-complete',
    label: 'Metric nearly complete',
    weight: 1,
    // A measured goal that is close to (but not yet at) its target — the final push is worth riding.
    compute: (item) => {
      const metric = metricFromRaw(item.extra?.metric);
      if (metric === null || metricIsComplete(metric)) return 0;
      const c = completion(metric); // EXACT 0..1 (not display-rounded) — consistent with checklist-near-complete
      return c >= NEAR_COMPLETE_FRACTION ? c : 0;
    },
  },
  {
    key: 'checklist-near-complete',
    label: 'Checklist nearly complete',
    weight: 1,
    compute: (item) => {
      const p = checklistProgress(checklistFromRaw(item.extra?.checklist));
      return p.total >= 2 && !p.complete && p.fraction >= NEAR_COMPLETE_FRACTION ? p.fraction : 0;
    },
  },
];

/** An item is a momentum TARGET iff it is real content, not a connector or furniture. */
export function itemIsMomentumTarget(item: BoardItem): boolean {
  return !itemIsConnector(item) && !itemIsBoardFurniture(item);
}

/** Derive one card's momentum signals from the registry (all signals; the engine filters the inactive). */
export function itemMomentumSignals(item: BoardItem, now: number): WeightedSignal[] {
  return MOMENTUM_SIGNALS.map((def) => ({ key: def.key, label: def.label, weight: def.weight, magnitude: def.compute(item, now) }));
}

/** One card's momentum verdict (score + reasons). */
export function momentumOf(item: BoardItem, now: number): SignalScore {
  return weightedSignalScore(itemMomentumSignals(item, now));
}

/** One momentum row: the item + a human label + its score + the reason labels (strongest first). */
export interface MomentumRankRow {
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
 * The "On a roll" rows — every content card with positive momentum, strongest first, each with the
 * reasons that fired. `now` is injected. Pure read-model composing the shipped primitives' leaves through
 * the shared blind engine.
 */
export function momentumRows(items: readonly BoardItem[], now: number): MomentumRankRow[] {
  const label = labelOf(items);
  const targets = items.filter(itemIsMomentumTarget);
  return rankByWeightedSignals(targets, (it) => itemMomentumSignals(it, now)).map(
    (r): MomentumRankRow => ({
      memberId: r.item.memberId,
      label: label(r.item.memberId),
      score: Math.round(r.result.score * 100) / 100,
      reasons: r.result.reasons.map((reason) => reason.label),
    }),
  );
}
