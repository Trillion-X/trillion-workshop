import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { ActivationManagerPortalSurface } from './app-shell/ActivationManagerPortalSurface';

type MountArgs = {
  el: HTMLElement;
};

function ActivationManagerPortalRoot() {
  return (
    <ErrorBoundary zoneName="activation-manager-portal">
      <ActivationManagerPortalSurface />
    </ErrorBoundary>
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(el, <ActivationManagerPortalRoot />);
}
