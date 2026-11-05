// packages/group/read-data/rewrite-loop.test.ts
import { describe, it, expect } from '../../../../../test-helpers/vitest-shim.mjs';
import {
  appendRewrite,
  bestVersion,
  cutToNugget,
  nuggetOf,
  rankSentences,
  startLoop,
  topNuggets,
} from '../../../read-data/rewrite-loop.ts';
import type { Rubric } from '../../../read-data/writing-judge.ts';

// A rubric that rewards short, on-topic sentences → the "board share" sentence wins.
const rubric: Rubric = {
  id: 'nugget',
  name: 'Nugget',
  criteria: [
    { id: 'len', label: 'Length', weight: 1, scorer: 'length-target', config: { min: 4, max: 12 } },
    { id: 'kw', label: 'On-topic', weight: 2, scorer: 'keyword-coverage', config: { keywords: ['board', 'share'] } },
  ],
};

const longDraft =
  'I spent all morning thinking about many unrelated things that do not matter at all here. ' +
  'The board makes it effortless to share ideas. ' +
  'Then I rambled on and on about breakfast and the weather and other assorted trivia.';

describe('cut to nugget', () => {
  it('rankSentences puts the on-topic sentence first', () => {
    const ranked = rankSentences(longDraft, rubric);
    expect(ranked[0].sentence).toContain('share ideas');
  });

  it('nuggetOf returns the single best sentence', () => {
    expect(nuggetOf(longDraft, rubric)).toContain('board makes it effortless to share');
  });

  it('topNuggets returns N best-first; empty text → empty', () => {
    expect(topNuggets(longDraft, rubric, 2)).toHaveLength(2);
    expect(nuggetOf('', rubric)).toBe('');
    expect(topNuggets('', rubric, 3)).toEqual([]);
  });
});

describe('write → cut → rewrite loop', () => {
  it('records versions with stages and scores', () => {
    let loop = startLoop(longDraft, rubric);
    expect(loop.versions).toHaveLength(1);
    expect(loop.versions[0].stage).toBe('draft');

    loop = cutToNugget(loop, rubric);
    expect(loop.versions).toHaveLength(2);
    expect(loop.versions[1].stage).toBe('nugget');
    // the nugget scores higher than the rambling full draft
    expect(loop.versions[1].score).toBeGreaterThan(loop.versions[0].score);

    // the AI (owner) produces the rewrite; the loop scores + appends it
    loop = appendRewrite(loop, 'Share your board and its ideas in one tap.', rubric);
    expect(loop.versions[2].stage).toBe('rewrite');
  });

  it('bestVersion tracks the highest-scoring version across the loop', () => {
    let loop = startLoop(longDraft, rubric);
    loop = cutToNugget(loop, rubric);
    loop = appendRewrite(loop, 'x', rubric); // a weak rewrite must NOT become best
    const best = bestVersion(loop)!;
    expect(best.stage).toBe('nugget');
    expect(best.score).toBeGreaterThanOrEqual(loop.versions[0].score);
  });

  it('cutToNugget on an empty loop is a no-op', () => {
    const empty = { versions: [] };
    expect(cutToNugget(empty, rubric)).toBe(empty);
  });
});
