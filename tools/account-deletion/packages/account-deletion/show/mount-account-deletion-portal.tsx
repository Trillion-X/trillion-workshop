import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { AccountDeletionPortalSurface } from './app-shell/AccountDeletionPortalSurface';

type MountArgs = {
  el: HTMLElement;
};

function AccountDeletionPortalRoot() {
  return (
    <ErrorBoundary zoneName="account-deletion-portal">
      <AccountDeletionPortalSurface />
    </ErrorBoundary>
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(el, <AccountDeletionPortalRoot />);
}
