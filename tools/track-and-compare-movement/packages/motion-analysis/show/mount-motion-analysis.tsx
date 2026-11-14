import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { FloatingMaterialFrame } from '@/packages/ui/show/floating-material-frame';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { MotionAnalysisPanel } from '@/packages/motion-analysis/show/MotionAnalysisPanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function MotionAnalysisMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Compare movement">
        <MotionAnalysisPanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <MotionAnalysisMaterial props={props} />);
}
