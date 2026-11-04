// packages/screen-recording/show/mount-screen-recording.tsx
//
// Host mount contract: reads { el, props } and renders via the shared
// mountReactMaterial helper (ErrorBoundary + FloatingMaterialFrame), like
// every other package surface. NOTE: the previous version tried to reach the
// root-creation API through the React namespace — that function only exists in
// react-dom/client, so the mount threw a TypeError and the surface rendered
// blank (caught by the 2026-07-25 nonstandard-mount category sweep; guard
// L140-mount-contract in lesson-rules.json now denies raw root-creation in
// package mount files).

import * as React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '../../ui';
import { ScreenRecordingPanel } from './ScreenRecordingPanel';

export function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(el, <ScreenRecordingPanel />, props, 'Screen recording');
}

export default mount;
