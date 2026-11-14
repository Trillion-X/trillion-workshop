// packages/ui/show/canvas-dot-grid/CanvasDotGrid.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Generic world-space dot-grid background for any 2D canvas surface. The dots
// pan and scale with the camera so the world feels physically continuous —
// the signature affordance of serious node canvases (every spatial tool from
// design canvases to automation builders uses it for motion parallax).
//
// Pure Physics: camera numbers in, a positioned background layer out. Zero
// domain vocabulary. Token-driven color.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO application vocabulary — this is a background for ANY canvas.
// 2. pointer-events: none — the grid never intercepts canvas interaction.
// 3. Color comes from a design token (var(--border-primary)) only.
// 4. Inline style is camera-derived geometry — the Physics-layer exception.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';
import { CanvasSurface } from '../canvas-surface/CanvasSurface';

export interface CanvasDotGridProps {
  /** Camera pan X in screen pixels. */
  panX: number;
  /** Camera pan Y in screen pixels. */
  panY: number;
  /** Camera zoom multiplier (1 = 100%). */
  zoom: number;
  /** World-space spacing between dots in pixels (default 24). */
  spacing?: number;
  /** Dot radius in screen pixels at zoom 1 (default 1). */
  dotSize?: number;
}

/**
 * Renders an absolutely-positioned dot-grid layer that tracks the camera. Place
 * as the FIRST child of the canvas container (below nodes and edges).
 *
 * A dot grid is ONE configuration of {@link CanvasSurface}: the radial-gradient
 * dot tile. This component is now that single DATA row — the generic surface
 * primitive does the camera-tracking geometry.
 */
export const CanvasDotGrid: React.FC<CanvasDotGridProps> = ({
  panX,
  panY,
  zoom,
  spacing = 24,
  dotSize = 1,
}) => {
  const radius = Math.max(0.5, Math.min(1.6, dotSize * zoom));
  return (
    <CanvasSurface
      panX={panX}
      panY={panY}
      zoom={zoom}
      tile={{
        image: `radial-gradient(circle, var(--border-primary) ${radius}px, transparent ${radius}px)`,
        size: spacing,
        opacity: 0.5,
      }}
    />
  );
};
