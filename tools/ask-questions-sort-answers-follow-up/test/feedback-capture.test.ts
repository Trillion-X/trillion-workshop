// Capture-contract proof for a feedback form: submitting the course-feedback form builds one answer-fact
// per answer, written together with the decision. This locks the shape the builders write: the record
// id (answer-fact:<form>:<respondent>:<question>), its type, and the payload
// {kind:'answer-fact', formId, respondentId, questionId, value, answered_at}.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildProcessSubmission } from '../do-work/process-submission.ts';


// A feedback form has no scoring/segmentation — an empty decide config.
const NO_DECIDE = { scoreRules: [], segmentRules: [], followUpSequences: [] };
const FORM = 'course-feedback';
const RESP = 'student-42';
const AT = '2026-07-02T00:00:00Z';
const ANSWERS = { enjoyment: 4, recommend: 'definitely', comment: 'love the exercises' };

describe('feedback form — capture contract', () => {
  it('a submission builds an answer-fact record per answer', () => {
    const plan = buildProcessSubmission(FORM, RESP, ANSWERS, NO_DECIDE, AT);
    const facts = plan.writes.filter((w) => (w.value as { kind?: string }).kind === 'answer-fact');
    expect(facts.map((w) => (w.value as { questionId: string }).questionId)).toEqual(['enjoyment', 'recommend', 'comment']);
  });

  it('each answer-fact is identified by (form, respondent, question) with the entered value', () => {
    const plan = buildProcessSubmission(FORM, RESP, ANSWERS, NO_DECIDE, AT);
    const facts = plan.writes.filter((w) => (w.value as { kind?: string }).kind === 'answer-fact');
    const enjoyment = facts.find((w) => (w.value as { questionId: string }).questionId === 'enjoyment')!;
    expect(enjoyment.id).toBe('answer-fact:course-feedback:student-42:enjoyment');
    expect(enjoyment.type).toBe('answer-fact');
    expect(enjoyment.value).toMatchObject({ kind: 'answer-fact', formId: FORM, respondentId: RESP, questionId: 'enjoyment', value: 4, answered_at: AT });
  });

  it('an empty feedback config produces no follow-up (feedback is capture-only)', () => {
    const plan = buildProcessSubmission(FORM, RESP, ANSWERS, NO_DECIDE, AT);
    expect(plan.followUp).toBeNull();
  });
});
