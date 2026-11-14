import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import { ProjectGateCompliancePanel } from './ProjectGateCompliancePanel';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ProjectGateComplianceMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="project-gate-compliance material">
        <ProjectGateCompliancePanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ProjectGateComplianceMaterial props={props} />);
}
