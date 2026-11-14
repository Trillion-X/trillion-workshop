// packages/file-content-renderer/show/mount-file-content-surface.tsx
//
// Surface adapter: mounts the generic FileContentRenderer viewer from a
// placeable-surface's `surface_input`. The host forwards a surface's
// `surface_input` as `props.surfaceInput`, but FileContentRenderer reads
// `content`/`artifactRef`/`filePath` as top-level props. This thin wrapper
// bridges the two so a render_surface descriptor can carry the content.
//
// Uses `mountReactSurface` (not a raw component export) so the surface's React
// render and its hooks use the SAME entry-bundled React (FileContentRenderer
// uses useMemo internally) — the same reason mount-access-scoped-content exists.

import React from 'react';
import { ErrorBoundary, FloatingMaterialFrame, mountReactSurface } from '../../ui/index.ts';
import { FileContentRenderer } from './FileContentRenderer.tsx';

type MountArgs = { el: HTMLElement; props?: Record<string, unknown> };

function FileContentMaterial({ props }: { props: Record<string, unknown> }) {
  const surfaceInput = (props.surfaceInput ?? props.surface_input ?? {}) as Record<string, unknown>;
  const content = typeof surfaceInput.content === 'string' ? surfaceInput.content : '';
  const artifactRef = (surfaceInput.artifactRef ?? surfaceInput.artifact_ref) as
    | { media_type?: string; display_name?: string; byte_length?: number }
    | undefined;
  const filePath = typeof surfaceInput.filePath === 'string' ? surfaceInput.filePath : undefined;
  return (
    <FloatingMaterialFrame frame={props.floating_frame}>
      <ErrorBoundary zoneName="file-content-surface material">
        <FileContentRenderer content={content} artifactRef={artifactRef} filePath={filePath} />
      </ErrorBoundary>
    </FloatingMaterialFrame>
  );
}

export default function mount({ el, props = {} }: MountArgs) {
  return mountReactSurface(el, <FileContentMaterial props={props} />);
}
