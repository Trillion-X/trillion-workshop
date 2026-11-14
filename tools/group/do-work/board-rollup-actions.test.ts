// Proof for the rollup BRIDGE: it reads typed connectors (extra.relationKind + from/to) + per-card
// metrics and rolls a vision up from its sub-goals, direction chosen by the DATA spec. Branch-normalized,
// coverage-honest, spec fail-closed.
import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import type { AddressRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { placeItem, readItems } from '../read-data/group-board-model';
import { setItemMetric } from './board-metric-actions';
import {
  itemIsRollupParent,
  rollupChildren,
  rollupOfItem,
  rollupParents,
  rollupSpecFromRaw,
  type RollupSpec,
} from './board-rollup-actions';

const PARENT: AddressRef = { family: 'test.board', parts: { board: 'b1' } };
// "child -> parent" contributes-to edges: the CHILD is the `from` endpoint.
const SPEC: RollupSpec = { relationKind: 'contributes-to', childEndpoint: 'from' };

function board() {
  let g = emptyGraph();
  const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
  put({ memberId: 'fit', x: 0, y: 0, text: 'Get fit' });
  put({ memberId: 'run', x: 0, y: 100, text: 'Run 5k' });
  put({ memberId: 'health', x: 200, y: 100, text: 'Eat well & rest' });
  put({ memberId: 'diet', x: 100, y: 200, text: 'Diet' });
  put({ memberId: 'sleep', x: 300, y: 200, text: 'Sleep' });
  const edge = (from: string, to: string, kind = 'contributes-to') => put({ memberId: `e-${from}-${to}`, x: 0, y: 0, kind: 'connector', extra: { fromMemberId: from, toMemberId: to, relationKind: kind } });
  edge('run', 'fit'); // run contributes to fit
  edge('health', 'fit'); // health contributes to fit
  edge('diet', 'health');
  edge('sleep', 'health');
  g = setItemMetric(g, PARENT, 'fit', { current: 1, target: 10 }); // vision's OWN metric = 10% (must not leak)
  g = setItemMetric(g, PARENT, 'run', { current: 5, target: 10 }); // 50%
  g = setItemMetric(g, PARENT, 'diet', { current: 9, target: 10 }); // 90%
  g = setItemMetric(g, PARENT, 'sleep', { current: 9, target: 10 }); // 90%
  return g;
}

describe('board-rollup-actions — the graph+metric bridge', () => {
  it('rolls a vision up branch-normalized from its sub-goals along the DATA-specified relation', () => {
    const items = readItems(board(), PARENT);
    // health = mean(diet .9, sleep .9) = .9
    expect(rollupOfItem(items, 'health', SPEC).fraction).toBeCloseTo(0.9);
    // fit = mean(run .5, health .9) = .7 — the health branch (2 leaves) does NOT outweigh run (1 leaf)
    const fit = rollupOfItem(items, 'fit', SPEC);
    expect(fit.fraction).toBeCloseTo(0.7);
    expect(fit.childCount).toBe(2);
    expect(fit.contributingChildCount).toBe(2);
    expect(fit.ownFraction).toBeCloseTo(0.1); // the vision's own 10% is kept separate, never blended
  });

  it('aggregates the EXACT child fraction — a 99.5% child rolls up to 0.995, never a false complete 1.0', () => {
    // Regression: fractionAccessor once used the display-ROUNDED progressPct/100, so a 99.5% child (0.995)
    // rounded to 100% -> the parent read a complete 1.0 with 0.5 units still remaining. It must use the
    // exact completion instead.
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
    put({ memberId: 'goal', x: 0, y: 0, text: 'Goal' });
    put({ memberId: 'sub', x: 0, y: 100, text: 'Sub' });
    put({ memberId: 'e-sub-goal', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'sub', toMemberId: 'goal', relationKind: 'contributes-to' } });
    g = setItemMetric(g, PARENT, 'sub', { current: 199, target: 200 }); // 99.5% — NOT complete
    const roll = rollupOfItem(readItems(g, PARENT), 'goal', SPEC);
    expect(roll.fraction).toBeCloseTo(0.995); // exact, not rounded up to 1
    expect(roll.fraction).toBeLessThan(1); // never a false "complete" while the sub-goal has work left
  });

  it('respects the child endpoint direction (to == child inverts the tree, so fit has no children)', () => {
    const items = readItems(board(), PARENT);
    const inverted: RollupSpec = { relationKind: 'contributes-to', childEndpoint: 'to' };
    // with childEndpoint 'to', fit's children are edges FROM fit — there are none, so fit is not a parent.
    expect(itemIsRollupParent(items, 'fit', inverted)).toBe(false);
    expect(itemIsRollupParent(items, 'fit', SPEC)).toBe(true);
  });

  it('only counts the specified relation kind (a different kind is ignored)', () => {
    const items = readItems(board(), PARENT);
    const otherKind: RollupSpec = { relationKind: 'blocks', childEndpoint: 'from' };
    expect(itemIsRollupParent(items, 'fit', otherKind)).toBe(false); // no 'blocks' edges
  });

  it('rollupParents lists only cards with children; rollupChildren gives the breakdown', () => {
    const items = readItems(board(), PARENT);
    const parents = rollupParents(items, SPEC).map((r) => r.memberId).sort();
    expect(parents).toEqual(['fit', 'health']); // run/diet/sleep are leaves
    // each child's effective contribution: a leaf child ('run') shows its own progress; an internal child
    // ('health') shows its aggregate.
    const kids = rollupChildren(items, 'fit', SPEC).map((c) => ({ id: c.memberId, f: c.result.value }));
    expect(kids.find((k) => k.id === 'run')!.f).toBeCloseTo(0.5);
    expect(kids.find((k) => k.id === 'health')!.f).toBeCloseTo(0.9);
  });

  it('rollupSpecFromRaw is fail-closed', () => {
    expect(rollupSpecFromRaw({ relationKind: 'contributes-to', childEndpoint: 'from' })).toEqual(SPEC);
    expect(rollupSpecFromRaw({ relationKind: '  ', childEndpoint: 'from' })).toBeNull(); // blank kind
    expect(rollupSpecFromRaw({ relationKind: 'x', childEndpoint: 'sideways' })).toBeNull(); // bad endpoint
    expect(rollupSpecFromRaw(null)).toBeNull();
    expect(rollupSpecFromRaw({ relationKind: 'x' })).toBeNull(); // no endpoint
  });
});

