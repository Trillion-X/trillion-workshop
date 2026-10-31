// Render-contract proof for a student feedback sequence. This feeds the sequence DATA + the three shipped
// question-type rows (text/choice/rating) into the real render model: all three fields resolve to the right
// input components, with required-gating.
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import { buildFillScreenModel } from '../read-data/fill-screen-model.ts';
import {
  indexCapabilities,
  type QuestionTypeCapability,
} from '../read-data/question-descriptor.ts';
import {
  readQuestionSequenceById,
} from '../read-data/read-forms-data.ts';

// The three shipped question-type rows.
const CAPS: QuestionTypeCapability[] = [
  { questionTypeId: 'text', inputComponentKey: 'text', coerce: 'string', validate: { rules: { required: false } } },
  { questionTypeId: 'choice', inputComponentKey: 'choice', coerce: 'string', validate: { rules: { required: false } } },
  { questionTypeId: 'rating', inputComponentKey: 'rating', coerce: 'number', validate: { rules: { required: false, min: 1, max: 5 } } },
];
const REG = indexCapabilities(CAPS);

// A feedback sequence record.
const FEEDBACK_SEQUENCE_RECORD = {
  payload: {
    kind: 'question-sequence',
    formId: 'course-feedback',
    title: 'How is the course going?',
    questions: [
      { questionId: 'enjoyment', questionTypeId: 'rating', label: 'How are you enjoying the course so far? (1 = just getting started, 5 = loving it)', required: true },
      { questionId: 'recommend', questionTypeId: 'choice', label: 'Would you recommend the course to a friend?', required: false, options: [{ label: 'Not yet', value: 'not-yet' }, { label: 'Maybe', value: 'maybe' }, { label: 'Definitely', value: 'definitely' }] },
      { questionId: 'comment', questionTypeId: 'text', label: "What's working, and what would make it better?", placeholder: 'Share anything on your mind', required: false },
    ],
  },
};

describe('feedback sequence — render contract', () => {
  it('a surface bound to sequence_id=course-feedback resolves exactly this form', () => {
    const seq = readQuestionSequenceById([FEEDBACK_SEQUENCE_RECORD], 'course-feedback');
    expect(seq).not.toBeNull();
    expect(seq!.formId).toBe('course-feedback');
    expect(seq!.title).toBe('How is the course going?');
    expect(seq!.questions.map((q) => q.questionId)).toEqual(['enjoyment', 'recommend', 'comment']);
  });

  it('FillSurface renders all three fields with the correct input components', () => {
    const seq = readQuestionSequenceById([FEEDBACK_SEQUENCE_RECORD], 'course-feedback')!;
    const m = buildFillScreenModel(seq.questions, REG, {});
    expect(m.rows.map((r) => r.inputComponentKey)).toEqual(['rating', 'choice', 'text']);
    expect(m.rows.map((r) => r.coerce)).toEqual(['number', 'string', 'string']);
  });

  it('the rating is required (gates submit); recommend + comment are optional', () => {
    const seq = readQuestionSequenceById([FEEDBACK_SEQUENCE_RECORD], 'course-feedback')!;
    const empty = buildFillScreenModel(seq.questions, REG, {});
    expect(empty.allValid).toBe(false);
    expect(empty.firstInvalidId).toBe('enjoyment');
    // rating answered alone → valid (the two optional fields never block submit).
    const rated = buildFillScreenModel(seq.questions, REG, { enjoyment: 4 }, { revealErrors: true });
    expect(rated.allValid).toBe(true);
    expect(rated.firstInvalidId).toBeNull();
    expect(rated.rows.every((r) => r.error === null)).toBe(true);
  });
});
