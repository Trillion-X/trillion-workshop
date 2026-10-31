// Carried from bitfield-packages packages/ask-questions-sort-answers-follow-up/do-work/save-question-sequence.test.ts.
// Changed from the package: the form is a door record { id, type, value }; the engine write-batch case is gone
// with the envelope, and a case proves `presentation` survives the round trip (the defect the builder's note
// describes).
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  questionSequenceId,
  buildSaveQuestionSequenceWrite,
  QUESTION_SEQUENCE_KIND,
} from '../do-work/save-question-sequence.ts';
import { readFirstQuestionSequence } from '../read-data/read-forms-data.ts';
import { payloadRows } from '../read-data/record-rows.ts';
import type { QuestionSequence } from '../read-data/question-descriptor.ts';

const SEQ: QuestionSequence = {
  formId: 'intake',
  title: 'Intake',
  questions: [{ questionId: 'q1', questionTypeId: 'text', label: 'Name', required: true }],
};

describe('save-question-sequence', () => {
  it('addresses the form by formId', () => {
    expect(questionSequenceId('intake')).toBe('question-sequence:intake');
  });

  it('builds a question-sequence record write', () => {
    const w = buildSaveQuestionSequenceWrite(SEQ);
    expect(w.type).toBe(QUESTION_SEQUENCE_KIND);
    expect(w.value.kind).toBe(QUESTION_SEQUENCE_KIND);
    expect(w.value.formId).toBe('intake');
    expect(w.value.questions).toHaveLength(1);
    expect(w.id).toBe('question-sequence:intake');
  });

  it('round-trips: a saved record decodes back via the fill-side reader (L097 one write path)', () => {
    const w = buildSaveQuestionSequenceWrite(SEQ);
    const decoded = readFirstQuestionSequence(payloadRows([w]));
    expect(decoded?.formId).toBe('intake');
    expect(decoded?.questions[0].questionId).toBe('q1');
  });

  it('keeps the form\'s own presentation (mode and button words) through the round trip', () => {
    const w = buildSaveQuestionSequenceWrite({ ...SEQ, presentation: { mode: 'one-at-a-time', nextLabel: 'Onward' } });
    const decoded = readFirstQuestionSequence(payloadRows([w]));
    expect(decoded?.presentation?.mode).toBe('one-at-a-time');
    expect(decoded?.presentation?.nextLabel).toBe('Onward');
  });
});
