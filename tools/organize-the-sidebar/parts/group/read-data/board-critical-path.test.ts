// packages/group/read-data/board-critical-path.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import { criticalPathOf } from '../../../read-data/board-critical-path.ts';

// A tiny DAG helper: `deps` maps a goal to its direct prerequisites, `hours` to its remaining effort.
function graph(deps: Record<string, string[]>, hours: Record<string, number | null>) {
  return {
    childrenOf: (id: string) => deps[id] ?? [],
    durationHoursOf: (id: string) => (id in hours ? hours[id] : null),
  };
}

describe('board-critical-path CPM leaf', () => {
  it('linear chain: effort sums along the chain, every goal is critical', () => {
    const g = graph({ root: ['a'], a: ['b'], b: [] }, { root: 2, a: 3, b: 1 });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.finishHours).toBe(6); // 2 + 3 + 1
    expect(r.knownFinishHours).toBe(6);
    expect(r.criticalPath).toEqual(['root', 'a', 'b']);
    expect([...r.bottleneckIds].sort()).toEqual(['a', 'b', 'root']); // all zero-slack
    expect(r.primaryBottleneckId).toBe('a'); // largest effort among critical (3)
    expect(r.cycleDetected).toBe(false);
    expect(r.unknownDurationIds).toEqual([]);
  });

  it('diamond: the shorter branch carries slack and is NOT a bottleneck', () => {
    // root <- a <- c  and  root <- b <- c ; a is the heavy branch.
    const g = graph({ root: ['a', 'b'], a: ['c'], b: ['c'], c: [] }, { root: 1, a: 5, b: 1, c: 2 });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.finishHours).toBe(8); // 1 + max(5+2, 1+2) = 1 + 7
    expect(r.criticalPath).toEqual(['root', 'a', 'c']);
    expect([...r.bottleneckIds].sort()).toEqual(['a', 'c', 'root']);
    expect(r.bottleneckIds).not.toContain('b'); // b has slack
    const b = r.nodes.find((n) => n.id === 'b')!;
    expect(b.slackHours).toBe(4); // b can slip 4h without moving the root
    expect(b.critical).toBe(false);
    expect(r.primaryBottleneckId).toBe('a'); // 5 is the largest critical effort
  });

  it('an unmeasured goal makes the finish non-authoritative (finishHours null) but keeps the lower bound', () => {
    const g = graph({ root: ['a'], a: [] }, { root: 2, a: null });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.finishHours).toBeNull(); // cannot claim a total with a missing estimate
    expect(r.knownFinishHours).toBe(2); // measured lower bound (a counts as 0)
    expect(r.unknownDurationIds).toEqual(['a']);
  });

  it('a dependency cycle fails closed — no schedule, cycle flagged', () => {
    const g = graph({ root: ['a'], a: ['root'] }, { root: 1, a: 1 });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.cycleDetected).toBe(true);
    expect(r.finishHours).toBeNull();
    expect(r.criticalPath).toEqual([]);
    expect(r.bottleneckIds).toEqual([]);
  });

  it('duplicate prerequisites are de-duped (a doubled connector cannot overweight a dependency)', () => {
    const g = graph({ root: ['a', 'a', 'a'], a: [] }, { root: 1, a: 4 });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.finishHours).toBe(5); // 1 + 4, NOT 1 + 4*3
    expect(r.criticalPath).toEqual(['root', 'a']);
  });

  it('a leaf root with no prerequisites is its own critical path', () => {
    const g = graph({ solo: [] }, { solo: 3 });
    const r = criticalPathOf('solo', g.childrenOf, g.durationHoursOf);
    expect(r.finishHours).toBe(3);
    expect(r.criticalPath).toEqual(['solo']);
    expect(r.bottleneckIds).toEqual(['solo']);
    expect(r.primaryBottleneckId).toBe('solo');
  });

  it('per-goal nodes carry earliest-finish + slack for slack badges', () => {
    const g = graph({ root: ['a', 'b'], a: ['c'], b: ['c'], c: [] }, { root: 1, a: 5, b: 1, c: 2 });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    const byId = Object.fromEntries(r.nodes.map((n) => [n.id, n]));
    expect(byId.c.earliestFinishHours).toBe(2);
    expect(byId.a.earliestFinishHours).toBe(7);
    expect(byId.root.slackHours).toBe(0);
    expect(byId.b.durationHours).toBe(1);
    expect(r.nodes.length).toBe(4);
  });

  it('a self-dependency is the smallest cycle — fails closed exactly like a 2-cycle', () => {
    const g = graph({ root: ['root'] }, { root: 1 }); // "root must finish before root can start" — impossible
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.cycleDetected).toBe(true);
    expect(r.finishHours).toBeNull();
    expect(r.criticalPath).toEqual([]);
  });

  it('an all-complete plan (every effort 0) has NO primary bottleneck — nothing is "the work to do"', () => {
    const g = graph({ root: ['a'], a: [] }, { root: 0, a: 0 }); // every goal already done
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.finishHours).toBe(0);
    expect(r.primaryBottleneckId).toBeNull(); // a zero-effort goal is done, not a bottleneck
  });
});

