// packages/ask-questions-sort-answers-follow-up/show/mount-ask-questions-sort-answers-follow-up.tsx
//
// Package entry: mounts the AskQuestionsView into a placeable-surface frame.
// Mirrors the canonical mount pattern (FloatingMaterialFrame + ErrorBoundary +
// ToastProvider + View). The build pipeline turns this into a component_id.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import { AskQuestionsView } from '@/packages/ask-questions-sort-answers-follow-up/show/AskQuestionsView';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function AskQuestionsMaterial({ props }: { props: Record<string, unknown> }) {
  // The surface names WHICH form it fills via its own `surfaceInput` config
  // (L069/L090) — the same generic channel the host uses for `frame_fit` and
  // WorkspaceShell config (ComponentMaterialSurface → props.surfaceInput).
  // DATA is snake_case (`sequence_id`); camelCase accepted as a fallback.
  // Absent → the view falls back to the first sequence (single-form case).
  const surfaceInput = (props.surfaceInput ?? {}) as Record<string, unknown>;
  const rawId = surfaceInput.sequence_id ?? surfaceInput.sequenceId;
  const sequenceId = typeof rawId === 'string' ? rawId : undefined;
  const rawRunId = surfaceInput.run_id ?? surfaceInput.runId;
  const runId = typeof rawRunId === 'string' ? rawRunId : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ask-questions-sort-answers-follow-up material">
        <ToastProvider>
          <AskQuestionsView sequenceId={sequenceId} runId={runId} />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <AskQuestionsMaterial props={props} />);
}
