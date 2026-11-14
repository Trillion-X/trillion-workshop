import { describe, expect, it } from 'vitest';
import {
  tidyTreeLayout,
  layeredDagLayout,
  radialTreeLayout,
  forceDirectedLayout,
  circularLayout,
  GRAPH_LAYOUTS,
  graphLayoutById,
  type GraphNode,
  type GraphEdge,
} from './graph-layout';

// A fixed-size node; x,y default 0 (visual tie-break only).
const N = (id: string, w = 100, h = 60, x = 0, y = 0): GraphNode => ({ memberId: id, w, h, x, y });
const E = (from: string, to: string): GraphEdge => ({ from, to });

describe('graph-layout (cont.25 — one engine shape, injected strategy, DATA catalog)', () => {
  // ── Strategy 1: tidy tree ──
  describe('tidyTreeLayout', () => {
    it('places children in the column to the RIGHT of the root and stacks siblings', () => {
      const pos = tidyTreeLayout([N('r'), N('a'), N('b')], [E('r', 'a'), E('r', 'b')], { colGap: 100, rowGap: 40 });
      expect(pos.get('a')!.x).toBe(pos.get('b')!.x); // same depth → same column
      expect(pos.get('a')!.x).toBeGreaterThan(pos.get('r')!.x); // deeper → further right
      expect(pos.get('b')!.y).toBeGreaterThan(pos.get('a')!.y); // stacked
    });
    it('an edgeless pile has no tree → empty map (caller leaves board untouched)', () => {
      expect(tidyTreeLayout([N('x'), N('y')], []).size).toBe(0);
    });
    it('a pure cycle (no indegree-0 root) stays empty — strict tree contract', () => {
      expect(tidyTreeLayout([N('a'), N('b')], [E('a', 'b'), E('b', 'a')]).size).toBe(0);
    });
    it('honours an explicit rootId even when the node has an incoming edge', () => {
      const pos = tidyTreeLayout([N('a'), N('b'), N('c')], [E('a', 'c'), E('b', 'c')], { rootId: 'b' });
      expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x);
    });
  });

  // ── Strategy 2: layered DAG ──
  describe('layeredDagLayout', () => {
    it('ranks a DIAMOND by LONGEST path — the merge node sits right of BOTH parents (a tree cannot)', () => {
      // a→b, a→c, b→d, c→d. depths: a=0, b=c=1, d=2.
      const pos = layeredDagLayout([N('a'), N('b'), N('c'), N('d')], [E('a', 'b'), E('a', 'c'), E('b', 'd'), E('c', 'd')]);
      expect(pos.get('b')!.x).toBe(pos.get('c')!.x); // same rank → same column
      expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
      expect(pos.get('d')!.x).toBeGreaterThan(pos.get('b')!.x); // merge deeper than its parents
    });
    it('a node reachable by paths of different length takes the LONGER depth', () => {
      // a→b→c and a→c. c's longest path from a is 2 (via b), not 1.
      const pos = layeredDagLayout([N('a'), N('b'), N('c')], [E('a', 'b'), E('b', 'c'), E('a', 'c')]);
      expect(pos.get('c')!.x).toBeGreaterThan(pos.get('b')!.x);
    });
    it('stacks same-rank peers vertically by stable visual order', () => {
      const pos = layeredDagLayout(
        [N('a'), N('b', 100, 60, 0, 200), N('c', 100, 60, 0, 10)],
        [E('a', 'b'), E('a', 'c')],
      );
      expect(pos.get('c')!.y).toBeLessThan(pos.get('b')!.y); // c has smaller y → sorts first
    });
    it('an edgeless pile → empty map', () => {
      expect(layeredDagLayout([N('x'), N('y')], []).size).toBe(0);
    });
  });

  // ── Strategy 3: radial mind-map ──
  describe('radialTreeLayout', () => {
    it('puts the root at the centre and every child one ring out (radius ≈ ringGap)', () => {
      const ringGap = 160;
      const pos = radialTreeLayout([N('r'), N('a'), N('b'), N('c')], [E('r', 'a'), E('r', 'b'), E('r', 'c')], { ringGap });
      const rc = center(pos.get('r')!, N('r'));
      for (const k of ['a', 'b', 'c']) {
        const kc = center(pos.get(k)!, N(k));
        const d = Math.hypot(kc.x - rc.x, kc.y - rc.y);
        expect(d).toBeGreaterThan(ringGap * 0.6); // out on the first ring, not on top of root
      }
    });
    it('allocates a WIDER angular wedge to the branch with more leaves (real mind-map, not a circle)', () => {
      // root → big (with 3 leaves) and small (a single leaf). big's subtree should span more angle.
      const nodes = [N('root'), N('big'), N('small'), N('b1'), N('b2'), N('b3')];
      const edges = [E('root', 'big'), E('root', 'small'), E('big', 'b1'), E('big', 'b2'), E('big', 'b3')];
      const pos = radialTreeLayout(nodes, edges, { ringGap: 160 });
      const rc = center(pos.get('root')!, N('root'));
      const ang = (id: string) => {
        const c = center(pos.get(id)!, N(id));
        return Math.atan2(c.y - rc.y, c.x - rc.x);
      };
      // big's three leaves fan across an angular range; small has none. Span(big-subtree) > 0.
      const bigLeafAngles = ['b1', 'b2', 'b3'].map(ang);
      const spread = Math.max(...bigLeafAngles) - Math.min(...bigLeafAngles);
      expect(spread).toBeGreaterThan(0.2); // the dense branch genuinely fans out
    });
    it('an edgeless pile → empty map; a linked pair lays out', () => {
      expect(radialTreeLayout([N('x'), N('y')], []).size).toBe(0);
      expect(radialTreeLayout([N('x'), N('y')], [E('x', 'y')]).size).toBe(2);
    });
    it('a pure cycle still lays out (breakCycles) — never a silent no-op when a relationship exists', () => {
      expect(radialTreeLayout([N('a'), N('b')], [E('a', 'b'), E('b', 'a')]).size).toBeGreaterThan(0);
    });
  });

  // ── DATA catalog (L090 — a new layout is one row, the board never names a strategy) ──
  // ── Strategy 4: force-directed (spring) ──
  describe('forceDirectedLayout', () => {
    // ring-seeded nodes (no x/y) so the sim starts spread out, not stacked at the origin.
    const Nf = (id: string): GraphNode => ({ memberId: id, w: 100, h: 60 });
    const dist = (pos: Map<string, { x: number; y: number }>, a: string, b: string): number => {
      const pa = pos.get(a)!;
      const pb = pos.get(b)!;
      return Math.hypot(pa.x - pb.x, pa.y - pb.y);
    };

    it('is deterministic — identical input → identical layout (no randomness)', () => {
      const run = () => forceDirectedLayout([Nf('a'), Nf('b'), Nf('c')], [E('a', 'b'), E('b', 'c')]);
      const A = run();
      const B = run();
      for (const id of ['a', 'b', 'c']) {
        expect(A.get(id)!.x).toBe(B.get(id)!.x);
        expect(A.get(id)!.y).toBe(B.get(id)!.y);
      }
    });

    it('pulls connected nodes together and pushes unconnected ones apart', () => {
      const connected = forceDirectedLayout([Nf('a'), Nf('b')], [E('a', 'b')]);
      const apart = forceDirectedLayout([Nf('a'), Nf('b')], []); // same seed, no spring
      expect(dist(connected, 'a', 'b')).toBeLessThan(dist(apart, 'a', 'b'));
    });

    it('places every node at a finite position (a hub + spokes settles cleanly)', () => {
      const nodes = ['h', 's1', 's2', 's3', 's4'].map(Nf);
      const edges = ['s1', 's2', 's3', 's4'].map((s) => E('h', s));
      const pos = forceDirectedLayout(nodes, edges);
      expect(pos.size).toBe(5);
      for (const nd of nodes) {
        const p = pos.get(nd.memberId)!;
        expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      }
    });

    it('empty node set → empty map', () => {
      expect(forceDirectedLayout([], []).size).toBe(0);
    });
  });

  describe('circularLayout', () => {
    const Nc = (id: string): GraphNode => N(id, 80, 50);
    // node centre = its emitted top-left + half its size (w80/h50)
    const centres = (pos: Map<string, { x: number; y: number }>) =>
      [...pos.entries()].map(([id, p]) => ({ id, x: p.x + 40, y: p.y + 25 }));

    it('places every node on ONE ring — centres equidistant from the centroid', () => {
      const pos = circularLayout(['a', 'b', 'c', 'd', 'e', 'f'].map(Nc), [E('a', 'b'), E('b', 'c'), E('c', 'd')]);
      expect(pos.size).toBe(6);
      const cs = centres(pos);
      const cx = cs.reduce((s, c) => s + c.x, 0) / cs.length;
      const cy = cs.reduce((s, c) => s + c.y, 0) / cs.length;
      const radii = cs.map((c) => Math.hypot(c.x - cx, c.y - cy));
      for (const r of radii) expect(Math.abs(r - radii[0])).toBeLessThan(1); // one ring
      expect(new Set([...pos.values()].map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)).size).toBe(6); // distinct
    });

    it('orders connected nodes adjacent — each node’s ring-neighbour is a graph neighbour (fewer long chords)', () => {
      const nodes = ['a', 'b', 'c', 'd', 'e'].map(Nc);
      const edges = [E('a', 'b'), E('b', 'c'), E('c', 'd'), E('d', 'e')]; // a path
      const pos = circularLayout(nodes, edges);
      const adj = new Map(nodes.map((n) => [n.memberId, new Set<string>()]));
      for (const e of edges) { adj.get(e.from)!.add(e.to); adj.get(e.to)!.add(e.from); }
      const cs = centres(pos);
      const cx = cs.reduce((s, c) => s + c.x, 0) / cs.length;
      const cy = cs.reduce((s, c) => s + c.y, 0) / cs.length;
      const ring = cs.map((c) => ({ id: c.id, ang: Math.atan2(c.y - cy, c.x - cx) })).sort((a, b) => a.ang - b.ang).map((o) => o.id);
      const m = ring.length;
      for (let i = 0; i < m; i += 1) {
        const nbrs = adj.get(ring[i])!;
        if (nbrs.size === 0) continue;
        expect(nbrs.has(ring[(i - 1 + m) % m]) || nbrs.has(ring[(i + 1) % m])).toBe(true);
      }
    });

    it('drops self-loops and edges to unknown nodes; still returns every node', () => {
      const pos = circularLayout([Nc('a'), Nc('b')], [E('a', 'a'), E('a', 'ghost'), E('a', 'b')]);
      expect(pos.has('ghost')).toBe(false);
      expect(pos.size).toBe(2);
    });

    it('is deterministic; empty → empty; single → origin', () => {
      const nodes = ['a', 'b', 'c'].map(Nc);
      expect(circularLayout(nodes, [E('a', 'b')])).toEqual(circularLayout(nodes, [E('a', 'b')]));
      expect(circularLayout([], []).size).toBe(0);
      expect(circularLayout([Nc('solo')], []).get('solo')).toEqual({ x: 0, y: 0 });
    });
  });

  describe('GRAPH_LAYOUTS catalog', () => {
    it('every entry has a unique id, a label, an icon, and a runnable strategy', () => {
      const ids = GRAPH_LAYOUTS.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const l of GRAPH_LAYOUTS) {
        expect(l.label.length).toBeGreaterThan(0);
        expect(l.icon.length).toBeGreaterThan(0);
        expect(typeof l.strategy).toBe('function');
        // each strategy produces a layout for a simple linked pair
        expect(l.strategy([N('a'), N('b')], [E('a', 'b')]).size).toBe(2);
      }
    });
    it('graphLayoutById resolves known / unknown / undefined', () => {
      expect(graphLayoutById('flow').id).toBe('flow');
      expect(graphLayoutById('nope')).toBe(GRAPH_LAYOUTS[0]);
      expect(graphLayoutById(undefined)).toBe(GRAPH_LAYOUTS[0]);
    });
  });

  // ── Cross-strategy invariants (the ENGINE-SHAPE contract every layout satisfies) ──
  describe('shared contract', () => {
    const strategies = [tidyTreeLayout, layeredDagLayout, radialTreeLayout];
    it('every strategy ignores self-loops and edges to unknown nodes', () => {
      for (const s of strategies) {
        const pos = s([N('a'), N('b')], [E('a', 'a'), E('a', 'ghost'), E('a', 'b')]);
        expect(pos.has('ghost')).toBe(false);
        expect(pos.size).toBe(2);
      }
    });
    it('every strategy is deterministic (same input → same output)', () => {
      const nodes = [N('a'), N('b'), N('c')];
      const edges = [E('a', 'b'), E('a', 'c')];
      for (const s of strategies) {
        expect([...s(nodes, edges).entries()]).toEqual([...s(nodes, edges).entries()]);
      }
    });
  });
});

