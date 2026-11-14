// packages/ask-questions-sort-answers-follow-up/show/mount-results.tsx
//
// Package entry for the operator results surface.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import { ResultsView } from '@/packages/ask-questions-sort-answers-follow-up/show/ResultsView';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ResultsMaterial({ props }: { props: Record<string, unknown> }) {
  // The surface names WHICH form's results it shows via `surfaceInput.sequence_id`
  // (the same generic channel the fill surface uses). Absent → every form.
  const surfaceInput = (props.surfaceInput ?? {}) as Record<string, unknown>;
  const rawId = surfaceInput.sequence_id ?? surfaceInput.sequenceId;
  const sequenceId = typeof rawId === 'string' ? rawId : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ask-questions-sort-answers-follow-up results material">
        <ToastProvider>
          <ResultsView sequenceId={sequenceId} />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ResultsMaterial props={props} />);
}
