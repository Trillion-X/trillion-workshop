// packages/ui/show/canvas-surface/CanvasSurface.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The generic, world-space SURFACE layer for any 2D canvas: a background color
// plus an optional repeating tile (dots, grid lines, ruled lines, paper) that
// pans and scales WITH the camera, so the world feels physically continuous —
// the signature parallax of every serious node/board canvas.
//
// This is the generative primitive (L069) of which a dot-grid is just ONE
// configuration. A surface look is DATA: { color?, tile? }. Dots = a radial-
// gradient tile; a grid = two linear-gradient tiles; ruled = one; a plain mood
// = color with no tile. Adding a new look is a new DATA row in the consumer's
// catalog — ZERO new code here. `CanvasDotGrid` is now a thin call to this.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ZERO application vocabulary — a surface for ANY canvas. It never names a
//    "board", a "graph", or a specific pattern; meaning lives in the DATA tile.
// 2. pointer-events: none — the surface never intercepts canvas interaction.
// 3. Inline style is camera-derived geometry + caller-supplied opaque DATA —
//    the Physics-layer exception (same exemption CanvasDotGrid carried).
// 4. The tile `image` is an opaque CSS background-image string supplied as DATA;
//    this primitive is blind to whether it draws dots, a grid, or anything else.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import React from 'react';

/** A repeating background tile, defined as DATA by the caller's surface catalog.
 *  `image` is an opaque CSS `background-image` value (e.g. a radial- or linear-
 *  gradient). `size` is the tile edge in WORLD pixels at zoom 1 (it scales with
 *  the camera). `opacity` fades the tile (default 1). */
export interface CanvasSurfaceTile {
  readonly image: string;
  readonly size: number;
  readonly opacity?: number;
}

export interface CanvasSurfaceProps {
  /** Camera pan X in screen pixels. */
  readonly panX: number;
  /** Camera pan Y in screen pixels. */
  readonly panY: number;
  /** Camera zoom multiplier (1 = 100%). */
  readonly zoom: number;
  /** Solid surface color behind the tile (a token var or explicit color). Absent
   *  → transparent (the surface inherits whatever is behind it). */
  readonly color?: string;
  /** The repeating tile, or absent for a plain (untiled) surface. */
  readonly tile?: CanvasSurfaceTile;
}

/**
 * Renders one absolutely-positioned surface layer that tracks the camera. Place
 * as the FIRST child of the canvas container (below nodes and edges). When both
 * `color` and `tile` are absent it renders a transparent no-op layer.
 */
export const CanvasSurface: React.FC<CanvasSurfaceProps> = ({ panX, panY, zoom, color, tile }) => {
  const style: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
  };
  if (color) style.backgroundColor = color;
  if (tile) {
    // The tile lives on its own layer so its opacity never fades the surface color.
    const s = Math.max(4, tile.size * zoom);
    return (
      <div aria-hidden="true" data-canvas-surface="true" style={style}>
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            backgroundImage: tile.image,
            backgroundSize: `${s}px ${s}px`,
            backgroundPosition: `${panX % s}px ${panY % s}px`,
            opacity: tile.opacity ?? 1,
          }}
        />
      </div>
    );
  }
  return <div aria-hidden="true" data-canvas-surface="true" style={style} />;
};
