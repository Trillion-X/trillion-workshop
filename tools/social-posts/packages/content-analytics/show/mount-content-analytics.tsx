import React from 'react';
import { ErrorBoundary } from '../../../../ui/show/error-boundary';
import { FloatingMaterialFrame } from '../../../../ui/show/floating-material-frame';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { ContentAnalyticsPanel } from './ContentAnalyticsPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ContentAnalyticsMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="See content results">
        <ContentAnalyticsPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ContentAnalyticsMaterial props={props} />);
}
