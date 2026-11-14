import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { BackgroundRunnerControl } from '@/packages/background-runner-control/show/BackgroundRunnerControl';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function BackgroundRunnerControlMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="background-runner-control material">
        <BackgroundRunnerControl />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <BackgroundRunnerControlMaterial props={props} />);
}
