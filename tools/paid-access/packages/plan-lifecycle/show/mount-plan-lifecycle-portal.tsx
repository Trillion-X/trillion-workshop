import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { PlanLifecyclePortalSurface } from './app-shell/PlanLifecyclePortalSurface';

type MountArgs = {
  el: HTMLElement;
};

function PlanLifecyclePortalRoot() {
  return (
    <ErrorBoundary zoneName="plan-lifecycle-portal">
      <PlanLifecyclePortalSurface />
    </ErrorBoundary>
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(el, <PlanLifecyclePortalRoot />);
}
