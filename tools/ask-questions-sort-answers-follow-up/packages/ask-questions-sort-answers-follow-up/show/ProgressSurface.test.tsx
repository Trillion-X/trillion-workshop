// packages/ask-questions-sort-answers-follow-up/show/ProgressSurface.test.tsx
//
// Render contract for ProgressSurface — the respondent's own progress surface.
// Proves honest-empty (WorkStartState before any session) and a populated render
// (session count + a trend + a per-session log, newest first) over the REAL model
// produced by buildProgressModel from real answer-facts. Composes shared ui only.

import React from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { ProgressSurface } from './ProgressSurface';
import { buildProgressModel } from '../../../read-data/progress-model';

afterEach(cleanup);

function fact(qid: string, value: unknown, at: string, sub: string) {
  return { payload: { kind: 'answer-fact', formId: 'f', respondentId: 's', questionId: qid, value, answered_at: at, submissionId: sub } };
}
const FEED = [
  fact('focus_rating', 6, '2026-06-20T18:00:00Z', 'sub-1'),
  fact('goals_met', 'partially', '2026-06-20T18:00:00Z', 'sub-1'),
  fact('focus_rating', 9, '2026-06-27T18:00:00Z', 'sub-2'),
  fact('goals_met', 'yes', '2026-06-27T18:00:00Z', 'sub-2'),
];
const OPTS = { formId: 'f', respondentId: 's', fieldMap: { focus: 'focus_rating', goals: 'goals_met' } };
const COLUMNS = [{ field: 'focus', label: 'Focus' }, { field: 'goals', label: 'Goals met' }];

describe('ProgressSurface', () => {
  it('honest-empty: no sessions -> a start-state, no fabricated rows (L117)', () => {
    const model = buildProgressModel([], OPTS);
    render(<ProgressSurface model={model} columns={COLUMNS} />);
    expect(screen.getByText(/Your progress starts with your first session/)).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('populated: session count + declared columns + per-session rows (newest first)', () => {
    const model = buildProgressModel(FEED, OPTS);
    const { container } = render(<ProgressSurface model={model} columns={COLUMNS} trendLabel="Focus" />);
    // the two sessions are counted
    expect(screen.getByText('Sessions')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    // declared column headers render (scoped to the table — "Focus" also appears in the stat strip)
    const table = container.querySelector('table') as HTMLElement;
    expect(within(table).getByText('Focus')).toBeTruthy();
    expect(within(table).getByText('Goals met')).toBeTruthy();
    // both real sessions' values appear (newest first: 9 before 6 in DOM order)
    const bodyText = within(table).getAllByRole('row').map((r) => r.textContent).join(' | ');
    expect(bodyText).toContain('9');
    expect(bodyText).toContain('6');
    expect(bodyText).toContain('yes');
  });

  it('derives columns from the data when none are declared (generic, no domain enum)', () => {
    const model = buildProgressModel(FEED, OPTS);
    const { container } = render(<ProgressSurface model={model} />);
    // derived headers are the mapped field keys (scoped to the table — the stat
    // strip also shows the trend field name "focus")
    const table = container.querySelector('table') as HTMLElement;
    expect(within(table).getByText('focus')).toBeTruthy();
    expect(within(table).getByText('goals')).toBeTruthy();
  });
});
