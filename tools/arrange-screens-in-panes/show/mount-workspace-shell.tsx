// packages/screen-arrangement/show/mount-workspace-shell.tsx
//
// Mount entry for the GENERIC DATA-driven embedded-workspace shell. The host
// passes the placeable-surface's surface_input through props.surfaceInput; this
// entry forwards it to WorkspaceShell, which renders ANY workspace from DATA
// (L069). Zero domain vocabulary; zero per-workspace code.

import React from 'react';
import { ErrorBoundary } from '../../ui/show/error-boundary';
import { FloatingMaterialFrame } from '../../ui/show/floating-material-frame';
import { mountReactSurface } from '../../ui/show/react-surface-mount';
import { WorkspaceShell } from './WorkspaceShell';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

function readSurfaceInput(props: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = props.surfaceInput;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function WorkspaceShellMaterial({ props }: { props: Record<string, unknown> }) {
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="Workspace">
        <WorkspaceShell surfaceInput={readSurfaceInput(props)} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <WorkspaceShellMaterial props={props} />);
}
