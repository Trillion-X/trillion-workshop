// packages/group/do-work/tag-cooccurrence.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  normTag,
  tagTotals,
  coPairCounts,
  tagAffinities,
  suggestTags,
  measureById,
  COOCCURRENCE_MEASURES,
} from '../../../do-work/tag-cooccurrence.ts';

describe('normTag', () => {
  it('trims, strips leading # / @, lowercases', () => {
    expect(normTag('  #Design ')).toBe('design');
    expect(normTag('@Urgent')).toBe('urgent');
    expect(normTag('##a')).toBe('a');
    expect(normTag('')).toBe('');
  });
});

describe('tagTotals', () => {
  it('counts each tag once per card, normalized + de-duped', () => {
    const totals = tagTotals([['a', 'A', 'b'], ['#b'], ['c']]);
    expect(totals.get('a')).toBe(1); // 'a' + 'A' collapse within the one card
    expect(totals.get('b')).toBe(2);
    expect(totals.get('c')).toBe(1);
  });
  it('empty board → empty totals', () => {
    expect(tagTotals([]).size).toBe(0);
  });
});

describe('coPairCounts', () => {
  it('one increment per card per unordered pair, keyed a<b (NUL-separated)', () => {
    const counts = coPairCounts([['a', 'b', 'c'], ['a', 'b']]);
    const S = '\u0000';
    expect(counts.get(`a${S}b`)).toBe(2);
    expect(counts.get(`a${S}c`)).toBe(1);
    expect(counts.get(`b${S}c`)).toBe(1);
    // never the reversed key
    expect(counts.get(`b${S}a`)).toBeUndefined();
  });
  it('a single-tag card contributes no pair', () => {
    expect(coPairCounts([['solo']]).size).toBe(0);
  });
  it('a duplicate tag in one card does not self-pair', () => {
    expect(coPairCounts([['a', 'a']]).size).toBe(0);
  });
});

describe('tagAffinities', () => {
  const sets = [
    ['design', 'ux'],
    ['design', 'ux'],
    ['design', 'ux', 'research'],
    ['backend', 'db'],
  ];
  it('ranks the tightest pair first (design↔ux appear together 3×)', () => {
    const pairs = tagAffinities(sets, { measure: 'together' });
    expect(pairs[0].a).toBe('design');
    expect(pairs[0].b).toBe('ux');
    expect(pairs[0].count).toBe(3);
    // Jaccard(design,ux) = 3 / (3+3-3) = 1
    expect(pairs[0].weight).toBeCloseTo(1, 5);
  });
  it('minCount drops one-off pairs', () => {
    const pairs = tagAffinities(sets, { measure: 'count', minCount: 2 });
    expect(pairs.every((p) => p.count >= 2)).toBe(true);
    expect(pairs.some((p) => p.a === 'design' && p.b === 'research')).toBe(false);
  });
  it('limit keeps the top-N', () => {
    expect(tagAffinities(sets, { measure: 'count', limit: 1 })).toHaveLength(1);
  });
  it('disjoint tag clusters never pair across', () => {
    const pairs = tagAffinities(sets, { measure: 'count' });
    expect(pairs.some((p) => (p.a === 'backend' || p.b === 'backend') && (p.a === 'design' || p.b === 'design'))).toBe(false);
  });
  it('lift measures attraction above chance (>1 for co-attracted tags)', () => {
    const pairs = tagAffinities(sets, { measure: 'lift' });
    const du = pairs.find((p) => p.a === 'design' && p.b === 'ux')!;
    // co=3, a=3, b=3, n=4 → lift = 3*4/(3*3) = 1.333
    expect(du.weight).toBeCloseTo(4 / 3, 5);
    expect(du.weight).toBeGreaterThan(1);
  });
  it('is deterministic across runs (stable tie-break)', () => {
    const a = tagAffinities(sets, { measure: 'together' });
    const b = tagAffinities(sets, { measure: 'together' });
    expect(a).toEqual(b);
  });
  it('empty board → no pairs', () => {
    expect(tagAffinities([], { measure: 'together' })).toHaveLength(0);
  });
});

describe('suggestTags', () => {
  const sets = [
    ['design', 'ux', 'research'],
    ['design', 'ux'],
    ['design', 'ux', 'research'],
    ['design', 'ops'],
  ];
  it('suggests the tag most co-occurring with the current ones, and cites its source', () => {
    // a card tagged only "design" — "ux" co-occurs 3×, "research" 2×, "ops" 1×
    const sugg = suggestTags(sets, ['design'], { measure: 'count' });
    expect(sugg[0].tag).toBe('ux');
    expect(sugg[0].from).toBe('design');
    expect(sugg.map((s) => s.tag)).toEqual(['ux', 'research', 'ops']);
  });
  it('excludes tags the card already has', () => {
    const sugg = suggestTags(sets, ['design', 'ux'], { measure: 'count' });
    expect(sugg.some((s) => s.tag === 'design' || s.tag === 'ux')).toBe(false);
    expect(sugg[0].tag).toBe('research');
  });
  it('normalizes the have list (raw #Design works)', () => {
    const sugg = suggestTags(sets, ['#Design'], { measure: 'count' });
    expect(sugg[0].tag).toBe('ux');
  });
  it('no current tags → no suggestions', () => {
    expect(suggestTags(sets, [], { measure: 'count' })).toHaveLength(0);
  });
  it('a tag with no co-occurrence signal yields nothing', () => {
    expect(suggestTags([['lonely']], ['lonely'], { measure: 'count' })).toHaveLength(0);
  });
  it('is deterministic', () => {
    expect(suggestTags(sets, ['design'], { measure: 'together' }))
      .toEqual(suggestTags(sets, ['design'], { measure: 'together' }));
  });
});

describe('COOCCURRENCE_MEASURES catalog', () => {
  it('measureById falls back to the first for unknown / undefined', () => {
    expect(measureById(undefined).id).toBe('together');
    expect(measureById('nope').id).toBe('together');
    expect(measureById('lift').id).toBe('lift');
  });
  it('every measure returns a finite, non-negative weight for a normal pair', () => {
    for (const m of COOCCURRENCE_MEASURES) {
      const w = m.weight(2, 3, 4, 10);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
    }
  });
  it('degenerate totals never divide by zero', () => {
    for (const m of COOCCURRENCE_MEASURES) {
      expect(Number.isFinite(m.weight(0, 0, 0, 0))).toBe(true);
    }
  });
});
