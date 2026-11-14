// packages/ask-questions-sort-answers-follow-up/show/ProgressView.tsx
//
// Entry View for the respondent's OWN progress surface: reads the live
// published-records feed (which carries the answer-facts), folds THIS respondent's
// sessions into a time series, and renders ProgressSurface. Reactive — it re-folds
// whenever the feed changes (a new submission appears), mirroring ResultsView.
// Config (which form, whose facts, the field map, columns) is DATA from the
// surface descriptor (L090) — the View hardcodes no domain field.

import React from 'react';
import { useBitfieldData } from '@/packages/ask-questions-sort-answers-follow-up/.bitfield-entry-scope/ask-questions-sort-answers-follow-up/runtime-kit-react';
import { ProgressSurface, type ProgressColumn } from '@/packages/ask-questions-sort-answers-follow-up/show/ProgressSurface';
import { buildProgressModel } from '@/packages/ask-questions-sort-answers-follow-up/read-data/progress-model';
import { resolveRespondentIdNow } from '@/packages/ask-questions-sort-answers-follow-up/read-data/current-respondent';
import type { ProgressFieldMap } from '@/packages/ask-questions-sort-answers-follow-up/read-data/session-progress-rows';

export interface ProgressViewProps {
  formId?: string;
  /** Explicit respondent override (DATA). Absent -> resolves the SAME stable
   *  identity the fill screen writes under (signed-in student -> per-device
   *  fallback, read-data/current-respondent.ts) so a student's own progress
   *  folds without any config. */
  respondentId?: string;
  fieldMap?: ProgressFieldMap;
  trendField?: string;
  columns?: ProgressColumn[];
  dateLabel?: string;
  trendLabel?: string;
}

export function ProgressView(props: ProgressViewProps) {
  const published = useBitfieldData('published-records');
  // Resolve the same respondent identity the journal writes under, so the fold
  // and the fill screen agree on whose sessions these are (single identity SSOT).
  const [resolvedRespondentId, setResolvedRespondentId] = React.useState<string | null>(null);
  React.useEffect(() => {
    let alive = true;
    void resolveRespondentIdNow(props.respondentId).then((id) => {
      if (alive) setResolvedRespondentId(id);
    });
    return () => {
      alive = false;
    };
  }, [props.respondentId]);
  const model = React.useMemo(
    () =>
      buildProgressModel(resolvedRespondentId === null ? [] : published, {
        formId: props.formId,
        respondentId: resolvedRespondentId ?? undefined,
        fieldMap: props.fieldMap ?? {},
        trendField: props.trendField,
      }),
    [published, props.formId, resolvedRespondentId, props.fieldMap, props.trendField],
  );
  return (
    <ProgressSurface
      model={model}
      columns={props.columns}
      dateLabel={props.dateLabel}
      trendLabel={props.trendLabel}
    />
  );
}
