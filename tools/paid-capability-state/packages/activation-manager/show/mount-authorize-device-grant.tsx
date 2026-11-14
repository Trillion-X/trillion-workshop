import React from 'react';
import { ErrorBoundary } from '@/packages/ui/show/error-boundary';
import { mountReactSurface } from '@/packages/ui/show/react-surface-mount';
import { AuthorizeDeviceGrantPage } from './AuthorizeDeviceGrantPage';

type MountArgs = {
  el: HTMLElement;
};

export { AuthorizeDeviceGrantPage } from './AuthorizeDeviceGrantPage';

export default function mount({ el }: MountArgs) {
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="authorize-device-grant">
      <AuthorizeDeviceGrantPage />
    </ErrorBoundary>,
  );
}
