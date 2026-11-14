// packages/ask-questions-sort-answers-follow-up/show/mount-builder.tsx
//
// Package entry for the builder surface. Same mount pattern as the fill entry.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import { BuilderView } from '@/packages/ask-questions-sort-answers-follow-up/show/BuilderView';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function BuilderMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="ask-questions-sort-answers-follow-up builder material">
        <ToastProvider>
          <BuilderView />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <BuilderMaterial props={props} />);
}
