// packages/ask-questions-sort-answers-follow-up/read-data/score-and-segment.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  evaluateRule,
  scoreAnswers,
  assignSegment,
  decide,
  type ScoreRule,
  type SegmentRule,
} from '../read-data/score-and-segment.ts';

describe('evaluateRule — DATA matchers', () => {
  const r = (match: ScoreRule['match'], points?: number): ScoreRule => ({ readKey: 'k', match, points });
  it('value_map maps an answer value to points (wins over points)', () => {
    expect(evaluateRule('pro', r({ value_map: { new: 1, pro: 5 } }, 99))).toBe(5);
    expect(evaluateRule('unknown', r({ value_map: { new: 1 } }))).toBe(0);
  });
  it('equals / gte / lte / min_length / contains / has_value', () => {
    expect(evaluateRule('yes', r({ equals: 'yes' }, 3))).toBe(3);
    expect(evaluateRule(8, r({ gte: 5 }, 2))).toBe(2);
    expect(evaluateRule(8, r({ lte: 5 }, 2))).toBe(0);
    expect(evaluateRule('abcd', r({ min_length: 3 }, 1))).toBe(1);
    expect(evaluateRule('b', r({ contains: ['a', 'b'] }, 4))).toBe(4);
    expect(evaluateRule('', r({ has_value: true }, 1))).toBe(0);
    expect(evaluateRule('x', r({ has_value: true }, 1))).toBe(1);
  });
});

describe('evaluateRule — picks answers', () => {
  const r = (match: ScoreRule['match'], points?: number): ScoreRule => ({ readKey: 'k', match, points });
  it('a picks answer matches by each value picked: value_map adds up the picks, equals and contains match any pick', () => {
    expect(evaluateRule({ picked: ['ready'] }, r({ value_map: { ready: 3, later: 1 } }))).toBe(3);
    expect(evaluateRule({ picked: ['ready', 'later'] }, r({ value_map: { ready: 3, later: 1 } }))).toBe(4);
    expect(evaluateRule({ picked: ['other'], other: 'my words' }, r({ value_map: { ready: 3 } }))).toBe(0);
    expect(evaluateRule({ picked: ['b', 'c'] }, r({ equals: 'c' }, 2))).toBe(2);
    expect(evaluateRule({ picked: ['z'] }, r({ contains: ['a', 'z'] }, 4))).toBe(4);
    expect(evaluateRule({ picked: [] }, r({ has_value: true }, 1))).toBe(0);
    expect(evaluateRule({ picked: ['a'] }, r({ has_value: true }, 1))).toBe(1);
  });
});

describe('scoreAnswers', () => {
  const rules: ScoreRule[] = [
    { readKey: 'experience', match: { value_map: { beginner: 1, advanced: 5 } }, scoreLabel: 'skill' },
    { readKey: 'budget', match: { gte: 1000 }, points: 10, scoreLabel: 'intent' },
    { readKey: 'email', match: { has_value: true }, points: 2, scoreLabel: 'intent' },
  ];
  it('sums points, with breakdown + named-bucket subtotals', () => {
    const res = scoreAnswers({ experience: 'advanced', budget: 1500, email: 'user-fb98d44a@example.com' }, rules);
    expect(res.score).toBe(17);
    expect(res.breakdown).toEqual({ experience: 5, budget: 10, email: 2 });
    expect(res.byLabel).toEqual({ skill: 5, intent: 12 });
  });
  it('contributes nothing for unmatched answers', () => {
    expect(scoreAnswers({ experience: 'beginner' }, rules).score).toBe(1);
  });
});

describe('assignSegment', () => {
  const tiers: SegmentRule[] = [
    { min: 0, segmentId: 'cold' },
    { min: 10, segmentId: 'warm' },
    { min: 20, segmentId: 'hot' },
  ];
  it('picks the highest threshold the score meets', () => {
    expect(assignSegment(5, tiers)).toBe('cold');
    expect(assignSegment(15, tiers)).toBe('warm');
    expect(assignSegment(25, tiers)).toBe('hot');
  });
  it('returns null when below every threshold', () => {
    expect(assignSegment(5, [{ min: 10, segmentId: 'warm' }])).toBeNull();
  });
});

describe('decide', () => {
  it('scores then segments in one call (a "hot" lead is a rule row, not a code branch)', () => {
    const res = decide(
      { budget: 2000, email: 'user-fb98d44a@example.com' },
      [
        { readKey: 'budget', match: { gte: 1000 }, points: 10 },
        { readKey: 'email', match: { has_value: true }, points: 12 },
      ],
      [{ min: 0, segmentId: 'cold' }, { min: 20, segmentId: 'hot' }],
    );
    expect(res.score).toBe(22);
    expect(res.segmentId).toBe('hot');
  });
});
