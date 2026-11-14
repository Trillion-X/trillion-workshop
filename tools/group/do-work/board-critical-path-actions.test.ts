// packages/group/do-work/board-critical-path-actions.test.ts
import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef, GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemMetric } from './board-metric-actions';
import { logMinutes } from './board-time-log-actions';
import type { RollupSpec } from './board-rollup-actions';
import { criticalPathOfGoal, criticalRoots, labelForGoal } from './board-critical-path-actions';

const REF: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const NOW = 1_800_000_000_000;
const SPEC: RollupSpec = { relationKind: 'contributes-to', childEndpoint: 'from' };

function put(g: GroupGraph, id: string, text: string): GroupGraph {
  return placeItem(g, REF, { memberId: id, nodeRef: { family: 'p', parts: { id } }, kind: 'note', x: 0, y: 0, w: 100, h: 60, text } as never);
}
function edge(g: GroupGraph, from: string, to: string): GroupGraph {
  return placeItem(g, REF, { memberId: `e-${from}-${to}`, nodeRef: { family: 'p', parts: { id: `e-${from}-${to}` } }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, extra: { fromMemberId: from, toMemberId: to, relationKind: 'contributes-to' } } as never);
}
// Give a goal a measured pace: `progressed` units done, over `hoursLogged` hours, with `target` to hit.
function measured(g: GroupGraph, id: string, current: number, target: number, hoursLogged: number): GroupGraph {
  g = setItemMetric(g, REF, id, { current, target, start: 0 });
  return logMinutes(g, REF, id, hoursLogged * 60, NOW);
}

describe('board-critical-path bridge composes rollup hierarchy + forecast effort', () => {
  function chainBoard(): GroupGraph {
    let g = emptyGraph();
    g = put(g, 'run5k', 'Run 5k');
    g = put(g, 'run10k', 'Run 10k');
    g = put(g, 'marathon', 'Run a marathon');
    g = edge(g, 'run5k', 'run10k'); // run5k must finish before run10k
    g = edge(g, 'run10k', 'marathon'); // run10k must finish before marathon
    g = measured(g, 'run5k', 5, 10, 5); // remaining 5, 5 units / 5h = 1/hr -> 5h effort
    g = measured(g, 'run10k', 2, 10, 2); // remaining 8, 2 units / 2h = 1/hr -> 8h effort
    g = measured(g, 'marathon', 0.5, 1, 1); // remaining 0.5, 0.5 / 1h = 0.5/hr -> 1h effort
    return g;
  }

  it('sums effort along the dependency chain and names the bottleneck', () => {
    const items = readItems(chainBoard(), REF);
    const r = criticalPathOfGoal(items, 'marathon', SPEC, NOW);
    expect(r.finishHours).toBe(14); // 1 + 8 + 5
    expect(r.criticalPath).toEqual(['marathon', 'run10k', 'run5k']);
    expect(r.primaryBottleneckId).toBe('run10k'); // 8h is the biggest chunk on the chain
    expect(r.unknownDurationIds).toEqual([]);
  });

  it('criticalRoots is the top-level vision (has prerequisites, is not one)', () => {
    const items = readItems(chainBoard(), REF);
    expect(criticalRoots(items, SPEC)).toEqual(['marathon']);
  });

  it('a stalled prerequisite (metric but no logged pace) makes the schedule non-authoritative', () => {
    let g = emptyGraph();
    g = put(g, 'a', 'Sub-goal A');
    g = put(g, 'vision', 'Big vision');
    g = edge(g, 'a', 'vision');
    g = setItemMetric(g, REF, 'a', { current: 1, target: 10, start: 0 }); // metric but NO logged time -> stalled
    g = measured(g, 'vision', 0.5, 1, 1);
    const r = criticalPathOfGoal(readItems(g, REF), 'vision', SPEC, NOW);
    expect(r.finishHours).toBeNull(); // cannot schedule around an unestimated goal
    expect(r.unknownDurationIds).toContain('a');
    expect(r.knownFinishHours).toBe(1); // the measured vision effort alone
  });

  it('labelForGoal reads card text, falls back to id', () => {
    const items = readItems(chainBoard(), REF);
    const label = labelForGoal(items);
    expect(label('marathon')).toBe('Run a marathon');
    expect(label('missing')).toBe('missing');
  });
});
