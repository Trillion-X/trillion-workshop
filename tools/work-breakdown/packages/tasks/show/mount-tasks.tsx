import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '@/packages/ui';
import Tasks from '@/packages/tasks/index';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function TasksMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="tasks material">
        <Tasks />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <TasksMaterial props={props} />);
}
