// Proof for the metric leaf: fail-closed normalize (finite current + positive target + trimmed unit),
// fraction/percent/remaining/over-achievement/done, setters guard bad input, formatValue, and a
// progress ranking that excludes metric-less items and orders by completion.
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  addToCurrent,
  completion,
  fraction,
  formatValue,
  isComplete,
  metricFromRaw,
  overBy,
  progressPct,
  rankByProgress,
  remaining,
  setCurrent,
  setTarget,
  type Metric,
} from '../../../read-data/board-metric.ts';

describe('board-metric — the pure metric leaf', () => {
  it('metricFromRaw is fail-closed: finite current + target + a real span (target != start) + trimmed unit', () => {
    expect(metricFromRaw({ current: 5, target: 12, unit: ' books ' })).toEqual({ current: 5, target: 12, unit: 'books' });
    expect(metricFromRaw({ current: 0, target: 100 })).toEqual({ current: 0, target: 100 });
    expect(metricFromRaw({ current: 1200, target: 0, start: 5000 })).toEqual({ current: 1200, target: 0, start: 5000 }); // descending
    expect(metricFromRaw({ current: 5, target: 12, start: 0 })).toEqual({ current: 5, target: 12 }); // start 0 dropped (default)
    // bad shapes → null
    expect(metricFromRaw(null)).toBeNull();
    expect(metricFromRaw('5/12')).toBeNull();
    expect(metricFromRaw({ current: 5 })).toBeNull(); // no target
    expect(metricFromRaw({ current: 5, target: 0 })).toBeNull(); // target == default start (0) → no span
    expect(metricFromRaw({ current: 5, target: 10, start: 10 })).toBeNull(); // target == start → no span
    expect(metricFromRaw({ current: Infinity, target: 12 })).toBeNull();
    expect(metricFromRaw({ current: 5, target: 12, start: 'x' })).toBeNull(); // non-finite start
    expect(metricFromRaw({ current: 5, target: 12, unit: '  ' })).toEqual({ current: 5, target: 12 }); // blank unit dropped
  });

  it('fraction / progressPct / remaining / overBy / isComplete (ascending)', () => {
    const half: Metric = { current: 6, target: 12 };
    expect(fraction(half)).toBe(0.5);
    expect(progressPct(half)).toBe(50);
    expect(remaining(half)).toBe(6);
    expect(overBy(half)).toBe(0);
    expect(isComplete(half)).toBe(false);

    const beaten: Metric = { current: 15, target: 12 };
    expect(fraction(beaten)).toBeCloseTo(1.25);
    expect(progressPct(beaten)).toBe(100); // clamped
    expect(remaining(beaten)).toBe(0); // never negative
    expect(overBy(beaten)).toBe(3);
    expect(isComplete(beaten)).toBe(true);
  });

  it('runs a descending goal through the SAME math (debt 5000 -> 0, now at 1200)', () => {
    const debt: Metric = { current: 1200, target: 0, start: 5000 };
    expect(fraction(debt)).toBeCloseTo(0.76); // (1200-5000)/(0-5000)
    expect(progressPct(debt)).toBe(76);
    expect(remaining(debt)).toBe(1200); // |target - current|
    expect(overBy(debt)).toBe(0);
    expect(isComplete(debt)).toBe(false);
    // paid past the target (overshoot below 0)
    const over: Metric = { current: -200, target: 0, start: 5000 };
    expect(isComplete(over)).toBe(true);
    expect(remaining(over)).toBe(0);
    expect(overBy(over)).toBe(200);
    expect(progressPct(over)).toBe(100);
  });

  it('setters guard bad input and never mutate in place', () => {
    const m: Metric = { current: 5, target: 12, unit: 'books' };
    expect(setCurrent(m, 8)).toEqual({ current: 8, target: 12, unit: 'books' });
    expect(setCurrent(m, Number.NaN)).toBe(m); // ignored
    expect(addToCurrent(m, 3)).toEqual({ current: 8, target: 12, unit: 'books' });
    expect(addToCurrent(m, -2)).toEqual({ current: 3, target: 12, unit: 'books' });
    expect(setTarget(m, 20)).toEqual({ current: 5, target: 20, unit: 'books' });
    expect(setTarget(m, 0)).toBe(m); // non-positive ignored
    expect(m.current).toBe(5); // original untouched
  });

  it('formatValue reads value/target with optional unit', () => {
    expect(formatValue({ current: 5, target: 12, unit: 'books' })).toBe('5/12 books');
    expect(formatValue({ current: 1200, target: 5000 })).toBe('1200/5000');
  });

  it('rankByProgress orders by completion and excludes metric-less items', () => {
    const items = [
      { id: 'a', m: { current: 2, target: 10 } as Metric | null }, // 20%
      { id: 'b', m: { current: 9, target: 10 } as Metric | null }, // 90%
      { id: 'c', m: null }, // excluded
      { id: 'd', m: { current: 5, target: 10 } as Metric | null }, // 50%
    ];
    const desc = rankByProgress(items, (i) => i.m).map((r) => r.item.id);
    expect(desc).toEqual(['b', 'd', 'a']); // most complete first
    const asc = rankByProgress(items, (i) => i.m, false).map((r) => r.item.id);
    expect(asc).toEqual(['a', 'd', 'b']); // least complete first (needs work)
  });

  it('a progress BAR never reads 100% until the goal is actually complete (no false done)', () => {
    const nearly: Metric = { current: 99.5, target: 100 }; // 99.5% — NOT complete
    expect(isComplete(nearly)).toBe(false);
    expect(progressPct(nearly)).toBe(99); // capped at 99 — a bar must not claim done at 99.5%
    const done: Metric = { current: 100, target: 100 };
    expect(progressPct(done)).toBe(100); // genuinely complete -> 100
  });

  it('completion is the EXACT clamped fraction for composition (unrounded, unlike progressPct)', () => {
    expect(completion({ current: 99.5, target: 100 })).toBeCloseTo(0.995); // exact, NOT rounded to 1
    expect(completion({ current: 5, target: 10 })).toBe(0.5);
    expect(completion({ current: 12, target: 10 })).toBe(1); // over-achievement caps at 1
    expect(completion({ current: -3, target: 10 })).toBe(0); // moved backward -> clamped 0
  });
});
