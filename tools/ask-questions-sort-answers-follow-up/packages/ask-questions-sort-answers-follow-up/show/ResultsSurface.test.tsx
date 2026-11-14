// packages/ask-questions-sort-answers-follow-up/show/ResultsSurface.test.tsx
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ResultsSurface } from '@/packages/ask-questions-sort-answers-follow-up/show/ResultsSurface';
import { buildResultsModel } from '@/packages/ask-questions-sort-answers-follow-up/read-data/results-model';

const ENTRY = [
  { payload: { kind: 'segment-assignment', formId: 'intake', respondentId: 'r1', segmentId: 'hot', score: 22, decided_at: '2026-06-26T01:00:00.000Z' } },
  { payload: { kind: 'segment-assignment', formId: 'intake', respondentId: 'r2', segmentId: 'cold', score: 3, decided_at: '2026-06-26T02:00:00.000Z' } },
];

afterEach(cleanup);

describe('ResultsSurface', () => {
  it('renders an honest empty state with no responses', () => {
    render(<ResultsSurface model={buildResultsModel([], 'intake')} />);
    expect(screen.getByText('No responses yet')).toBeTruthy();
  });

  it('renders a row per respondent + the per-segment summary', () => {
    render(<ResultsSurface model={buildResultsModel(ENTRY, 'intake')} />);
    expect(screen.getByText('r1')).toBeTruthy();
    expect(screen.getByText('r2')).toBeTruthy();
    expect(screen.getByText('22')).toBeTruthy(); // score
    expect(screen.getAllByText('hot').length).toBeGreaterThan(0); // segment (badge + summary label)
    expect(screen.getByText('Responses')).toBeTruthy(); // summary stat label
  });
});
