// packages/group/read-data/relationship-graph.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildRelationGraph,
  DEFAULT_RELATION_KIND,
  impactCone,
  isInCycle,
  neighbors,
  reachableFrom,
  reachableTo,
  relationKinds,
  relationsFrom,
  relationsTo,
  shortestPath,
  pathEdges,
  pathBetween,
} from './relationship-graph';
import { relationKindSpec } from './relation-kind-catalog';
import type { BoardItem } from './group-board-model';

const node = (memberId: string): BoardItem =>
  ({ kind: 'note', memberId, x: 0, y: 0, w: 100, h: 40, extra: {} } as unknown as BoardItem);

const conn = (memberId: string, from: string, to: string, relationKind?: string, label?: string): BoardItem =>
  ({
    kind: 'connector',
    memberId,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    extra: { fromMemberId: from, toMemberId: to, ...(relationKind ? { relationKind } : {}), ...(label ? { label } : {}) },
  } as unknown as BoardItem);

// build → test → deploy: Deploy depends-on Build & Test; Build blocks Ship; a bare link.
const items: BoardItem[] = [
  node('build'),
  node('test'),
  node('deploy'),
  node('ship'),
  conn('c1', 'deploy', 'build', 'depends-on'),
  conn('c2', 'deploy', 'test', 'depends-on'),
  conn('c3', 'build', 'ship', 'blocks'),
  conn('c4', 'build', 'test'), // untyped → default kind
];

describe('buildRelationGraph', () => {
  it('derives edges only from connectors, with self-describing kind', () => {
    const g = buildRelationGraph(items);
    expect(g.edges).toHaveLength(4);
    expect(g.edges.find((e) => e.memberId === 'c4')!.kind).toBe(DEFAULT_RELATION_KIND);
    expect(g.edges.find((e) => e.memberId === 'c1')!.kind).toBe('depends-on');
  });

  it('ignores non-connector items (nodes contribute no edges)', () => {
    expect(buildRelationGraph([node('a'), node('b')]).edges).toHaveLength(0);
  });

  it('drops a DANGLING connector whose endpoint is not a present member (no phantom edge)', () => {
    // A connector to a deleted / out-of-scope node must NOT become a real edge — a phantom prerequisite
    // miscounts a rollup and turns a critical path non-authoritative.
    const g = buildRelationGraph([node('parent'), conn('e1', 'ghost', 'parent', 'contributes-to')]);
    expect(g.edges).toHaveLength(0);
    expect(relationsTo(g, 'parent', 'contributes-to')).toHaveLength(0); // parent has no child 'ghost'
    // a connector with BOTH endpoints present still connects
    const g2 = buildRelationGraph([node('a'), node('b'), conn('e2', 'a', 'b', 'contributes-to')]);
    expect(g2.edges).toHaveLength(1);
  });
});

describe('directional queries', () => {
  const g = buildRelationGraph(items);
  it('relationsFrom returns out-edges, filterable by kind', () => {
    expect(relationsFrom(g, 'deploy').map((e) => e.to).sort()).toEqual(['build', 'test']);
    expect(relationsFrom(g, 'deploy', 'depends-on')).toHaveLength(2);
    expect(relationsFrom(g, 'build', 'depends-on')).toHaveLength(0); // build's out-edge is 'blocks'/default
  });

  it('relationsTo returns in-edges, filterable by kind', () => {
    expect(relationsTo(g, 'test').map((e) => e.from).sort()).toEqual(['build', 'deploy']);
    expect(relationsTo(g, 'ship', 'blocks').map((e) => e.from)).toEqual(['build']);
  });

  it('neighbors are the distinct related members, both directions, sorted', () => {
    expect(neighbors(g, 'build')).toEqual(['deploy', 'ship', 'test']);
  });
});

describe('relationKinds + reachability', () => {
  const g = buildRelationGraph(items);
  it('lists distinct kinds present, sorted', () => {
    expect(relationKinds(g)).toEqual(['blocks', 'depends-on', DEFAULT_RELATION_KIND].sort());
  });

  it('reachableFrom follows out-edges transitively, cycle-safe', () => {
    // deploy → build → ship, deploy → build → test, deploy → test
    expect(reachableFrom(g, 'deploy')).toEqual(['build', 'ship', 'test']);
    // scoped to one kind: only depends-on out-edges
    expect(reachableFrom(g, 'deploy', 'depends-on')).toEqual(['build', 'test']);
  });

  it('reachableFrom terminates on a cycle', () => {
    const cyclic = buildRelationGraph([
      node('a'),
      node('b'),
      conn('e1', 'a', 'b', 'leads-to'),
      conn('e2', 'b', 'a', 'leads-to'),
    ]);
    expect(reachableFrom(cyclic, 'a')).toEqual(['b']);
  });
});

