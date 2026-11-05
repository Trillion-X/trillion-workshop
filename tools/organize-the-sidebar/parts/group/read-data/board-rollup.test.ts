// Proof for the rollup leaf: branch-normalized recursive mean (each direct child equal say, NOT leaf-
// weighted), own-metric fallback for leaves, own-fraction kept separate from rollup, coverage counts,
// and cycle-safety. The leaf is BLIND — childrenOf + fractionOf are injected (no graph/metric imports).
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { hasChildren, rollupOf } from '../../../read-data/board-rollup.ts';

// A tiny fixture tree via plain maps (the bridge builds these from the graph + metric leaves).
const childrenMap: Record<string, string[]> = {
  fit: ['run', 'health'],       // vision -> two branches
  health: ['diet', 'sleep', 'x'], // one branch that itself splits into three
  run: [],
  diet: [],
  sleep: [],
  x: [],                        // an UNMEASURED leaf (no metric)
};
const fractionMap: Record<string, number | null> = {
  fit: 0.1,   // the vision has its OWN token metric — must NOT leak into the rollup
  run: 0.5,
  diet: 0.9,
  sleep: 0.9,
  x: null,    // unmeasured → contributes nothing
};
const childrenOf = (id: string) => childrenMap[id] ?? [];
const fractionOf = (id: string) => (id in fractionMap ? fractionMap[id] : null);

describe('board-rollup — the pure branch-normalized tree reducer', () => {
  it('rolls up branch-normalized (each direct child equal say), NOT leaf-weighted', () => {
    // health = mean(diet .9, sleep .9) = .9 (x is unmeasured, excluded); contributing 2 of 3.
    const health = rollupOf('health', childrenOf, fractionOf);
    expect(health.fraction).toBeCloseTo(0.9);
    expect(health.childCount).toBe(3);
    expect(health.contributingChildCount).toBe(2);
    // fit = mean(run .5, health .9) = .7 — branch-normalized: the 'health' branch (2 leaves) does NOT
    // outweigh the single 'run' leaf. A leaf-weighted average would be (.5 + .9 + .9)/3 = .766.
    const fit = rollupOf('fit', childrenOf, fractionOf);
    expect(fit.fraction).toBeCloseTo(0.7);
    expect(fit.childCount).toBe(2);
    expect(fit.contributingChildCount).toBe(2);
  });

  it('keeps the node OWN fraction separate from the rollup (no blend)', () => {
    const fit = rollupOf('fit', childrenOf, fractionOf);
    expect(fit.ownFraction).toBe(0.1); // the vision's own metric...
    expect(fit.fraction).toBeCloseTo(0.7); // ...never leaks into the child rollup
  });

  it('a leaf with a metric rolls up to its own fraction; an unmeasured node → no fraction', () => {
    expect(rollupOf('run', childrenOf, fractionOf).fraction).toBeUndefined(); // no children, but a leaf has none to aggregate
    expect(rollupOf('run', childrenOf, fractionOf).childCount).toBe(0);
    // a parent whose only child is unmeasured → undefined fraction, contributing 0
    const onlyX = rollupOf('lonely', (id) => (id === 'lonely' ? ['x'] : []), fractionOf);
    expect(onlyX.fraction).toBeUndefined();
    expect(onlyX.contributingChildCount).toBe(0);
    expect(onlyX.childCount).toBe(1);
  });

  it('is cycle-safe: a cycle contributes nothing and is flagged', () => {
    const cyc: Record<string, string[]> = { a: ['b'], b: ['a'] }; // a <-> b
    const frac = (id: string) => (id === 'b' ? 0.4 : null);
    const r = rollupOf('a', (id) => cyc[id] ?? [], frac);
    // a -> b (0.4); b -> a but a is on the path → skipped, so b falls back to its own 0.4.
    expect(r.fraction).toBeCloseTo(0.4);
    expect(r.cycleDetected).toBe(true);
  });

  it('hasChildren gates whether a rollup badge is meaningful', () => {
    expect(hasChildren('fit', childrenOf)).toBe(true);
    expect(hasChildren('run', childrenOf)).toBe(false);
  });

  it('a NaN/Infinity metric is treated as UNMEASURED — never poisons the mean, never counts as coverage (cont.98 batch-9)', () => {
    // health = mean(diet .9, sleep .9, bad) — but 'bad' returns NaN. clamp01(NaN) === NaN, so without the
    // cleanFraction SSOT that NaN would (a) poison mean() → NaN fraction, and (b) be counted as a
    // contributing child (fake coverage). It must instead be dropped like an unmeasured node.
    const kids: Record<string, string[]> = { top: ['ok', 'bad'], ok: [], bad: [] };
    const frac = (id: string): number | null => (id === 'ok' ? 0.8 : id === 'bad' ? (NaN as number) : null);
    const top = rollupOf('top', (id) => kids[id] ?? [], frac);
    expect(top.fraction).toBeCloseTo(0.8); // only the finite child counts — NOT NaN
    expect(Number.isFinite(top.fraction as number)).toBe(true);
    expect(top.childCount).toBe(2);
    expect(top.contributingChildCount).toBe(1); // the NaN child is not coverage

    // A node whose OWN metric is Infinity → unmeasured, not a poisoning value.
    const infOwn = rollupOf('solo', () => [], () => (Infinity as number));
    expect(infOwn.ownFraction).toBeNull();
    expect(infOwn.value).toBeUndefined();
    expect(infOwn.fraction).toBeUndefined();
  });
});

