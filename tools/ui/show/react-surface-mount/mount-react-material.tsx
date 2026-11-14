import React from 'react';
import { ErrorBoundary } from '../error-boundary';
import { FloatingMaterialFrame } from '../floating-material-frame';
import { mountReactSurface, type ReactSurfaceUnmount } from './mount-react-surface';

export interface ReactMaterialMountArgs {
  el: HTMLElement;
  props?: Record<string, unknown>;
}

export function mountReactMaterial(
  target: HTMLElement,
  node: React.ReactNode,
  props: Record<string, unknown> = {},
  zoneName = 'package material',
): ReactSurfaceUnmount {
  return mountReactSurface(
    target,
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName={zoneName}>
        {node}
      </ErrorBoundary>
    </FloatingMaterialFrame>,
  );
}