describe('reachableTo — transitive upstream (the prerequisite chain)', () => {
  const g = buildRelationGraph(items);

  it('follows in-edges transitively — everything that must finish before this card', () => {
    // ship <- build <- deploy ; so ship transitively waits on build and deploy
    expect(reachableTo(g, 'ship')).toEqual(['build', 'deploy']);
    // test <- {deploy, build}, and build <- deploy
    expect(reachableTo(g, 'test')).toEqual(['build', 'deploy']);
    // deploy is a root — it waits on nothing
    expect(reachableTo(g, 'deploy')).toEqual([]);
  });

  it('is scopable by relationship kind (only the depends-on prerequisites)', () => {
    // test's depends-on in-edge is from deploy (the build->test edge is the default kind, excluded)
    expect(reachableTo(g, 'test', 'depends-on')).toEqual(['deploy']);
  });

  it('is the exact mirror of reachableFrom (a is upstream of b iff b is downstream of a)', () => {
    expect(reachableFrom(g, 'deploy')).toContain('ship');
    expect(reachableTo(g, 'ship')).toContain('deploy');
  });

  it('terminates on a cycle', () => {
    const cyclic = buildRelationGraph([
      node('a'),
      node('b'),
      conn('e1', 'a', 'b', 'leads-to'),
      conn('e2', 'b', 'a', 'leads-to'),
    ]);
    expect(reachableTo(cyclic, 'a')).toEqual(['b']);
  });
});

describe('impactCone — the full dependency cone a change touches', () => {
  const g = buildRelationGraph(items);

  it('is self + all upstream + all downstream, sorted', () => {
    // build: upstream {deploy}, downstream {ship, test}, plus itself
    expect(impactCone(g, 'build')).toEqual(['build', 'deploy', 'ship', 'test']);
  });

  it('a fully isolated card is its own cone', () => {
    const lone = buildRelationGraph([node('solo'), node('x'), conn('e', 'x', 'x')]);
    expect(impactCone(lone, 'solo')).toEqual(['solo']);
  });
});

describe('isInCycle — circular dependency detection', () => {
  it('flags every node on a 2-cycle', () => {
    const g = buildRelationGraph([node('a'), node('b'), conn('e1', 'a', 'b', 'depends-on'), conn('e2', 'b', 'a', 'depends-on')]);
    expect(isInCycle(g, 'a')).toBe(true);
    expect(isInCycle(g, 'b')).toBe(true);
  });

  it('flags a longer cycle (a→b→c→a) but not a node hanging off it', () => {
    const g = buildRelationGraph([
      node('a'),
      node('b'),
      node('c'),
      node('d'),
      conn('e1', 'a', 'b', 'depends-on'),
      conn('e2', 'b', 'c', 'depends-on'),
      conn('e3', 'c', 'a', 'depends-on'),
      conn('e4', 'c', 'd', 'depends-on'), // d hangs off the cycle
    ]);
    expect(isInCycle(g, 'a')).toBe(true);
    expect(isInCycle(g, 'c')).toBe(true);
    expect(isInCycle(g, 'd')).toBe(false); // d has no out-edges → not on a cycle
  });

  it('returns false for an acyclic (DAG) graph', () => {
    const g = buildRelationGraph([node('a'), node('b'), node('c'), conn('e1', 'a', 'b', 'depends-on'), conn('e2', 'b', 'c', 'depends-on')]);
    expect(isInCycle(g, 'a')).toBe(false);
    expect(isInCycle(g, 'c')).toBe(false);
  });

  it('is kind-scoped — a cycle in one kind does not count under another', () => {
    const g = buildRelationGraph([node('a'), node('b'), conn('e1', 'a', 'b', 'depends-on'), conn('e2', 'b', 'a', 'blocks')]);
    // following only 'depends-on' out-edges, a→b then b has no depends-on out → no cycle
    expect(isInCycle(g, 'a', 'depends-on')).toBe(false);
    // following ANY kind, a→b→a → cycle
    expect(isInCycle(g, 'a')).toBe(true);
  });
});

