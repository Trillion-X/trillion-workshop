// packages/ask-questions-sort-answers-follow-up/show/mount-progress.tsx
//
// Package entry for the respondent's own progress surface. Config flows in as DATA
// via props.surfaceInput (snake_case from the placeable-surface descriptor), so a
// different form / field map / columns is a data change, never code (L090).

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import { ProgressView, type ProgressViewProps } from '@/packages/ask-questions-sort-answers-follow-up/show/ProgressView';
import type { ProgressColumn } from '@/packages/ask-questions-sort-answers-follow-up/show/ProgressSurface';
import type { ProgressFieldMap } from '@/packages/ask-questions-sort-answers-follow-up/read-data/session-progress-rows';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Translate the surfaceInput DATA (snake_case) into ProgressView props. */
function readConfig(props: Record<string, unknown>): ProgressViewProps {
  const si = (props.surfaceInput ?? props.surface_input ?? {}) as Record<string, unknown>;
  const fieldMap = (si.field_map ?? si.fieldMap) as ProgressFieldMap | undefined;
  const columns = (si.columns as ProgressColumn[] | undefined) ?? undefined;
  return {
    formId: asString(si.form_id ?? si.formId),
    respondentId: asString(si.respondent_id ?? si.respondentId),
    fieldMap: fieldMap ?? {},
    trendField: asString(si.trend_field ?? si.trendField),
    columns,
    dateLabel: asString(si.date_label ?? si.dateLabel),
    trendLabel: asString(si.trend_label ?? si.trendLabel),
  };
}

function ProgressMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ask-questions-sort-answers-follow-up progress material">
        <ToastProvider>
          <ProgressView {...readConfig(props)} />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ProgressMaterial props={props} />);
}
