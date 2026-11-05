// packages/group/do-work/board-critical-path-actions.ts
//
// The GRAPH bridge for the critical-path primitive (read-data/board-critical-path): feed the blind CPM
// engine the board's dependency edges + each goal's remaining effort. It REUSES the rollup hierarchy
// (`RollupSpec` + `childrenAccessor`) as the prerequisite relation — "sub-goal contributes to goal" is
// exactly "sub-goal must finish before goal" — and REUSES the forecast primitive for a goal's effort-hours
// (`hoursRemaining`: a real number when the goal has a metric + logged pace, null when stalled/unmeasured,
// 0 when done). So the whole schedule is a composition of two shipped primitives with no new engine and no
// new storage (SSOT stays the metric + time-log + connectors). Owns NO Society vocabulary beyond the spec.

import type { BoardItem } from '../read-data/group-board-model.ts';
import { buildRelationGraph } from '../read-data/relationship-graph.ts';
import { childrenAccessor, type RollupSpec } from './board-rollup-actions.ts';
import { forecastOfItem } from './board-forecast-actions.ts';
import { criticalPathOf, type CriticalPathResult } from '../read-data/board-critical-path.ts';

/** A goal's remaining effort-hours (forecast.hoursRemaining), or null when it is unmeasured/stalled. */
function durationAccessor(items: readonly BoardItem[], now: number): (id: string) => number | null {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  return (id: string) => {
    const it = byId.get(id);
    if (!it) return null;
    return forecastOfItem(it, now)?.hoursRemaining ?? null;
  };
}

/** Human label for a goal id — its card text, falling back to the id. */
export function labelForGoal(items: readonly BoardItem[]): (id: string) => string {
  const byId = new Map(items.map((it) => [it.memberId, it]));
  return (id: string) => {
    const t = byId.get(id)?.text;
    const trimmed = typeof t === 'string' ? t.trim() : '';
    return trimmed !== '' ? trimmed : id;
  };
}

/** Compute the critical effort path that gates one goal, using the board's hierarchy spec + goal efforts. */
export function criticalPathOfGoal(
  items: readonly BoardItem[],
  rootId: string,
  spec: RollupSpec,
  now: number,
): CriticalPathResult {
  const graph = buildRelationGraph(items);
  return criticalPathOf(rootId, childrenAccessor(graph, spec), durationAccessor(items, now));
}

/**
 * The candidate ROOTS to schedule: goals that HAVE prerequisites under the spec but are NOT themselves a
 * prerequisite of any other goal (the top-level visions). These are the ids worth running the CPM on.
 */
export function criticalRoots(items: readonly BoardItem[], spec: RollupSpec): string[] {
  const graph = buildRelationGraph(items);
  const childrenOf = childrenAccessor(graph, spec);
  const isPrerequisite = new Set<string>();
  for (const it of items) for (const c of childrenOf(it.memberId)) isPrerequisite.add(c);
  return items
    .filter((it) => childrenOf(it.memberId).length > 0 && !isPrerequisite.has(it.memberId))
    .map((it) => it.memberId);
}
