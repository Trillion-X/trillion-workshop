import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  process: vi.fn(async () => ({ decision: { score: 0, segmentId: null } })),
  afterSaved: vi.fn(async () => undefined),
  feed: [
    { payload: { kind: 'question-type-capability', questionTypeId: 'source', inputComponentKey: 'evidence-reference', coerce: 'evidence-reference' } },
    { payload: { kind: 'question-sequence', formId: 'form-a', title: 'Source form', questions: [
      { questionId: 'q', questionTypeId: 'source', label: 'Source', required: true },
    ] } },
  ],
}));
vi.mock('@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react', () => ({ useBitfieldData: () => fixtures.feed }));
vi.mock('@/packages/ask-questions-sort-answers-follow-up/read-data/current-respondent', () => ({
  resolveRespondentIdNow: async (value: string) => value,
  freshRespondentId: () => 'draft-unique',
}));
vi.mock('@/packages/ask-questions-sort-answers-follow-up/do-work/process-submission', () => ({ processSubmission: fixtures.process }));
vi.mock('@/packages/ask-questions-sort-answers-follow-up/do-work/run-after-saved-actions', () => ({ runAfterSavedActions: fixtures.afterSaved }));
import { AskQuestionsView } from './AskQuestionsView';
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('uses the same draft correlation for source collection and the saved answer batch', async () => {
  const source = { kind: 'question-answer.evidence-reference', reference: { id: 'opaque-source' } };
  const request = vi.fn(async () => source);
  render(<AskQuestionsView sequenceId="form-a" respondentId="person-a" onRequestEvidenceReference={request} />);
  fireEvent.click(screen.getByRole('button', { name: 'Add source' }));
  await screen.findByText('Added');
  expect(request).toHaveBeenCalledWith({ formId: 'form-a', respondentId: 'person-a', questionId: 'q', draftId: 'submission:draft-unique', submissionId: 'submission:draft-unique' });
  fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(fixtures.process).toHaveBeenCalledTimes(1));
  expect(fixtures.process.mock.calls[0]).toEqual([
    'form-a', 'person-a', { q: source }, expect.any(Object), expect.any(String), 'submission:draft-unique',
  ]);
  await screen.findByText(/your answers were saved/i);
});