describe('board-critical-path — deep chain never blows the JS call stack (cont.98 batch-19)', () => {
  // A crafted/persisted board can wire a `root <- n1 <- n2 <- …` dependency chain of tens of thousands of
  // goals (childrenOf is connector-derived and reaches criticalPathOf live from the panel). The former
  // recursive DFS overflowed the call stack at that depth; the iterative walk is O(N) and never recurses.
  const N = 60_000;

  function longChain(n: number) {
    const deps: Record<string, string[]> = {};
    const hours: Record<string, number> = {};
    for (let i = 0; i < n; i += 1) {
      deps[`g${i}`] = i + 1 < n ? [`g${i + 1}`] : [];
      hours[`g${i}`] = 1;
    }
    return graph(deps, hours);
  }

  it(`a ${N}-deep prerequisite chain computes without a RangeError`, () => {
    const g = longChain(N);
    let result: ReturnType<typeof criticalPathOf> | undefined;
    expect(() => { result = criticalPathOf('g0', g.childrenOf, g.durationHoursOf); }).not.toThrow();
    expect(result!.cycleDetected).toBe(false);
    expect(result!.finishHours).toBe(N); // 1 effort-hour per goal along the whole chain
    expect(result!.nodes.length).toBe(N);
  });

  it('a deep chain that loops back at the bottom still fails closed (cycle), no overflow', () => {
    const deps: Record<string, string[]> = {};
    const hours: Record<string, number> = {};
    for (let i = 0; i < 40_000; i += 1) { deps[`g${i}`] = [`g${i + 1}`]; hours[`g${i}`] = 1; }
    deps['g40000'] = ['g0']; hours['g40000'] = 1; // back-edge to the root → cycle
    const g = graph(deps, hours);
    let result: ReturnType<typeof criticalPathOf> | undefined;
    expect(() => { result = criticalPathOf('g0', g.childrenOf, g.durationHoursOf); }).not.toThrow();
    expect(result!.cycleDetected).toBe(true);
    expect(result!.finishHours).toBeNull();
  });
});

describe('board-critical-path red-team — untrusted graph hardening (cont.98 batch-30)', () => {
  // #6: a pathologically large dependency closure fails closed (no schedule) instead of freezing —
  // a 200k-node chain exceeds MAX_CRITICAL_NODES (100k). The chain accessor is generated, so no huge
  // literal is built (and the iterative walk means the failure is the cap, not a stack overflow).
  it('fails closed on a graph larger than MAX_CRITICAL_NODES (no hang, no throw)', () => {
    const childrenOf = (id: string) => { const n = Number(id); return n < 200_000 ? [String(n + 1)] : []; };
    const durationHoursOf = () => 1;
    let r: ReturnType<typeof criticalPathOf> | undefined;
    expect(() => { r = criticalPathOf('0', childrenOf, durationHoursOf); }).not.toThrow();
    expect(r!.finishHours).toBeNull(); // fail-closed: no schedule computed
    expect(r!.nodes).toEqual([]);
  });

  // #7: a finite-but-absurd duration (Number.MAX_VALUE) is treated as UNKNOWN, not summed into an
  // Infinity/NaN schedule — the goal surfaces as needing an estimate, finishHours stays null (honest).
  it('treats a Number.MAX_VALUE duration as unknown (no Infinity/NaN overflow)', () => {
    const g = graph({ root: ['a'], a: [] }, { root: 2, a: Number.MAX_VALUE });
    const r = criticalPathOf('root', g.childrenOf, g.durationHoursOf);
    expect(r.unknownDurationIds).toContain('a');
    expect(r.finishHours).toBeNull();
    for (const n of r.nodes) {
      expect(Number.isFinite(n.earliestFinishHours)).toBe(true);
      expect(Number.isFinite(n.slackHours)).toBe(true);
    }
  });

  // #8: each goal's duration accessor is read exactly ONCE (memoized), so an impure/expensive accessor
  // can't make the four passes disagree and can't amplify CPU.
  it('reads each duration accessor exactly once (memoized)', () => {
    const deps: Record<string, string[]> = { root: ['a', 'b'], a: ['c'], b: ['c'], c: [] };
    const hours: Record<string, number> = { root: 1, a: 5, b: 1, c: 2 };
    const calls: Record<string, number> = Object.create(null);
    const durationHoursOf = (id: string) => { calls[id] = (calls[id] ?? 0) + 1; return id in hours ? hours[id] : null; };
    criticalPathOf('root', (id) => deps[id] ?? [], durationHoursOf);
    for (const id of Object.keys(hours)) expect(calls[id]).toBe(1);
  });
});
