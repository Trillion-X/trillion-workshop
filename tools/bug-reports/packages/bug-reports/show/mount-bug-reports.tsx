import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { BugReportsSurface } from '@/packages/bug-reports/show/BugReportsSurface';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function BugReportsMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="bug-reports material">
        <BugReportsSurface />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <BugReportsMaterial props={props} />);
}
