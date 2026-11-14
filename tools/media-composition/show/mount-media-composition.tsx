import React from 'react';
import { ErrorBoundary } from '../../ui/show/error-boundary';
import { FloatingMaterialFrame } from '../../ui/show/floating-material-frame';
import { mountReactSurface } from '../../ui/show/react-surface-mount';
import { MediaCompositionPanel } from './MediaCompositionPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function readSurfaceInput(props: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = props.surfaceInput;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function MediaCompositionMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Edit media">
        <MediaCompositionPanel surfaceInput={readSurfaceInput(props)} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <MediaCompositionMaterial props={props} />);
}
