// packages/screen-arrangement/show/ComponentMaterialSurface.tsx
//
// Screen-local placement host for package entry bytes. The exact source bytes
// are read through the package-declared selected-payload input, then put on
// screen by the browser thing-to-put-on-screen runtime in this DOM sink.

'use client'

import React from 'react';
import type { PackageEntryReference } from '../read-data/layout-types';
import { PlaceableSurfaceHost } from '../../ui/show/placeable-surface-host';

// Thin screen-arrangement adapter over the shared PlaceableSurfaceHost (the one
// generic surface-mount host, in `ui`). Callers pass a PackageEntryReference;
// this splits it into the name pair the host takes. The fetch + DOM-mount + the
// generic `frame_fit` handling all live in the host, so a board item and a tab
// body render live surfaces through the exact same path.
export function ComponentMaterialSurface({
  packageEntry,
  target = null,
  materialTarget = null,
  surfaceInput,
}: {
  packageEntry: PackageEntryReference;
  target?: string | null;
  materialTarget?: string | null;
  surfaceInput?: Record<string, unknown>;
}) {
  return (
    <PlaceableSurfaceHost
      packageName={packageEntry.packageName}
      entryName={packageEntry.entryName}
      target={target}
      materialTarget={materialTarget}
      surfaceInput={surfaceInput}
      fill
    />
  );
}
