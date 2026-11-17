import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../../../ui';
import { CurrentSummarySurface } from './CurrentSummarySurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function CurrentSummaryMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="current-summary material">
        <CurrentSummarySurface />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <CurrentSummaryMaterial props={props} />);
}
