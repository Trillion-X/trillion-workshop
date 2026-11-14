// packages/group/do-work/board-tidiness.test.ts
import { describe, it, expect } from 'vitest';
import {
  detectOverlaps,
  detectNearAlignment,
  analyzeTidiness,
  TIDINESS_DETECTORS,
  type TidyRect,
} from './board-tidiness';

const r = (memberId: string, x: number, y: number, w = 40, h = 30): TidyRect => ({ memberId, x, y, w, h });

describe('detectOverlaps', () => {
  it('finds overlapping pairs, severity = fraction of the smaller card covered', () => {
    const issues = detectOverlaps([r('a', 0, 0, 40, 40), r('b', 20, 20, 40, 40), r('c', 500, 500)]);
    expect(issues).toHaveLength(1);
    expect(issues[0].memberIds).toEqual(['a', 'b']);
    // overlap is 20x20=400 of a 40x40=1600 card → 0.25
    expect(issues[0].severity).toBeCloseTo(0.25, 5);
  });
  it('a fully-buried card → severity 1', () => {
    const issues = detectOverlaps([r('big', 0, 0, 100, 100), r('small', 10, 10, 20, 20)]);
    expect(issues[0].severity).toBe(1);
  });
  it('touching (zero-area) or far-apart → no overlap', () => {
    expect(detectOverlaps([r('a', 0, 0, 40, 40), r('b', 40, 0, 40, 40)])).toEqual([]); // edge-touch
    expect(detectOverlaps([r('a', 0, 0), r('b', 900, 900)])).toEqual([]);
  });
  it('worst-first order', () => {
    const issues = detectOverlaps([r('a', 0, 0, 40, 40), r('b', 5, 5, 40, 40), r('c', 200, 0, 40, 40), r('d', 210, 5, 40, 40)]);
    for (let i = 1; i < issues.length; i++) expect(issues[i - 1].severity).toBeGreaterThanOrEqual(issues[i].severity);
  });
});

describe('detectNearAlignment', () => {
  it('flags an ALMOST-aligned pair (0 < gap ≤ tol), not an exactly-aligned one', () => {
    // b's left edge is 3px off a's left → near-align; c's left exactly equals a's → tidy
    const near = detectNearAlignment([r('a', 0, 0), r('b', 3, 100)], { tol: 6 });
    expect(near).toHaveLength(1);
    expect(near[0].detail).toMatch(/left/);
    const exact = detectNearAlignment([r('a', 0, 0), r('c', 0, 100)], { tol: 6 });
    expect(exact).toEqual([]); // exact alignment is tidy
  });
  it('a big misalignment (> tol) is not a near-miss', () => {
    expect(detectNearAlignment([r('a', 0, 0), r('b', 40, 100)], { tol: 6 })).toEqual([]);
  });
  it('reports ONE issue per pair (the strongest edge), severity 1 − gap/tol', () => {
    const issues = detectNearAlignment([r('a', 0, 0, 40, 40), r('b', 2, 200, 40, 40)], { tol: 10 });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBeCloseTo(0.8, 5); // gap 2, tol 10 → 1 - 0.2
  });
});

describe('analyzeTidiness', () => {
  it('empty / single card → perfect score, no issues', () => {
    expect(analyzeTidiness([]).score).toBe(1);
    expect(analyzeTidiness([r('a', 0, 0)]).score).toBe(1);
    expect(analyzeTidiness([r('a', 0, 0)]).issues).toEqual([]);
  });
  it('a tidy, well-spaced board scores 1', () => {
    const tidy = [r('a', 0, 0), r('b', 100, 0), r('c', 200, 0)]; // no overlap, no near-miss
    expect(analyzeTidiness(tidy).score).toBe(1);
    expect(analyzeTidiness(tidy).countsByKind.overlap).toBe(0);
  });
  it('a messy pile scores LOWER than a tidy board', () => {
    const messy = [r('a', 0, 0, 60, 60), r('b', 10, 10, 60, 60), r('c', 20, 20, 60, 60)];
    const tidy = [r('a', 0, 0), r('b', 200, 0), r('d', 400, 0)];
    expect(analyzeTidiness(messy).score).toBeLessThan(analyzeTidiness(tidy).score);
    expect(analyzeTidiness(messy).countsByKind.overlap).toBeGreaterThan(0);
  });
  it('score is bounded [0,1] even for a huge overlap pile', () => {
    const pile = Array.from({ length: 8 }, (_v, i) => r(`n${i}`, i, i, 80, 80)); // all overlapping
    const s = analyzeTidiness(pile).score;
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
  it('issues are worst-first (weighted) and carry the detector id', () => {
    const report = analyzeTidiness([r('a', 0, 0, 60, 60), r('b', 10, 10, 60, 60), r('x', 3, 400)]);
    expect(report.issues[0].detectorId).toBe('overlap'); // overlap (weight 1) outranks near-align (0.35)
    expect(report.issues.every((i) => typeof i.detectorId === 'string')).toBe(true);
  });
  it('is deterministic', () => {
    const rects = [r('a', 0, 0, 50, 50), r('b', 20, 20, 50, 50), r('c', 3, 200)];
    expect(analyzeTidiness(rects)).toEqual(analyzeTidiness(rects));
  });
  it('TIDINESS_DETECTORS ships overlap + near-align', () => {
    expect(TIDINESS_DETECTORS.map((d) => d.id)).toEqual(['overlap', 'near-align']);
  });
});
