// packages/group/do-work/text-similarity.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  normalizeText,
  shingleSet,
  jaccard,
  textSimilarity,
  duplicateGroups,
  rankSimilar,
} from '../../../do-work/text-similarity.ts';

describe('normalizeText', () => {
  it('lowercases, collapses whitespace, trims', () => {
    expect(normalizeText('  Book   FLIGHT\nto NYC ')).toBe('book flight to nyc');
    expect(normalizeText('')).toBe('');
  });
});

describe('shingleSet', () => {
  it('word bigrams by default', () => {
    expect([...shingleSet('a b c')]).toEqual(['a b', 'b c']);
  });
  it('a text shorter than k → one whole-string shingle (never vanishes)', () => {
    expect([...shingleSet('hi', { k: 2 })]).toEqual(['hi']);
  });
  it('char mode grams the characters', () => {
    expect([...shingleSet('abc', { k: 2, mode: 'char' })]).toEqual(['ab', 'bc']);
  });
  it('empty text → empty set', () => {
    expect(shingleSet('   ').size).toBe(0);
  });
});

describe('jaccard', () => {
  it('identical sets → 1, disjoint → 0', () => {
    expect(jaccard(new Set([1, 2, 3]), new Set([1, 2, 3]))).toBe(1);
    expect(jaccard(new Set([1, 2]), new Set([3, 4]))).toBe(0);
  });
  it('partial overlap = |∩|/|∪|', () => {
    expect(jaccard(new Set([1, 2, 3]), new Set([2, 3, 4]))).toBeCloseTo(2 / 4, 6);
  });
  it('two empty sets → 0 (no shared evidence — blanks are not duplicates)', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

describe('textSimilarity', () => {
  it('identical (after normalisation) → 1', () => {
    expect(textSimilarity('Book Flight To NYC', 'book   flight to nyc')).toBe(1);
  });
  it('near-duplicate reads high, unrelated reads low', () => {
    const near = textSimilarity('book flight to nyc', 'book the flight to nyc tomorrow');
    const far = textSimilarity('book flight to nyc', 'buy groceries and cook dinner');
    expect(near).toBeGreaterThan(0.3);
    expect(far).toBeLessThan(0.1);
    expect(near).toBeGreaterThan(far);
  });
});

describe('duplicateGroups', () => {
  it('clusters near-duplicates, drops singletons + blanks', () => {
    const texts = [
      'book flight to nyc',
      'book the flight to nyc please', // ~ near-dup of 0
      'buy groceries for the week',
      'buy groceries for this week', // ~ near-dup of 2
      'walk the dog', // unique
      '   ', // blank
    ];
    // word-bigram Jaccard of these near-dups is ~0.33 (inserted words break bigrams) → threshold 0.3
    const groups = duplicateGroups(texts, { threshold: 0.3 });
    // two duplicate clusters: {0,1} and {2,3}; 4 (unique) + 5 (blank) excluded
    expect(groups).toHaveLength(2);
    const flat = groups.flat();
    expect(flat).toContain(0);
    expect(flat).toContain(1);
    expect(flat).toContain(2);
    expect(flat).toContain(3);
    expect(flat).not.toContain(4);
    expect(flat).not.toContain(5);
  });

  it('transitively merges a chain (a~b, b~c → one group)', () => {
    const texts = ['alpha beta gamma', 'alpha beta gamma delta', 'beta gamma delta epsilon'];
    const groups = duplicateGroups(texts, { threshold: 0.25 });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual([0, 1, 2]);
  });

  it('a high threshold only merges true duplicates', () => {
    const texts = ['exact same note', 'exact same note', 'totally different thing here'];
    expect(duplicateGroups(texts, { threshold: 0.99 })).toEqual([[0, 1]]);
  });

  it('empty input / all-unique → no groups', () => {
    expect(duplicateGroups([])).toEqual([]);
    expect(duplicateGroups(['one two', 'three four', 'five six'], { threshold: 0.5 })).toEqual([]);
  });

  it('is deterministic', () => {
    const texts = ['same idea here', 'same idea over here', 'other'];
    expect(duplicateGroups(texts, { threshold: 0.3 })).toEqual(duplicateGroups(texts, { threshold: 0.3 }));
  });
});

describe('rankSimilar', () => {
  it('ranks candidates by similarity, excludes the target index', () => {
    const notes = ['book flight to nyc', 'book flight to nyc soon', 'cook dinner tonight', 'flight to nyc booked'];
    const ranked = rankSimilar(notes[0], notes, { excludeIndex: 0 });
    expect(ranked[0].index).toBe(1); // most similar
    expect(ranked.map((r) => r.index)).not.toContain(0); // target excluded
    // descending scores
    for (let i = 1; i < ranked.length; i++) expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
  });
  it('minScore filters and limit caps', () => {
    const notes = ['a b c d', 'a b c e', 'x y z'];
    expect(rankSimilar('a b c d', notes, { excludeIndex: 0, minScore: 0.2 }).every((r) => r.score >= 0.2)).toBe(true);
    expect(rankSimilar('a b c d', notes, { excludeIndex: 0, limit: 1 })).toHaveLength(1);
  });
});
