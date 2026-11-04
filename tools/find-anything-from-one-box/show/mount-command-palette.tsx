// packages/command-palette/show/mount-command-palette.tsx
//
// Package-owned browser mount for the global command palette root.

import React from 'react';
import { ErrorBoundary, mountReactSurface } from '../../ui';
import { CommandPaletteRoot } from './CommandPaletteGate';

type MountArgs = {
  el: HTMLElement;
};

export { CommandPaletteRoot };

export default function mount({ el }: MountArgs) {
  return mountReactSurface(
    el,
    <ErrorBoundary zoneName="command-palette root">
      <CommandPaletteRoot />
    </ErrorBoundary>,
  );
}