describe('board-rollup — deep chain + diamond DAG are bounded, no overflow / no exponential hang (cont.98 batch-19)', () => {
  // The former per-path recursion had TWO reachable failure modes on a connector-derived graph:
  //  (1) stack overflow on a deep chain; (2) EXPONENTIAL blowup on a diamond DAG (a node shared by K
  // parents was recomputed along every path). The iterative one-visit-per-node fold is O(V+E) for both.
  it('a 60k-deep chain rolls up without a RangeError', () => {
    const N = 60_000;
    const children: Record<string, string[]> = {};
    for (let i = 0; i < N; i += 1) children[`g${i}`] = i + 1 < N ? [`g${i + 1}`] : [];
    const childrenOf = (id: string) => children[id] ?? [];
    const fractionOf = (id: string) => (id === `g${N - 1}` ? 0.5 : null); // only the deepest leaf is measured
    let r: ReturnType<typeof rollupOf> | undefined;
    expect(() => { r = rollupOf('g0', childrenOf, fractionOf); }).not.toThrow();
    expect(r!.fraction).toBeCloseTo(0.5, 10); // the single measured leaf propagates up every branch mean
    expect(r!.cycleDetected).toBe(false);
  });

  it('a wide diamond DAG (shared node under every parent) folds in linear time, not 2^depth', () => {
    // Build a "ladder" where every level's two nodes BOTH point to the single next-level node — the classic
    // shape that makes per-path recursion exponential. 40 levels ⇒ 2^40 paths if recomputed per path.
    const LEVELS = 40;
    const children: Record<string, string[]> = {};
    for (let i = 0; i < LEVELS; i += 1) {
      children[`a${i}`] = [`n${i + 1}`];
      children[`b${i}`] = [`n${i + 1}`];
      children[`n${i}`] = [`a${i}`, `b${i}`];
    }
    children[`n${LEVELS}`] = [];
    const childrenOf = (id: string) => children[id] ?? [];
    const fractionOf = (id: string) => (id === `n${LEVELS}` ? 1 : null);
    let r: ReturnType<typeof rollupOf> | undefined;
    const start = () => { r = rollupOf('n0', childrenOf, fractionOf); };
    expect(start).not.toThrow(); // completes ~instantly; a 2^40 per-path expansion would hang the test
    expect(r!.cycleDetected).toBe(false);
    expect(r!.fraction).toBeCloseTo(1, 10); // the shared measured sink propagates up
  });

  it('a direct self-dependency still contributes nothing and flags the cycle (semantics preserved)', () => {
    const childrenOf = (id: string) => (id === 'self' ? ['self'] : []);
    const fractionOf = (id: string) => (id === 'self' ? 0.3 : null);
    const r = rollupOf('self', childrenOf, fractionOf);
    expect(r.cycleDetected).toBe(true);
    expect(r.fraction).toBeUndefined(); // the self-edge is dropped → no measured children
    expect(r.ownFraction).toBe(0.3); // own metric still reported
    expect(r.value).toBe(0.3); // falls back to own when no child rollup
  });
});
