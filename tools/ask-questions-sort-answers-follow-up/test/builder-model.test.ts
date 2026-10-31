// packages/ask-questions-sort-answers-follow-up/read-data/builder-model.test.ts
import { describe, expect, it } from '../../../test-helpers/vitest-shim.mjs';
import {
  newQuestion,
  newQuestionSequence,
  addQuestion,
  removeQuestion,
  updateQuestion,
  moveQuestion,
  setTitle,
} from '../read-data/builder-model.ts';

function draft() {
  let seq = newQuestionSequence('intake', 'Intake');
  seq = addQuestion(seq, newQuestion('q1', 'text', 'Name'));
  seq = addQuestion(seq, newQuestion('q2', 'choice', 'Level'));
  seq = addQuestion(seq, newQuestion('q3', 'rating', 'Rate'));
  return seq;
}

describe('builder-model — pure immutable ops', () => {
  it('newQuestionSequence starts empty; addQuestion appends', () => {
    expect(draft().questions.map((q) => q.questionId)).toEqual(['q1', 'q2', 'q3']);
  });

  it('does not mutate the input sequence', () => {
    const seq = draft();
    const before = seq.questions.length;
    removeQuestion(seq, 'q1');
    expect(seq.questions.length).toBe(before);
  });

  it('removeQuestion drops by id', () => {
    expect(removeQuestion(draft(), 'q2').questions.map((q) => q.questionId)).toEqual(['q1', 'q3']);
  });

  it('updateQuestion patches fields (never the questionId)', () => {
    const q = updateQuestion(draft(), 'q1', { label: 'Full name', required: true }).questions[0];
    expect(q).toMatchObject({ questionId: 'q1', label: 'Full name', required: true });
  });

  it('moveQuestion reorders (and clamps out-of-range targets)', () => {
    expect(moveQuestion(draft(), 'q3', 0).questions.map((q) => q.questionId)).toEqual(['q3', 'q1', 'q2']);
    expect(moveQuestion(draft(), 'q1', 99).questions.map((q) => q.questionId)).toEqual(['q2', 'q3', 'q1']);
  });

  it('moveQuestion is a no-op for an unknown id', () => {
    expect(moveQuestion(draft(), 'nope', 0).questions.map((q) => q.questionId)).toEqual(['q1', 'q2', 'q3']);
  });

  it('setTitle updates the title', () => {
    expect(setTitle(draft(), 'New Title').title).toBe('New Title');
  });
});
