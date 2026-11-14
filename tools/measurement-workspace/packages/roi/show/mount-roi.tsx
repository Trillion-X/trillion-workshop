import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ROIDashboard } from './ROIDashboard';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function RoiMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="roi material">
        <ROIDashboard />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <RoiMaterial props={props} />);
}
