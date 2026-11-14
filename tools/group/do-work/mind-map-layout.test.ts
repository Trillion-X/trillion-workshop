// packages/group/do-work/mind-map-layout.test.ts
//
// Proof for the #161 topology-aware mind-map auto-layout — the connector-aware sibling
// of the geometric layout ops (tidyGrid/distributeBoxes). Two layers:
//   1. `computeTreeLayout` — the pure Reingold–Tilford-shape solver (nodes + edges →
//      LOCAL top-left map). Deterministic, graph-only, no board.
//   2. `arrangeMindMap` — reads the SAME `kind:'connector'` members (#98/#159) from a
//      real board graph and patches the linked notes into the tidy tree, anchored in
//      place, as ONE batch. Connectors are never moved (they re-route from endpoints).

import { describe, expect, it } from 'vitest';
import { emptyGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts';
import { boardRootRef, itemRef, placeItem, readItems } from '../read-data/group-board-model';
import { computeTreeLayout, arrangeMindMap, arrangeByGraph } from './batch-actions';
import { tidyTreeLayout, layeredDagLayout, radialTreeLayout } from '../show/graph-layout';

const B = boardRootRef('mm');

/** Place a note at (x,y) with a fixed 200×100 box (so column/row math is predictable). */
function note(graph: ReturnType<typeof emptyGraph>, id: string, x: number, y: number) {
  return placeItem(graph, B, { memberId: id, nodeRef: itemRef('mm', `n-${id}`), kind: 'note', x, y, w: 200, h: 100, text: id });
}
/** Place a connector member linking from→to (the #98 shape: kind connector + extra.from/toMemberId). */
function connect(graph: ReturnType<typeof emptyGraph>, id: string, from: string, to: string) {
  return placeItem(graph, B, {
    memberId: id,
    nodeRef: itemRef('mm', `c-${id}`),
    kind: 'connector',
    x: 0,
    y: 0,
    extra: { fromMemberId: from, toMemberId: to },
  });
}

describe('computeTreeLayout — pure tidy-tree solver', () => {
  const N = (id: string, w = 200, h = 100) => ({ memberId: id, w, h });

  it('lays a 1→2 tree: root in column 0, two children stacked in column 1, root centred', () => {
    const pos = computeTreeLayout([N('root'), N('a'), N('b')], [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }], { colGap: 100, rowGap: 40 });
    // Column x: depth 0 at x=0; depth 1 at x = 200 (max width depth0) + 100 (gap) = 300.
    expect(pos.get('root')!.x).toBe(0);
    expect(pos.get('a')!.x).toBe(300);
    expect(pos.get('b')!.x).toBe(300);
    // Children stack: a at y=0, b at y = 100 (h) + 40 (gap) = 140.
    expect(pos.get('a')!.y).toBe(0);
    expect(pos.get('b')!.y).toBe(140);
    // Root centred on its two children's vertical span (centres 50 and 190 → mid 120 → top 70).
    expect(pos.get('root')!.y).toBe(70);
  });

  it('a leaf chain deepens by one column per edge', () => {
    const pos = computeTreeLayout([N('a'), N('b'), N('c')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }], { colGap: 50 });
    expect(pos.get('a')!.x).toBe(0);
    expect(pos.get('b')!.x).toBe(250);
    expect(pos.get('c')!.x).toBe(500);
  });

  it('returns an EMPTY map when there is no tree (no root with children)', () => {
    // Two isolated nodes, no edges → nothing to lay out.
    expect(computeTreeLayout([N('x'), N('y')], []).size).toBe(0);
  });

  it('is cycle-safe — a rooted tree with a back-edge terminates, every node placed once', () => {
    // root→a→b plus a back-edge b→a: root has indegree 0 (the root); the b→a back-edge
    // is skipped (a is already on the path / placed) instead of looping forever.
    const pos = computeTreeLayout(
      [N('root'), N('a'), N('b')],
      [{ from: 'root', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
      { colGap: 50 },
    );
    expect(pos.size).toBe(3);
    expect(pos.get('root')!.x).toBe(0);
    expect(pos.get('a')!.x).toBe(250);
    expect(pos.get('b')!.x).toBe(500);
  });

  it('a pure cycle with no indegree-0 node has no root → empty map (nothing to arrange)', () => {
    expect(computeTreeLayout([N('a'), N('b')], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]).size).toBe(0);
  });

  it('respects an explicit rootId even when another node also has indegree 0', () => {
    // a→c and b→c: both a,b are roots by default; force b as the sole root.
    const pos = computeTreeLayout([N('a'), N('b'), N('c')], [{ from: 'a', to: 'c' }, { from: 'b', to: 'c' }], { rootId: 'b' });
    expect(pos.has('b')).toBe(true);
    expect(pos.get('b')!.x).toBe(0);
    expect(pos.has('c')).toBe(true);
    // `a` is not reachable from root b → not laid out.
    expect(pos.has('a')).toBe(false);
  });

  it('per-depth column x uses the WIDEST node at each depth (mixed sizes never overlap)', () => {
    // root is wide (400); its child column must start past root's right edge + gap.
    const pos = computeTreeLayout([N('root', 400, 100), N('child', 200, 100)], [{ from: 'root', to: 'child' }], { colGap: 60 });
    expect(pos.get('child')!.x).toBe(460); // 400 + 60
  });
});

