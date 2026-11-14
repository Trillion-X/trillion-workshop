// packages/ui/show/selection-bounds/SelectionBoundsOverlay.tsx
//
// The multi-select bounding box + 8 resize handles — a generic canvas affordance
// rendered in WORLD space inside the canvas transform so it tracks pan/zoom with
// the items. Handles are counter-scaled by 1/zoom so they stay a constant
// on-screen size. Grounded in Mobbin design-canvas references (Figma / Excalidraw
// / Canva multi-select): a thin accent rect + small square corner handles + edge-
// midpoint handles.
//
// PURE presentation + a pointer-down callback per handle. All scale/anchor math
// lives in the consumer's geometry leaf — this component knows only a rect, a
// zoom, and 8 named handle positions. Any canvas (vision board, workflow canvas)
// can use it; it owns no domain vocabulary.

import React from 'react';

/** An axis-aligned rectangle in the world/transform coordinate space. */
export interface BoundsRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The 8 resize handles: 4 corners (2-axis) + 4 edge midpoints (1-axis). */
export type BoundsHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface SelectionBoundsOverlayProps {
  bounds: BoundsRect;
  zoom: number;
  onHandleDown: (e: React.PointerEvent, handle: BoundsHandle) => void;
}

/** Constant on-screen handle size (world px = HANDLE_PX / zoom). */
const HANDLE_PX = 10;

const CURSOR: Record<BoundsHandle, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
};

/** Handle center as a fraction of the bounds (0..1 on each axis). */
const FRACTION: Record<BoundsHandle, { fx: number; fy: number }> = {
  nw: { fx: 0, fy: 0 },
  n: { fx: 0.5, fy: 0 },
  ne: { fx: 1, fy: 0 },
  e: { fx: 1, fy: 0.5 },
  se: { fx: 1, fy: 1 },
  s: { fx: 0.5, fy: 1 },
  sw: { fx: 0, fy: 1 },
  w: { fx: 0, fy: 0.5 },
};

const HANDLES = Object.keys(FRACTION) as BoundsHandle[];

export function SelectionBoundsOverlay({ bounds, zoom, onHandleDown }: SelectionBoundsOverlayProps) {
  const handleSize = HANDLE_PX / (zoom || 1);
  const border = 1.5 / (zoom || 1);
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        left: bounds.x,
        top: bounds.y,
        width: bounds.w,
        height: bounds.h,
        pointerEvents: 'none',
        zIndex: 3,
      }}
    >
      {/* The bounding rectangle (thin accent, like Figma's multi-select frame). */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          border: `${border}px solid var(--accent-primary)`,
          boxSizing: 'border-box',
        }}
      />
      {HANDLES.map((h) => {
        const { fx, fy } = FRACTION[h];
        return (
          <div
            key={h}
            data-group-resize-handle={h}
            onPointerDown={(e) => onHandleDown(e, h)}
            style={{
              position: 'absolute',
              left: `${fx * 100}%`,
              top: `${fy * 100}%`,
              width: handleSize,
              height: handleSize,
              transform: 'translate(-50%, -50%)',
              background: 'var(--surface-raised, #fff)',
              border: `${border}px solid var(--accent-primary)`,
              borderRadius: handleSize * 0.2,
              boxSizing: 'border-box',
              pointerEvents: 'auto',
              cursor: CURSOR[h],
              zIndex: 4,
            }}
          />
        );
      })}
    </div>
  );
}