describe('relation-kind catalog (Society DATA)', () => {
  it('resolves known kinds to label + colour + arrow', () => {
    expect(relationKindSpec('depends-on').label).toBe('depends on');
    expect(relationKindSpec('blocks').color).toBe('#e5484d');
  });

  it('falls back gracefully for an unknown kind (never throws)', () => {
    const spec = relationKindSpec('supersedes');
    expect(spec.label).toBe('supersedes');
    expect(spec.arrow).toBe('end');
  });

  it('honours an injected catalog override (L090 — no code branch)', () => {
    const spec = relationKindSpec('mentors', { mentors: { id: 'mentors', label: 'mentors', color: '#000' } });
    expect(spec.color).toBe('#000');
  });
});

describe('prototype-key member ids never crash the adjacency maps (cont.98 batch-15)', () => {
  it("a '__proto__' / 'constructor' memberId + connector builds and queries without crashing", () => {
    // A crafted/corrupted item can carry memberId '__proto__'. On a plain {} adjacency map, out['__proto__']
    // is Object.prototype (not an array) → pushEdge's .push throws, and every query spreads/filters it → crash.
    const items = [node('__proto__'), node('b'), conn('e', '__proto__', 'b', 'blocks')];
    let g!: ReturnType<typeof buildRelationGraph>;
    expect(() => {
      g = buildRelationGraph(items);
    }).not.toThrow();
    // the edge __proto__ -> b is a real relationship (both endpoints exist) and is queryable.
    expect(relationsFrom(g, '__proto__').map((e) => e.to)).toEqual(['b']);
    expect(relationsTo(g, 'b').map((e) => e.from)).toEqual(['__proto__']);
    expect(neighbors(g, '__proto__')).toEqual(['b']);
    expect(reachableFrom(g, '__proto__')).toEqual(['b']);
    // an ABSENT prototype-chain id resolves to [] (not Object.prototype), never a crash.
    expect(() => relationsFrom(g, 'constructor')).not.toThrow();
    expect(relationsFrom(g, 'constructor')).toEqual([]);
    expect(neighbors(g, 'toString')).toEqual([]);
  });
});

describe('shortestPath / pathEdges / pathBetween — trace the chain between two cards', () => {
  // a -> b (blocks), a -> c (relates-to, a SHORTCUT), b -> c (blocks), c -> d (blocks), b -> e; z isolated.
  const graph = buildRelationGraph([
    node('a'), node('b'), node('c'), node('d'), node('e'), node('z'),
    conn('ab', 'a', 'b', 'blocks'),
    conn('ac', 'a', 'c', 'relates-to'),
    conn('bc', 'b', 'c', 'blocks'),
    conn('cd', 'c', 'd', 'blocks'),
    conn('be', 'b', 'e'),
  ]);

  it('finds the MINIMUM-length route (via the shortcut, not the long chain)', () => {
    expect(shortestPath(graph, 'a', 'd')).toEqual(['a', 'c', 'd']); // a->c->d (2) beats a->b->c->d (3)
  });

  it('a node to itself is the trivial one-node path', () => {
    expect(shortestPath(graph, 'a', 'a')).toEqual(['a']);
  });

  it('returns [] when the target is not reachable (wrong direction / isolated node)', () => {
    expect(shortestPath(graph, 'd', 'a')).toEqual([]); // no back-edges
    expect(shortestPath(graph, 'a', 'z')).toEqual([]); // z has no edges
  });

  it('a kind filter changes the route (only edges of that kind are traversable)', () => {
    // Unfiltered: the relates-to shortcut a->c wins. Filtered to blocks: a->c is excluded, so a->b->c.
    expect(shortestPath(graph, 'a', 'c')).toEqual(['a', 'c']);
    expect(shortestPath(graph, 'a', 'c', 'blocks')).toEqual(['a', 'b', 'c']);
  });

  it('pathEdges returns the connectors along the path (to highlight)', () => {
    const edges = pathEdges(graph, shortestPath(graph, 'a', 'd'));
    expect(edges.map((e) => e.memberId)).toEqual(['ac', 'cd']);
    expect(edges.map((e) => [e.from, e.to])).toEqual([['a', 'c'], ['c', 'd']]);
    expect(pathEdges(graph, ['a'])).toEqual([]); // a single-node path has no hops
  });

  it('pathBetween connects two cards regardless of arrow direction', () => {
    expect(pathBetween(graph, 'd', 'a')).toEqual(['a', 'c', 'd']); // d->a fails, a->d succeeds
    expect(pathBetween(graph, 'a', 'd')).toEqual(['a', 'c', 'd']);
    expect(pathBetween(graph, 'e', 'z')).toEqual([]); // genuinely unconnected either way
  });
});