describe('checklist progress rolls up (cont.98 batch-62): a CHECKLIST-tracked sub-goal now counts, not just metrics', () => {
  it('a parent whose only child tracks progress by a CHECKLIST reflects that child fraction', () => {
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
    put({ memberId: 'goal', x: 0, y: 0, text: 'Launch' });
    // child tracked by a CHECKLIST (2 of 4 done = 50%), NO metric — the exact case the old metric-only accessor dropped.
    put({ memberId: 'task', x: 0, y: 100, text: 'Prep', extra: { checklist: [
      { id: 'a', text: 'a', done: true }, { id: 'b', text: 'b', done: true }, { id: 'c', text: 'c', done: false }, { id: 'd', text: 'd', done: false },
    ] } });
    put({ memberId: 'e', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'task', toMemberId: 'goal', relationKind: 'contributes-to' } });

    const roll = rollupOfItem(readItems(g, PARENT), 'goal', SPEC);
    expect(roll.childCount).toBe(1);
    expect(roll.fraction).toBeCloseTo(0.5); // the checklist child's 50% now aggregates (was undefined under metric-only)
  });

  it('a metric child still wins over its own checklist (unified reading, metric-first)', () => {
    let g = emptyGraph();
    const put = (a: Record<string, unknown>) => (g = placeItem(g, PARENT, { nodeRef: { family: 't', parts: { id: a.memberId } }, w: 100, h: 60, kind: 'note', ...a } as never));
    put({ memberId: 'goal', x: 0, y: 0, text: 'Launch' });
    put({ memberId: 'task', x: 0, y: 100, text: 'Prep', extra: { metric: { current: 8, target: 10 }, checklist: [{ id: 'a', text: 'a', done: false }] } });
    put({ memberId: 'e', x: 0, y: 0, kind: 'connector', extra: { fromMemberId: 'task', toMemberId: 'goal', relationKind: 'contributes-to' } });
    expect(rollupOfItem(readItems(g, PARENT), 'goal', SPEC).fraction).toBeCloseTo(0.8); // metric 80%, not checklist 0%
  });
});
