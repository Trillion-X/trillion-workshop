// packages/guided-overlay/show/mount-overlays-list.tsx
//
// Package entry: mounts the guided-overlays LIST surface as a placeable panel.
// The build pipeline turns this into a component_id (component:guided-overlay-overlays-list)
// that a placeable-surface points at. The surface reads the package's own
// walkthrough-feed and starts a tour by dispatching its walkthrough event.
import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui/index.ts';
import { OverlaysListSurface } from './OverlaysListSurface.tsx';

type MountArgs = {
  el: HTMLElement;
  props?: Record<string, unknown>;
};

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(
    el,
    <FloatingMaterialFrame frame={props.floating_frame} className="h-full min-h-0 overflow-hidden">
      <ErrorBoundary zoneName="guided-overlay overlays-list">
        <OverlaysListSurface />
      </ErrorBoundary>
    </FloatingMaterialFrame>,
  );
}
