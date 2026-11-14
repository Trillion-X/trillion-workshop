// packages/group/do-work/board-next-focus-actions.test.ts
import { describe, it, expect } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef, GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemMetric } from './board-metric-actions';
import { logMinutes } from './board-time-log-actions';
import { setItemDueDate } from './board-due-date-actions';
import type { RollupSpec } from './board-rollup-actions';
import { nextFocus } from './board-next-focus-actions';

const REF: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SPEC: RollupSpec = { relationKind: 'contributes-to', childEndpoint: 'from' };

function put(g: GroupGraph, id: string, text: string): GroupGraph {
  return placeItem(g, REF, { memberId: id, nodeRef: { family: 'p', parts: { id } }, kind: 'note', x: 0, y: 0, w: 100, h: 60, text } as never);
}
function edge(g: GroupGraph, from: string, to: string): GroupGraph {
  return placeItem(g, REF, { memberId: `e-${from}-${to}`, nodeRef: { family: 'p', parts: { id: `e-${from}-${to}` } }, kind: 'connector', x: 0, y: 0, w: 1, h: 1, extra: { fromMemberId: from, toMemberId: to, relationKind: 'contributes-to' } } as never);
}
function measured(g: GroupGraph, id: string, current: number, target: number, hoursLogged: number): GroupGraph {
  g = setItemMetric(g, REF, id, { current, target, start: 0 });
  return logMinutes(g, REF, id, hoursLogged * 60, NOW);
}
const items = (g: GroupGraph) => readItems(g, REF);

describe('board-next-focus composes critical-path + forecast into one recommendation', () => {
  it('with a goal hierarchy, the critical-path bottleneck wins', () => {
    let g = emptyGraph();
    g = put(g, 'run5k', 'Run 5k'); g = put(g, 'run10k', 'Run 10k'); g = put(g, 'marathon', 'Run a marathon');
    g = edge(g, 'run5k', 'run10k'); g = edge(g, 'run10k', 'marathon');
    g = measured(g, 'run5k', 5, 10, 5);   // 5h
    g = measured(g, 'run10k', 2, 10, 2);  // 8h — bottleneck
    g = measured(g, 'marathon', 0.5, 1, 1); // 1h
    const pick = nextFocus(items(g), SPEC, NOW);
    expect(pick).not.toBeNull();
    expect(pick!.memberId).toBe('run10k');
    expect(pick!.source).toBe('bottleneck');
    expect(pick!.reason).toBe('bottleneck of Run a marathon');
  });

  it('without a hierarchy, the most at-risk goal (behind before stalled) wins', () => {
    let g = emptyGraph();
    g = put(g, 'behind', 'Behind goal');
    g = measured(g, 'behind', 1, 10, 10); // 9 units / 10h = 0.9/hr -> ~10h, due in 1h => behind
    g = setItemDueDate(g, REF, 'behind', NOW + HOUR);
    g = put(g, 'stalled', 'Stalled goal');
    g = setItemMetric(g, REF, 'stalled', { current: 0, target: 10, start: 0 }); // metric, no time -> stalled
    const pick = nextFocus(items(g), null, NOW);
    expect(pick!.memberId).toBe('behind');
    expect(pick!.source).toBe('behind');
    expect(pick!.reason).toBe('behind its deadline');
  });

  it('falls back to a stalled goal when nothing is behind', () => {
    let g = emptyGraph();
    g = put(g, 'stalled', 'Stalled goal');
    g = setItemMetric(g, REF, 'stalled', { current: 0, target: 10, start: 0 });
    const pick = nextFocus(items(g), null, NOW);
    expect(pick!.memberId).toBe('stalled');
    expect(pick!.source).toBe('stalled');
  });

  it('returns null when nothing is actionable (no bottleneck, nothing at risk)', () => {
    let g = emptyGraph();
    g = put(g, 'done', 'Done goal');
    g = measured(g, 'done', 10, 10, 5); // complete -> not at risk
    expect(nextFocus(items(g), SPEC, NOW)).toBeNull();
    expect(nextFocus(items(g), null, NOW)).toBeNull();
  });

  it('an all-complete hierarchy recommends nothing — no fake urgency from a done bottleneck', () => {
    // Both goals in the sub -> vision hierarchy are finished (remaining 0 -> zero effort). The CPM must not
    // hand back a zero-effort "bottleneck", so nextFocus returns null instead of pointing at a done goal.
    let g = emptyGraph();
    g = put(g, 'sub', 'Sub-goal'); g = put(g, 'vision', 'Vision');
    g = edge(g, 'sub', 'vision');
    g = measured(g, 'sub', 10, 10, 3);    // complete
    g = measured(g, 'vision', 10, 10, 4); // complete
    expect(nextFocus(items(g), SPEC, NOW)).toBeNull();
  });

  it('a hierarchy with no bottleneck falls through to forecast at-risk', () => {
    // A vision whose only prerequisite is unmeasured -> criticalPath has no measured bottleneck; the
    // unmeasured prerequisite is itself stalled, so forecast surfaces it.
    let g = emptyGraph();
    g = put(g, 'sub', 'Sub-goal'); g = put(g, 'vision', 'Vision');
    g = edge(g, 'sub', 'vision');
    g = setItemMetric(g, REF, 'sub', { current: 1, target: 10, start: 0 }); // metric, no time -> stalled, no effort
    g = setItemMetric(g, REF, 'vision', { current: 1, target: 10, start: 0 });
    const pick = nextFocus(items(g), SPEC, NOW);
    expect(pick).not.toBeNull();
    expect(pick!.source).toBe('stalled'); // no measured bottleneck -> forecast fallback
  });
});
