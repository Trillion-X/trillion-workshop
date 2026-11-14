import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { ContentAnalyticsPanel } from '@/packages/content-analytics/show/ContentAnalyticsPanel';

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
