// packages/group/show/SnapGuideLayer.tsx
//
// The alignment-guide overlay — a blind renderer for the snap primitive's output.
// It draws whatever `SnapGuide[]` it is handed as thin magenta lines (Figma/Framer
// canon); it knows nothing about "items" or what aligned (L090 self-describing data,
// generic handler). Lives INSIDE the world transform so guides pan/zoom with the
// board in world coordinates. Magenta (`#f24822`) is deliberately distinct from the
// indigo selection accent so a guide reads as "alignment", not "selection".
//
// Raw SVG is the irreducible primitive for canvas geometry (same justified exception
// as ConnectorLayer / the addressed-marks ink layer) — there is no `ui` vector line.

import React from 'react';
import type { SnapGuide } from './snap-guides.ts';

const SNAP_COLOR = '#f24822';

export interface SnapGuideLayerProps {
  guides: readonly SnapGuide[];
  /** Live zoom — the line is drawn at `1/zoom` world units so it stays 1px on screen. */
  zoom: number;
}

export function SnapGuideLayer({ guides, zoom }: SnapGuideLayerProps) {
  if (guides.length === 0) return null;
  const w = 1 / Math.max(zoom, 0.0001);
  return (
    <svg
      aria-hidden
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
    >
      {guides.map((g, i) =>
        g.orient === 'v' ? (
          <line key={i} x1={g.pos} y1={g.start} x2={g.pos} y2={g.end} stroke={SNAP_COLOR} strokeWidth={w} />
        ) : (
          <line key={i} x1={g.start} y1={g.pos} x2={g.end} y2={g.pos} stroke={SNAP_COLOR} strokeWidth={w} />
        ),
      )}
    </svg>
  );
}
