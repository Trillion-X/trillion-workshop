// packages/access-scoped-content/show/mount-access-scoped-content.tsx
//
// Package entry for the Learn (access-scoped content) surface.
//
// WHY THIS EXISTS: the entry MUST self-render via `mountReactSurface` so the
// surface's React render and its hooks use the SAME (entry-bundled) React. The
// old entry pointed `source_path`/`export_name` directly at the raw
// `AccessScopedContent` component, so the host rendered it with the HOST's React
// while its hooks bound to the entry-bundled React → `ReactCurrentDispatcher` is
// null → the first `useRef` inside `useBitfieldData` threw
// "Cannot read properties of null (reading 'useRef')" and the whole surface
// crashed. Every working surface (person-list, ask-questions results/progress,
// synthesis) uses this exact mount-wrapper shape; Learn was the odd one out.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ToastProvider } from '@/packages/ui/show/toast';
import {
  AccessScopedContent,
  type AccessScopedSurfaceInput,
} from '@/packages/access-scoped-content/show/AccessScopedContent';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function AccessScopedMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = (props.surfaceInput ?? props.surface_input ?? {}) as AccessScopedSurfaceInput;
  const title = typeof props.title === 'string' ? props.title : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="access-scoped-content material">
        <ToastProvider>
          <AccessScopedContent surfaceInput={surfaceInput} title={title} />
        </ToastProvider>
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <AccessScopedMaterial props={props} />);
}
