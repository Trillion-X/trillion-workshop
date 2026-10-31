// packages/ask-questions-sort-answers-follow-up/read-data/read-decide-config.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  readScoreRules,
  readSegmentRules,
  readDecideConfig,
} from '../read-data/read-decide-config.ts';

// One published-records aggregate carries all kinds; decoders filter by kind.
const ENTRY = [
  { payload: { kind: 'score-rule', readKey: 'budget', match: { gte: 1000 }, points: 10, scoreLabel: 'intent' } },
  { kind: 'score-rule', readKey: 'broken', match: 'not-an-object' }, // bad match → dropped
  { payload: { kind: 'segment-rule', min: 20, segmentId: 'hot' } },
  { payload: { kind: 'segment-rule', segmentId: 'no-min' } }, // missing min → dropped
  { payload: { kind: 'follow-up-sequence', segmentId: 'hot', steps: [{ stepId: 's1' }] } },
  { payload: { kind: 'question-type-capability', questionTypeId: 'text' } }, // ignored by these decoders
];

describe('readScoreRules', () => {
  it('decodes score-rule rows, dropping rows with a malformed match', () => {
    const rules = readScoreRules(ENTRY);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toEqual({ readKey: 'budget', match: { gte: 1000 }, points: 10, scoreLabel: 'intent' });
  });
});

describe('readSegmentRules', () => {
  it('decodes segment-rule rows, dropping rows missing min/segmentId', () => {
    expect(readSegmentRules(ENTRY)).toEqual([{ min: 20, segmentId: 'hot' }]);
  });
});

describe('readDecideConfig', () => {
  it('builds the whole config from one aggregate entry', () => {
    const cfg = readDecideConfig(ENTRY);
    expect(cfg.scoreRules).toHaveLength(1);
    expect(cfg.segmentRules).toHaveLength(1);
    expect(cfg.followUpSequences).toHaveLength(1);
    expect(cfg.followUpSequences[0].segmentId).toBe('hot');
  });
  it('is null-safe', () => {
    expect(readDecideConfig(null)).toEqual({ scoreRules: [], segmentRules: [], followUpSequences: [] });
  });
});
