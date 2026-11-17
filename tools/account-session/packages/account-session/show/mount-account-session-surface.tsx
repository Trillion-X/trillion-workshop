import React from 'react';
import { ErrorBoundary } from '../../../../ui/show/error-boundary';
import { mountReactSurface } from '../../../../ui/show/react-surface-mount';
import { AccountSessionSurfaceClient as AccountSessionSurface } from './AccountSessionSurfaceClient';

type MountArgs = {
  el: HTMLElement;
};

function AccountSessionRoot() {
  return (
    <ErrorBoundary zoneName="account-session">
      <AccountSessionSurface />
    </ErrorBoundary>
  );
}

export default function mount({ el }: MountArgs) {
  return mountReactSurface(el, <AccountSessionRoot />);
}
