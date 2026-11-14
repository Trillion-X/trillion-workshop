import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { AccountPortalShell } from './app-shell/AccountPortalShell';

type MountArgs = {
  el: HTMLElement;
};

function AccountPortalShellRoot() {
  return (
    <ErrorBoundary zoneName="account-portal-shell">
      <AccountPortalShell />
    </ErrorBoundary>
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(el, <AccountPortalShellRoot />);
}
