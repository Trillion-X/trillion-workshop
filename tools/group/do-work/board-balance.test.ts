// packages/group/do-work/board-balance.test.ts
import { describe, it, expect } from 'vitest';
import {
  boundsOf,
  areaCentroid,
  quadrantShares,
  occupancyOf,
  analyzeBalance,
  balanceBand,
  BALANCE_METRICS,
  type BalRect,
} from './board-balance';

const rect = (x: number, y: number, w = 40, h = 40): BalRect => ({ x, y, w, h });

// A balanced 2×2 grid (one card per quadrant, equal size).
const balanced: BalRect[] = [rect(0, 0), rect(200, 0), rect(0, 200), rect(200, 200)];
// A lopsided board: four cards crammed in the top-left, one lone card far bottom-right — the bounds spans the
// whole canvas but the mass sits in one corner. (Balance is scale-invariant vs the cards' own bounds, so the
// asymmetry MUST live inside a large bounds, not be a self-similar tight grid.)
const lopsided: BalRect[] = [rect(0, 0), rect(20, 0), rect(0, 20), rect(20, 20), rect(400, 400)];

describe('boundsOf', () => {
  it('spans every rect; empty → a zero box', () => {
    const b = boundsOf(balanced);
    expect(b.minX).toBe(0);
    expect(b.maxX).toBe(240);
    expect(b.cx).toBe(120);
    expect(boundsOf([]).w).toBe(0);
  });
});

describe('areaCentroid', () => {
  it('a symmetric grid centres its mass in the middle', () => {
    const b = boundsOf(balanced);
    const c = areaCentroid(balanced, b);
    expect(c.x).toBeCloseTo(b.cx, 5);
    expect(c.y).toBeCloseTo(b.cy, 5);
  });
  it('a lopsided pile pulls the centroid toward the crowded corner', () => {
    const b = boundsOf(lopsided);
    const c = areaCentroid(lopsided, b);
    // all cards near the top-left → centroid sits in the top-left half of the (small) bounds
    expect(c.x).toBeLessThanOrEqual(b.cx + 1);
    expect(c.y).toBeLessThanOrEqual(b.cy + 1);
  });
  it('empty → the bounds centre', () => {
    const c = areaCentroid([], boundsOf([]));
    expect(c).toEqual({ x: 0, y: 0 });
  });
});

describe('quadrantShares', () => {
  it('a 2×2 grid splits area evenly across all four quadrants', () => {
    const q = quadrantShares(balanced);
    for (const share of q) expect(share).toBeCloseTo(0.25, 5);
    expect(q.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 5);
  });
  it('a top-left pile puts (almost) all area in one quadrant', () => {
    const q = quadrantShares(lopsided); // [tl, tr, bl, br]
    expect(q[0]).toBeGreaterThan(0.6);
    expect(q[1] + q[3]).toBeLessThan(0.3);
  });
  it('empty → all zeros', () => {
    expect(quadrantShares([])).toEqual([0, 0, 0, 0]);
  });
});

describe('occupancyOf', () => {
  it('is the card-area fraction of the bounds, clamped [0,1]', () => {
    const occ = occupancyOf(balanced);
    expect(occ).toBeGreaterThan(0);
    expect(occ).toBeLessThanOrEqual(1);
    expect(occupancyOf([])).toBe(0);
  });
});

describe('analyzeBalance', () => {
  it('scores a balanced grid higher than a lopsided pile', () => {
    const good = analyzeBalance(balanced);
    const bad = analyzeBalance(lopsided);
    expect(good.overall).toBeGreaterThan(bad.overall);
    expect(good.overall).toBeGreaterThan(0.8);
    expect(bad.overall).toBeLessThan(0.6);
  });
  it('a balanced grid is even + centred', () => {
    const r = analyzeBalance(balanced);
    expect(r.metrics.find((m) => m.id === 'even')!.value).toBeCloseTo(1, 5);
    expect(r.metrics.find((m) => m.id === 'centered')!.value).toBeCloseTo(1, 5);
  });
  it('every metric value is bounded [0,1] and overall is their mean', () => {
    const r = analyzeBalance(lopsided);
    for (const m of r.metrics) {
      expect(m.value).toBeGreaterThanOrEqual(0);
      expect(m.value).toBeLessThanOrEqual(1);
    }
    const mean = r.metrics.reduce((s, m) => s + m.value, 0) / r.metrics.length;
    expect(r.overall).toBeCloseTo(mean, 5);
  });
  it('0 or 1 card is trivially balanced (overall 1)', () => {
    expect(analyzeBalance([]).overall).toBe(1);
    expect(analyzeBalance([rect(500, 500)]).overall).toBe(1);
  });
  it('is deterministic', () => {
    expect(analyzeBalance(lopsided)).toEqual(analyzeBalance(lopsided));
  });
  it('honours a custom metric catalog', () => {
    const only = [BALANCE_METRICS[1]]; // just "centered"
    const r = analyzeBalance(balanced, only);
    expect(r.metrics).toHaveLength(1);
    expect(r.metrics[0].id).toBe('centered');
    expect(r.overall).toBeCloseTo(r.metrics[0].value, 5);
  });
  it('non-finite coords never produce NaN', () => {
    const r = analyzeBalance([rect(0, 0), { x: NaN, y: Infinity, w: 40, h: 40 }]);
    expect(Number.isFinite(r.overall)).toBe(true);
    expect(Number.isFinite(r.centroid.x) && Number.isFinite(r.centroid.y)).toBe(true);
  });
});

describe('balanceBand', () => {
  it('green / amber / red words', () => {
    expect(balanceBand(0.9).label).toBe('Well balanced');
    expect(balanceBand(0.6).label).toBe('A little lopsided');
    expect(balanceBand(0.3).label).toBe('Lopsided');
  });
});
