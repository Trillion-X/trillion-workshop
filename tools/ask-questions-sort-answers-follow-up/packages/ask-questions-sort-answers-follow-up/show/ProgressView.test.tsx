// packages/ask-questions-sort-answers-follow-up/show/ProgressView.test.tsx
//
// Contract for ProgressView's respondent resolution: with NO explicit
// respondentId the View resolves the SAME stable identity the fill screen
// writes under (resolveRespondentIdNow), so a student's own sessions fold with
// zero config; an explicit override still wins. Also pins that until identity
// resolves, nothing folds (no flash of another respondent's rows).

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';

const resolveRespondentIdNow = vi.fn(async (explicit?: string) => explicit ?? 'student-1');
vi.mock('@/packages/ask-questions-sort-answers-follow-up/read-data/current-respondent', () => ({
  resolveRespondentIdNow: (explicit?: string) => resolveRespondentIdNow(explicit),
}));

const FEED = [
  { payload: { kind: 'answer-fact', formId: 'f', respondentId: 'student-1', questionId: 'focus_rating', value: 7, answered_at: '2026-06-20T18:00:00Z', submissionId: 'sub-1' } },
  { payload: { kind: 'answer-fact', formId: 'f', respondentId: 'someone-else', questionId: 'focus_rating', value: 2, answered_at: '2026-06-21T18:00:00Z', submissionId: 'sub-x' } },
];
vi.mock(
  '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react',
  () => ({ useBitfieldData: () => FEED }),
);

import { ProgressView } from './ProgressView';

afterEach(cleanup);

describe('ProgressView respondent resolution', () => {
  it('no explicit id -> resolves the stable respondent and folds ONLY their sessions', async () => {
    render(<ProgressView formId="f" fieldMap={{ focus: 'focus_rating' }} />);
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy()); // 1 session (student-1 only)
    expect(resolveRespondentIdNow).toHaveBeenCalledWith(undefined);
    expect(screen.queryByText('2')).toBeNull(); // someone-else's value never renders
  });

  it('explicit respondentId prop wins (DATA override)', async () => {
    render(<ProgressView formId="f" respondentId="someone-else" fieldMap={{ focus: 'focus_rating' }} />);
    await waitFor(() => expect(resolveRespondentIdNow).toHaveBeenCalledWith('someone-else'));
    await waitFor(() => expect(screen.getByText('1')).toBeTruthy()); // someone-else has 1 session
  });
});
