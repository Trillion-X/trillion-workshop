// package://packages/destination-surface/show/mount-destination.tsx
//
// Browser-local mount entry for the generic destination surface. Passes all
// mount props through, including `destination_ref` so placeable-surface
// records can each point the same entry at a different descriptor.

import React from 'react';
import { mountReactMaterial, type ReactMaterialMountArgs } from '@/packages/ui';
import { DestinationView } from '@/packages/destination-surface/show/DestinationView';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The descriptor ref arrives flattened OR nested under surfaceInput. */
function readDestinationRef(props: Record<string, unknown>): string | null {
  const nested = isRecord(props.surfaceInput) ? props.surfaceInput : {};
  const value =
    props.destinationRef ?? props.destination_ref ??
    nested.destinationRef ?? nested.destination_ref;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readViewerRef(props: Record<string, unknown>): string | null {
  const value = props.viewerRef ?? props.viewer_ref;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export default function mount({ el, props = {} }: ReactMaterialMountArgs) {
  return mountReactMaterial(
    el,
    <DestinationView
      destinationRef={readDestinationRef(props)}
      viewerRef={readViewerRef(props)}
      onRetry={() => window.location.reload()}
    />,
    props,
    'destination material',
  );
}