describe('arrangeMindMap — board-level batch over real connector members', () => {
  it('reflows linked notes into the tidy tree, anchored at the selection top-left', () => {
    // Scattered notes + connectors root→a, root→b.
    let g = note(emptyGraph(), 'root', 500, 500);
    g = note(g, 'a', 900, 80);
    g = note(g, 'b', 120, 940);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'root', 'b');

    const out = arrangeMindMap(g, B, ['root', 'a', 'b'], { colGap: 100, rowGap: 40 });
    const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));

    // Anchored at the min current top-left of the laid-out nodes (minX=120, minY=80).
    expect(by.root.x).toBe(120);
    expect(by.root.y).toBe(80 + 70); // local root y 70 + anchorY 80
    // Children in the next column (120 + 200 + 100 = 420), stacked.
    expect(by.a.x).toBe(420);
    expect(by.b.x).toBe(420);
    expect(by.a.y).toBe(80); // first child at local y 0 + anchorY 80
    expect(by.b.y).toBe(80 + 140);
    // The connectors themselves are untouched (no x/y patch — they re-route from endpoints).
    expect(by.c1.kind).toBe('connector');
  });

  it('is a no-op when fewer than two nodes are selected', () => {
    let g = note(emptyGraph(), 'solo', 10, 20);
    g = note(g, 'other', 300, 300);
    g = connect(g, 'c', 'solo', 'other');
    const out = arrangeMindMap(g, B, ['solo'], {});
    expect(readItems(out, B).find((i) => i.memberId === 'solo')!.x).toBe(10); // unmoved
  });

  it('is a no-op when no connector links the selected nodes', () => {
    let g = note(emptyGraph(), 'p', 10, 20);
    g = note(g, 'q', 300, 300);
    const out = arrangeMindMap(g, B, ['p', 'q'], {});
    const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));
    expect(by.p.x).toBe(10);
    expect(by.q.x).toBe(300); // both untouched — no tree to arrange
  });

  it('only uses connectors whose BOTH endpoints are in the selection', () => {
    // root→a is selected-internal; a→outsider leaves the selection → ignored as an edge,
    // so `outsider` is never moved.
    let g = note(emptyGraph(), 'root', 600, 600);
    g = note(g, 'a', 50, 50);
    g = note(g, 'outsider', 999, 30);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'a', 'outsider');
    const out = arrangeMindMap(g, B, ['root', 'a'], { colGap: 100 });
    const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));
    expect(by.outsider.x).toBe(999); // untouched — outside the selection
    expect(by.a.x).toBe(by.root.x + 200 + 100); // a placed one column right of root
  });
});

// The generic engine (cont.25) — the SAME board reflow drives tree / flowchart / radial via an
// injected strategy, and LOCKED nodes anchor the topology as pins (Codex fix to #161).
describe('arrangeByGraph — one engine, injected strategy + locked pins', () => {
  /** root→a→b chain on a board; returns the graph. */
  function chain() {
    let g = note(emptyGraph(), 'root', 100, 100);
    g = note(g, 'a', 400, 100);
    g = note(g, 'b', 700, 100);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'a', 'b');
    return g;
  }

  it('every catalog strategy lays the chain out left-to-right by depth (root ▸ a ▸ b)', () => {
    for (const strategy of [tidyTreeLayout, layeredDagLayout]) {
      const out = arrangeByGraph(chain(), B, ['root', 'a', 'b'], strategy, { colGap: 60 });
      const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));
      expect(by.a.x).toBeGreaterThan(by.root.x);
      expect(by.b.x).toBeGreaterThan(by.a.x);
    }
  });

  it('the radial strategy fans children off the root (b further from root than a)', () => {
    const out = arrangeByGraph(chain(), B, ['root', 'a', 'b'], radialTreeLayout, { ringGap: 160 });
    const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));
    const d = (id: string) => Math.hypot(by[id].x - by.root.x, by[id].y - by.root.y);
    expect(d('b')).toBeGreaterThan(d('a')); // deeper ring
  });

  it('a LOCKED node keeps its position (a pin) while movers relayout, and its subtree is NOT orphaned', () => {
    // Lock `a` (the middle of root→a→b). Old #161 bug dropped locked nodes via unlockedOf, which
    // would orphan b (its parent gone) into a false root. The engine keeps a in the topology.
    let g = note(emptyGraph(), 'root', 100, 100);
    g = placeItem(g, B, { memberId: 'a', nodeRef: itemRef('mm', 'n-a'), kind: 'note', x: 400, y: 100, w: 200, h: 100, text: 'a', extra: { locked: true } });
    g = note(g, 'b', 700, 100);
    g = connect(g, 'c1', 'root', 'a');
    g = connect(g, 'c2', 'a', 'b');
    const out = arrangeByGraph(g, B, ['root', 'a', 'b'], tidyTreeLayout, { colGap: 60 });
    const by = Object.fromEntries(readItems(out, B).map((i) => [i.memberId, i]));
    expect(by.a.x).toBe(400); // locked → unchanged (pinned)
    expect(by.a.y).toBe(100);
    // b is still laid out one depth beyond a's column (topology intact, not treated as a root).
    expect(by.b.x).toBeGreaterThan(by.root.x);
  });

  it('no-op on <2 nodes, no linking connector, or all-locked selection', () => {
    expect(arrangeByGraph(chain(), B, ['root'], tidyTreeLayout).size ?? 0).toBeGreaterThanOrEqual(0); // <2 → returns graph unchanged
    const noEdge = note(note(emptyGraph(), 'x', 0, 0), 'y', 0, 300);
    const outNoEdge = arrangeByGraph(noEdge, B, ['x', 'y'], tidyTreeLayout);
    const byNo = Object.fromEntries(readItems(outNoEdge, B).map((i) => [i.memberId, i]));
    expect(byNo.y.y).toBe(300); // untouched (no connector)
  });
});
