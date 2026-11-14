// packages/ask-questions-sort-answers-follow-up/show/mount-synthesis.tsx
//
// Package entry for the generic AI-synthesis readout over a sequence's answers.
// All specifics arrive as DATA on surfaceInput (L090) — the view is blind.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import { SynthesisView } from '@/packages/ask-questions-sort-answers-follow-up/show/SynthesisView';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function SynthesisMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = (props.surfaceInput ?? {}) as Record<string, unknown>;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ask-questions-sort-answers-follow-up synthesis material">
        <ToastProvider>
          <SynthesisView
            sequenceId={str(surfaceInput.sequence_id) ?? str(surfaceInput.sequenceId)}
            wrapPrefix={str(surfaceInput.wrap_prefix)}
            definitionId={str(surfaceInput.definition_id)}
            outputKind={str(surfaceInput.output_kind)}
            eyebrow={str(surfaceInput.eyebrow)}
            title={str(surfaceInput.title)}
            actionLabel={str(surfaceInput.action_label)}
            resultKey={str(surfaceInput.result_key)}
            targetGroupRef={str(surfaceInput.target_group_ref)}
            emptyHint={str(surfaceInput.empty_hint)}
          />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <SynthesisMaterial props={props} />);
}
