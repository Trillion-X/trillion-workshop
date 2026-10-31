// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/do-work/answer-fact-writes.test.ts.
// Changed from the package: a fact is a door record { id, type, value }, so the address-label assertions are
// record-id assertions; the engine write-batch envelope case is gone with the envelope.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  answerFactId,
  buildAnswerFactWrites,
  ANSWER_FACT_KIND,
} from '../do-work/answer-fact-writes.ts';

const AT = '2026-06-26T00:00:00.000Z';

describe('answerFactId', () => {
  it('encodes (formId, respondentId, questionId) addressably', () => {
    expect(answerFactId('intake', 'r1', 'q-name')).toBe('answer-fact:intake:r1:q-name');
  });
});

describe('buildAnswerFactWrites', () => {
  it('emits one addressable fact per answered question (not one blob)', () => {
    const writes = buildAnswerFactWrites('intake', 'r1', { 'q-name': 'Sam', 'q-rate': 5 }, AT);
    expect(writes).toHaveLength(2);
    expect(writes.map((w) => w.id)).toEqual([
      'answer-fact:intake:r1:q-name',
      'answer-fact:intake:r1:q-rate',
    ]);
    expect(writes[0].value).toEqual({
      kind: ANSWER_FACT_KIND,
      formId: 'intake',
      respondentId: 'r1',
      questionId: 'q-name',
      value: 'Sam',
      answered_at: AT,
    });
    expect(writes[1].value.value).toBe(5);
    expect(writes.every((w) => w.type === ANSWER_FACT_KIND)).toBe(true);
  });

  it('emits nothing for an empty submission', () => {
    expect(buildAnswerFactWrites('f', 'r', {}, AT)).toEqual([]);
  });
});
