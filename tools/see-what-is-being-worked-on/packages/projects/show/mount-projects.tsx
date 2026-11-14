import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import Projects from '@/packages/projects/index';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function ProjectsMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="projects material">
        <Projects />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <ProjectsMaterial props={props} />);
}
