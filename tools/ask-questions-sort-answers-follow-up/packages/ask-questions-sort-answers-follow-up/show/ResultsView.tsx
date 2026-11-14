// packages/ask-questions-sort-answers-follow-up/show/ResultsView.tsx
//
// Entry View for the operator results surface: reads the segment-assignment
// facts from published-records, projects them, and renders ResultsSurface.

import React from 'react';
import { useBitfieldData } from '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react';
import { ResultsSurface } from '@/packages/ask-questions-sort-answers-follow-up/show/ResultsSurface';
import { buildResultsModel } from '@/packages/ask-questions-sort-answers-follow-up/read-data/results-model';

export interface ResultsViewProps {
  /** Show results for ONE form, by `formId` (from the surface config). Omitted →
   *  every form's results (the legacy all-forms view). Mirrors AskQuestionsView. */
  sequenceId?: string;
}

export function ResultsView({ sequenceId }: ResultsViewProps = {}) {
  const published = useBitfieldData('published-records');
  const model = React.useMemo(
    () => buildResultsModel(published, sequenceId),
    [published, sequenceId],
  );
  return <ResultsSurface model={model} />;
}
