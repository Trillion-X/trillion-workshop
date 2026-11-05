// packages/group/read-data/writing-judge.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  DEFAULT_SCORERS,
  judgeText,
  rankDrafts,
  type Rubric,
} from '../../../read-data/writing-judge.ts';

const rubric: Rubric = {
  id: 'blog',
  name: 'Blog post',
  criteria: [
    { id: 'len', label: 'Length', weight: 2, scorer: 'length-target', config: { min: 8, max: 40 } },
    { id: 'kw', label: 'Keywords', weight: 1, scorer: 'keyword-coverage', config: { keywords: ['board', 'share'] } },
    { id: 'read', label: 'Readability', weight: 1, scorer: 'readability' },
  ],
};

describe('individual scorers', () => {
  it('length-target: full inside range, falls off outside', () => {
    expect(DEFAULT_SCORERS['length-target']('one two three four five', { min: 3, max: 10 })).toBe(1);
    expect(DEFAULT_SCORERS['length-target']('too short', { min: 10, max: 20 })).toBeLessThan(1);
    expect(DEFAULT_SCORERS['length-target']('', { min: 5, max: 10 })).toBe(0);
  });

  it('keyword-coverage: fraction present, 1 when no keywords required', () => {
    expect(DEFAULT_SCORERS['keyword-coverage']('the board is shared', { keywords: ['board', 'share'] })).toBe(1);
    expect(DEFAULT_SCORERS['keyword-coverage']('only the board', { keywords: ['board', 'share'] })).toBe(0.5);
    expect(DEFAULT_SCORERS['keyword-coverage']('anything', {})).toBe(1);
  });

  it('sentence-variety: 0 for a single sentence, higher when lengths vary', () => {
    expect(DEFAULT_SCORERS['sentence-variety']('all one length here now')).toBe(0);
    const varied = DEFAULT_SCORERS['sentence-variety']('Short. A much much much much longer sentence here indeed.');
    expect(varied).toBeGreaterThan(0);
  });

  it('nonempty', () => {
    expect(DEFAULT_SCORERS.nonempty('  ')).toBe(0);
    expect(DEFAULT_SCORERS.nonempty('x')).toBe(1);
  });
});

describe('judgeText', () => {
  it('returns a weighted overall + per-criterion breakdown', () => {
    const good = judgeText('This board makes it easy to share ideas with anyone you want today.', rubric);
    expect(good.breakdown).toHaveLength(3);
    expect(good.overall).toBeGreaterThan(0);
    expect(good.overall).toBeLessThanOrEqual(1);
    // keyword criterion: both 'board' and 'share' present → 1
    expect(good.breakdown.find((b) => b.id === 'kw')!.score).toBe(1);
  });

  it('weights matter — a low score on a heavy criterion drags the overall', () => {
    const tooLong = judgeText(Array(200).fill('word').join(' '), rubric); // blows the length target (weight 2)
    const onTarget = judgeText('The board lets you share ideas fast with anyone.', rubric);
    expect(onTarget.overall).toBeGreaterThan(tooLong.overall);
  });

  it('unknown scorer scores 0, never throws', () => {
    const r: Rubric = { id: 'x', name: 'x', criteria: [{ id: 'c', label: 'c', weight: 1, scorer: 'does-not-exist' }] };
    expect(judgeText('whatever', r).overall).toBe(0);
  });

  it('honours an injected scorer map (L090)', () => {
    const r: Rubric = { id: 'x', name: 'x', criteria: [{ id: 'c', label: 'c', weight: 1, scorer: 'always1' }] };
    expect(judgeText('anything', r, { always1: () => 1 }).overall).toBe(1);
  });
});

describe('rankDrafts (sparring)', () => {
  it('ranks drafts best-first by overall score', () => {
    const drafts = [
      { id: 'a', text: 'board share ideas quickly with anyone you want today here now' },
      { id: 'b', text: 'x' }, // fails length + keywords
      { id: 'c', text: Array(300).fill('word').join(' ') }, // way too long
    ];
    const ranked = rankDrafts(drafts, rubric);
    expect(ranked[0].id).toBe('a');
    expect(ranked[ranked.length - 1].overall).toBeLessThan(ranked[0].overall);
  });

  describe('writing-judge red-team — untrusted rubric never crashes or hangs (cont.98 batch-38)', () => {
    it('a prototype-key scorer id fails closed to 0 (no TypeError from Object.prototype / constructor)', () => {
      for (const bad of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
        const rubric: Rubric = { id: 'r', name: 'R', criteria: [{ id: 'c', label: 'C', weight: 1, scorer: bad }] };
        const res = judgeText('some text here', rubric);
        expect(Number.isFinite(res.overall)).toBe(true);
        expect(res.breakdown[0].score).toBe(0); // unknown/prototype scorer -> 0, never a crash
      }
      // a real scorer still runs (zero regression)
      const ok: Rubric = { id: 'r', name: 'R', criteria: [{ id: 'ne', label: 'NE', weight: 1, scorer: 'nonempty' }] };
      expect(judgeText('hi', ok).breakdown[0].score).toBe(1);
    });

    it('a huge keyword list is capped (no unbounded substring scan)', () => {
      const keywords = Array.from({ length: 100_000 }, (_, i) => `kw${i}`);
      const rubric: Rubric = { id: 'r', name: 'R', criteria: [{ id: 'kc', label: 'KC', weight: 1, scorer: 'keyword-coverage', config: { keywords } }] };
      const res = judgeText('kw0 kw1 text', rubric);
      expect(Number.isFinite(res.overall)).toBe(true); // completes fast, no hang
    });
  });
});
