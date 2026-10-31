// Decide-config form-scoping + a feedback satisfaction segmentation. The feedback form's score/segment rules
// are DATA carrying formId:'course-feedback' so they apply ONLY to feedback submissions — a different form
// (e.g. the practice-session journal) is never mis-segmented by them (L090 isolation). A scored feedback
// submission is assigned a satisfaction tier (at-risk / satisfied / promoter).
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { readDecideConfig } from '../read-data/read-decide-config.ts';
import { buildProcessSubmission } from '../do-work/process-submission.ts';

const FORM = 'course-feedback';
const ROWS = [
  { payload: { kind: 'score-rule', formId: FORM, readKey: 'recommend', match: { value_map: { definitely: 2, maybe: 1, 'not-yet': 0 } } } },
  { payload: { kind: 'score-rule', formId: FORM, readKey: 'enjoyment', match: { gte: 4 }, points: 1 } },
  { payload: { kind: 'segment-rule', formId: FORM, min: 0, segmentId: 'at-risk' } },
  { payload: { kind: 'segment-rule', formId: FORM, min: 2, segmentId: 'satisfied' } },
  { payload: { kind: 'segment-rule', formId: FORM, min: 3, segmentId: 'promoter' } },
];
const AT = '2026-07-02T00:00:00Z';
const segmentOf = (answers: Record<string, unknown>) =>
  buildProcessSubmission(FORM, 'r1', answers, readDecideConfig(ROWS, FORM), AT).decision.segmentId;

describe('feedback decide config — form-scoped satisfaction segmentation', () => {
  it('the feedback rules are scoped to course-feedback (loaded for it)', () => {
    const cfg = readDecideConfig(ROWS, FORM);
    expect(cfg.scoreRules).toHaveLength(2);
    expect(cfg.segmentRules).toHaveLength(3);
  });

  it('a DIFFERENT form does not inherit the feedback rules (no cross-form mis-segmentation)', () => {
    const other = readDecideConfig(ROWS, 'practice-session');
    expect(other.scoreRules).toHaveLength(0);
    expect(other.segmentRules).toHaveLength(0);
  });

  it('assigns a satisfaction tier from the enjoyment rating + recommend answer', () => {
    expect(segmentOf({ enjoyment: 5, recommend: 'definitely' })).toBe('promoter'); // 2 + 1 = 3
    expect(segmentOf({ enjoyment: 4, recommend: 'maybe' })).toBe('satisfied'); // 1 + 1 = 2
    expect(segmentOf({ enjoyment: 2, recommend: 'not-yet' })).toBe('at-risk'); // 0
    expect(segmentOf({ enjoyment: 3, recommend: 'not-yet' })).toBe('at-risk'); // 0 (enjoyment < 4)
  });

  it('a global rule (no formId) still applies to every form (backward compatible)', () => {
    const withGlobal = [...ROWS, { payload: { kind: 'segment-rule', min: 0, segmentId: 'global-floor' } }];
    // for a form with no matching score rules, score 0 → the global floor (min 0) wins when no scoped rule ties.
    const other = readDecideConfig(withGlobal, 'some-other-form');
    expect(other.segmentRules.map((r) => r.segmentId)).toEqual(['global-floor']);
  });
});
