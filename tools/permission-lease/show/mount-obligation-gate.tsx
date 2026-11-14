import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui/index.ts';
import { ObligationGatePanel } from './ObligationGatePanel.tsx';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function ObligationGateMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="obligation-gate material">
        <ObligationGatePanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ObligationGateMaterial props={props} />);
}
