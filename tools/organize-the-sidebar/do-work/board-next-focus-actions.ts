// packages/group/do-work/board-next-focus-actions.ts
//
// The ACTIONABLE capstone: given everything the board knows about its goals, what ONE goal deserves
// attention right now? This owns no new engine and no storage — it is a pure composition of two shipped
// primitives, turning their analysis into a single recommendation the user can act on:
//   1. If the board has a goal hierarchy, the critical-path BOTTLENECK of a top-level vision is the highest-
//      leverage work — clearing it shortens the whole plan 1:1. (board-critical-path)
//   2. Otherwise the most AT-RISK goal by forecast: behind its deadline first, then stalled. (board-forecast)
// Returns null when nothing is actionable (no bottleneck, nothing behind/stalled) — no fake urgency.

import type { BoardItem } from '../read-data/group-board-model.ts';
import type { RollupSpec } from './board-rollup-actions.ts';
import { criticalPathOfGoal, criticalRoots, labelForGoal } from './board-critical-path-actions.ts';
import { forecastRows } from './board-forecast-actions.ts';

/** The single goal to work on next, with a plain-language reason and which signal surfaced it. */
export interface FocusPick {
  readonly memberId: string;
  readonly label: string;
  readonly reason: string;
  readonly source: 'bottleneck' | 'behind' | 'stalled';
}

/**
 * Pick the one goal to work on next. A goal hierarchy (the roll-up spec) makes the critical-path bottleneck
 * the highest-leverage choice; without one, or without a bottleneck, the most at-risk forecast goal wins.
 * `now` is injected (no clock here). Deterministic: roots are scanned in board order, forecast rows arrive
 * risk-first from the bridge.
 */
export function nextFocus(items: readonly BoardItem[], spec: RollupSpec | null, now: number): FocusPick | null {
  const label = labelForGoal(items);

  if (spec) {
    for (const root of criticalRoots(items, spec)) {
      const r = criticalPathOfGoal(items, root, spec, now);
      if (r.primaryBottleneckId) {
        return { memberId: r.primaryBottleneckId, label: label(r.primaryBottleneckId), reason: `bottleneck of ${label(root)}`, source: 'bottleneck' };
      }
    }
  }

  const rows = forecastRows(items, now); // already risk-first (behind, stalled, ...)
  const behind = rows.find((r) => r.forecast.verdict === 'behind');
  if (behind) return { memberId: behind.memberId, label: behind.label, reason: 'behind its deadline', source: 'behind' };
  const stalled = rows.find((r) => r.forecast.verdict === 'stalled');
  if (stalled) return { memberId: stalled.memberId, label: stalled.label, reason: 'stalled — no recent progress', source: 'stalled' };

  return null;
}
