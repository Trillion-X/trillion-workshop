import React from 'react';
import { ErrorBoundary } from '../../../../ui/show/error-boundary';
import { FloatingMaterialFrame } from '../../../../ui/show/floating-material-frame';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { ContentDistributionPanel } from './ContentDistributionPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ContentDistributionMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Distribution">
        <ContentDistributionPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ContentDistributionMaterial props={props} />);
}
