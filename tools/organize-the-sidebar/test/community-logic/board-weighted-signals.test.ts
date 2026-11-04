// Vendored unchanged except for import paths from bitfield-packages/packages/group/read-data/board-weighted-signals.test.ts.
// Proof for the weighted-signal engine: weighted sum, reasons sorted strongest-first, fail-closed on bad
// signals, and a ranking that excludes zero-score items. The engine is BLIND — it never names a signal;
// "attention" and "momentum" are two DATA registries fed to this one reducer.
import { describe, expect, it } from '../../../match-community-members/test/vitest-shim.mjs';
import { weightedSignalScore, rankByWeightedSignals, type WeightedSignal } from '../../read-data/board-weighted-signals.ts';

const sig = (key: string, weight: number, magnitude: number, label = key): WeightedSignal => ({ key, label, weight, magnitude });

describe('board-weighted-signals — the blind weighted engine', () => {
  it('scores weight*magnitude and lists active reasons strongest first', () => {
    const a = weightedSignalScore([sig('overdue', 3, 1), sig('stalled', 1.5, 1), sig('due-soon', 1.5, 0)]);
    expect(a.score).toBe(4.5); // 3*1 + 1.5*1 + 0
    expect(a.reasons.map((r) => r.key)).toEqual(['overdue', 'stalled']); // due-soon inactive; sorted by contribution
    expect(a.reasons[0].contribution).toBe(3);
  });

  it('clamps magnitude to 0..1, ignores negative weight, and is fail-closed on malformed signals', () => {
    const a = weightedSignalScore([
      sig('a', 2, 5), // magnitude clamps to 1 → 2
      sig('b', -4, 1), // negative weight → 0 contribution → not a reason
      { key: 'c', label: 'c', weight: Number.NaN, magnitude: 1 } as WeightedSignal, // bad weight → skipped
      { key: 'd', label: 'd', weight: 1, magnitude: Number.NaN } as WeightedSignal, // bad magnitude → skipped
    ]);
    expect(a.score).toBe(2);
    expect(a.reasons.map((r) => r.key)).toEqual(['a']);
  });

  it('empty / non-array signals → zero verdict', () => {
    expect(weightedSignalScore([])).toEqual({ score: 0, reasons: [] });
    expect(weightedSignalScore(undefined as unknown as WeightedSignal[])).toEqual({ score: 0, reasons: [] });
  });

  it('rankByWeightedSignals orders by score desc and drops zero-score items', () => {
    const items = [
      { id: 'low', s: [sig('due-soon', 1.5, 1)] },
      { id: 'high', s: [sig('overdue', 3, 1), sig('behind', 2, 1)] },
      { id: 'none', s: [sig('x', 1, 0)] },
    ];
    const ranked = rankByWeightedSignals(items, (i) => i.s);
    expect(ranked.map((r) => r.item.id)).toEqual(['high', 'low']); // 5 > 1.5; 'none' excluded
  });
});
