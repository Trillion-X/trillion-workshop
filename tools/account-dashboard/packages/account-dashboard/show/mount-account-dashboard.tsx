import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { AccountDashboardSurface } from './AccountDashboardSurface';

type MountArgs = {
  el: HTMLElement;
};

function AccountDashboardRoot() {
  return (
    <ErrorBoundary zoneName="account-dashboard">
      <AccountDashboardSurface />
    </ErrorBoundary>
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(el, <AccountDashboardRoot />);
}
