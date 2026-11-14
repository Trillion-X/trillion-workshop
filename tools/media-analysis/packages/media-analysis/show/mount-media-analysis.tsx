import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { MediaAnalysisPanel } from '@/packages/media-analysis/show/MediaAnalysisPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function MediaAnalysisMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Analyze photos and videos">
        <MediaAnalysisPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <MediaAnalysisMaterial props={props} />);
}
