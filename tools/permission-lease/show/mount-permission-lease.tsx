import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui/index.ts';
import { PermissionLeasePanel } from './PermissionLeasePanel.tsx';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function PermissionLeaseMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="permission-lease material">
        <PermissionLeasePanel />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <PermissionLeaseMaterial props={props} />);
}
