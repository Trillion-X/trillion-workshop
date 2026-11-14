import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { ContentDistributionPanel } from '@/packages/content-distribution/show/ContentDistributionPanel';

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