/** Node top-left → centre (the leaf returns top-lefts; geometry reasoning is centre-based). */
function center(p: { x: number; y: number }, n: GraphNode): { x: number; y: number } {
  return { x: p.x + n.w / 2, y: p.y + n.h / 2 };
}

describe('graph-layout — a NaN gap option falls back to the default (cont.98 batch-7)', () => {
  // The strategies accumulate column/rank/ring offsets from these options; `?? default` misses NaN,
  // so a malformed DATA gap would poison every position into {NaN,NaN}. finiteGap fails closed.
  it('tidyTree / layeredDag / radial all stay finite under NaN gaps', () => {
    const nodes = [N('r'), N('a'), N('b')];
    const edges = [E('r', 'a'), E('r', 'b')];
    for (const layout of [tidyTreeLayout, layeredDagLayout, radialTreeLayout]) {
      const pos = layout(nodes, edges, { colGap: NaN, rowGap: NaN, ringGap: NaN, componentGap: NaN } as never);
      for (const p of pos.values()) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe('graph-layout — cont.98 batch-24 hardening (deep chains, dup edges, huge dims, wide graphs)', () => {
  // Chains built ITERATIVELY — a recursive fixture builder would overflow at construction (batch-23 memory).
  const chain = (n: number): { nodes: GraphNode[]; edges: GraphEdge[]; ids: string[] } => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) { nodes.push(N(`n${i}`)); ids.push(`n${i}`); }
    for (let i = 0; i + 1 < n; i += 1) edges.push(E(`n${i}`, `n${i + 1}`));
    return { nodes, edges, ids };
  };

  it('#1/#2/#3 none of the three strategies overflow on a 20000-deep connector chain', () => {
    const { nodes, edges } = chain(20000);
    expect(() => tidyTreeLayout(nodes, edges)).not.toThrow();
    expect(() => layeredDagLayout(nodes, edges)).not.toThrow();
    expect(() => radialTreeLayout(nodes, edges)).not.toThrow();
    // reverse node order (Codex #2: first depthOf walks the whole parent chain before any cache)
    expect(() => layeredDagLayout([...nodes].reverse(), edges)).not.toThrow();
  });

  it('#2/#3 a 20000-node pure CYCLE does not overflow (rootless, break-cycles path)', () => {
    const { nodes, edges } = chain(20000);
    edges.push(E('n19999', 'n0')); // close the loop → no indegree-0 root
    expect(() => layeredDagLayout(nodes, edges)).not.toThrow();
    expect(() => radialTreeLayout(nodes, edges)).not.toThrow();
  });

  it('#4 DUPLICATE edges do not change the tidy-tree layout (dedup → correct centering)', () => {
    const nodes = [N('r'), N('a'), N('b')];
    const withDup = tidyTreeLayout(nodes, [E('r', 'a'), E('r', 'b'), E('r', 'a')], { colGap: 100, rowGap: 40 });
    const noDup = tidyTreeLayout(nodes, [E('r', 'a'), E('r', 'b')], { colGap: 100, rowGap: 40 });
    for (const id of ['r', 'a', 'b']) expect(withDup.get(id)).toEqual(noDup.get(id));
    // and the root is centred strictly BETWEEN its two children (the bug centred it on 'a')
    expect(withDup.get('r')!.y).toBeGreaterThan(withDup.get('a')!.y);
    expect(withDup.get('r')!.y).toBeLessThan(withDup.get('b')!.y);
  });

  it('#5 DUPLICATE edges do not change the radial layout (dedup → no phantom wedge)', () => {
    const nodes = [N('r'), N('a'), N('b')];
    const withDup = radialTreeLayout(nodes, [E('r', 'a'), E('r', 'a'), E('r', 'b')], { ringGap: 100 });
    const noDup = radialTreeLayout(nodes, [E('r', 'a'), E('r', 'b')], { ringGap: 100 });
    for (const id of ['r', 'a', 'b']) expect(withDup.get(id)).toEqual(noDup.get(id));
    expect(withDup.size).toBe(3); // all three placed, no dropped/phantom node
  });

  it('#6 Number.MAX_VALUE node dimensions never produce a non-finite position', () => {
    const M = Number.MAX_VALUE;
    const nodes = [N('a', M, 60), N('b', M, 60), N('c', M, 60)];
    const edges = [E('a', 'b'), E('b', 'c')];
    for (const strat of [tidyTreeLayout, layeredDagLayout, radialTreeLayout]) {
      for (const p of strat(nodes, edges).values()) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
  });

  it('#7 a very WIDE graph (150000 children) does not throw via Math.max(...spread)', () => {
    const nodes: GraphNode[] = [N('root')];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 150000; i += 1) { nodes.push(N(`k${i}`)); edges.push(E('root', `k${i}`)); }
    expect(() => tidyTreeLayout(nodes, edges)).not.toThrow();
    expect(() => layeredDagLayout(nodes, edges)).not.toThrow();
  });
});
