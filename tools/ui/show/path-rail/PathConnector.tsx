// packages/ui/show/path-rail/PathConnector.tsx
//
// One connector rule threading two adjacent winding-path nodes (the Duolingo /
// Headspace-journey "dashed line between milestones" anatomy). It occupies the
// vertical gap between the nodes and draws a single rotated rule from the upper
// node's horizontal center to the lower node's center, so the column reads as a
// continuous threaded path rather than free-floating coins.
//
// Pure presentation — it paints an already-resolved segment (geometry) with an
// already-resolved look (color + dashed). It decides NO status: whether a
// segment is "traversed" (solid, toned) or "upcoming" (dashed, muted) is chosen
// upstream from node status, so this layer carries no status enum (L090). The
// rotated-rule transform is dynamic geometry — the sanctioned inline-style
// exception shared with ScoreRing / PathNode, not feature-code styling.

import * as React from 'react';

import type { ConnectorSegment } from './path-rail-geometry';

export interface PathConnectorProps {
  segment: ConnectorSegment;
  /** Vertical span (px) the connector occupies — the node stack's gap. */
  gap: number;
  /** Rule thickness in px. Default 3. */
  thickness?: number;
  /** Resolved stroke color (CSS var or hex). */
  color: string;
  /** Dashed (upcoming) vs solid (traversed). */
  dashed?: boolean;
}

export function PathConnector({ segment, gap, thickness = 3, color, dashed }: PathConnectorProps) {
  const { length, angleDeg, fromX, toX } = segment;
  const midX = (fromX + toX) / 2;

  return (
    <div aria-hidden style={{ position: 'relative', width: '100%', height: gap, pointerEvents: 'none' }}>
      <div
        data-test="path-connector"
        data-state={dashed ? 'upcoming' : 'traversed'}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: length,
          height: 0,
          borderTop: `${thickness}px ${dashed ? 'dashed' : 'solid'} ${color}`,
          transform: `translate(-50%, -50%) translateX(${midX}px) rotate(${angleDeg}deg)`,
          transformOrigin: 'center',
          opacity: dashed ? 0.55 : 0.95,
          borderRadius: '9999px',
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
