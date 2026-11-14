// packages/ui/show/crop-overlay/CropOverlay.tsx
//
// The image-crop affordance: a dimmed surround + a bright crop WINDOW with 8 resize
// handles, rendered in WORLD space over a single item so it tracks pan/zoom. The
// window is a normalized sub-rectangle (0..1) of the item box; dragging a handle
// resizes the window. Pure presentation + one pointer-down callback per handle and a
// Done callback — all crop math lives in the consumer's geometry leaf (crop-rect).
// Mirrors SelectionBoundsOverlay (same handle set, counter-scaled by 1/zoom so handles
// stay a constant on-screen size). Zero domain vocabulary — any canvas can crop.

import React from 'react';

/** An axis-aligned rectangle in the world/transform coordinate space. */
export interface CropOverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A normalized crop window (0..1 fractions of the item box). */
export interface CropOverlayWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The 8 crop handles: 4 corners (2-axis) + 4 edge midpoints (1-axis). */
export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export interface CropOverlayProps {
  /** The item's world rect (the crop window is a fraction of this). */
  item: CropOverlayRect;
  /** The current crop window in 0..1 fractions of `item`. */
  crop: CropOverlayWindow;
  zoom: number;
  onHandleDown: (e: React.PointerEvent, handle: CropHandle) => void;
  /** Apply & leave crop mode (Done button / click the window interior). */
  onDone: () => void;
}

/** Constant on-screen handle size (world px = HANDLE_PX / zoom). */
const HANDLE_PX = 12;

const CURSOR: Record<CropHandle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

/** Handle centre as a fraction of the crop WINDOW (0..1 on each axis). */
const FRACTION: Record<CropHandle, { fx: number; fy: number }> = {
  nw: { fx: 0, fy: 0 }, n: { fx: 0.5, fy: 0 }, ne: { fx: 1, fy: 0 },
  e: { fx: 1, fy: 0.5 }, se: { fx: 1, fy: 1 }, s: { fx: 0.5, fy: 1 },
  sw: { fx: 0, fy: 1 }, w: { fx: 0, fy: 0.5 },
};

const HANDLES = Object.keys(FRACTION) as CropHandle[];

export function CropOverlay({ item, crop, zoom, onHandleDown, onDone }: CropOverlayProps) {
  const z = zoom || 1;
  const handleSize = HANDLE_PX / z;
  const border = 1.5 / z;
  // Crop window in item-local px.
  const winLeft = crop.x * item.w;
  const winTop = crop.y * item.h;
  const winW = crop.w * item.w;
  const winH = crop.h * item.h;
  return (
    <div
      aria-hidden
      style={{ position: 'absolute', left: item.x, top: item.y, width: item.w, height: item.h, pointerEvents: 'none', zIndex: 6, overflow: 'hidden' }}
    >
      {/* The crop WINDOW: a bright outline; its huge spread box-shadow (clipped to the
          item by the parent's overflow:hidden) dims everything OUTSIDE the window. */}
      <div
        onPointerDown={(e) => { e.stopPropagation(); }}
        onDoubleClick={(e) => { e.stopPropagation(); onDone(); }}
        style={{
          position: 'absolute',
          left: winLeft, top: winTop, width: winW, height: winH,
          border: `${border}px solid #fff`,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          boxSizing: 'border-box',
          pointerEvents: 'auto',
          cursor: 'move',
        }}
      />
      {HANDLES.map((h) => {
        const { fx, fy } = FRACTION[h];
        return (
          <div
            key={h}
            data-crop-handle={h}
            onPointerDown={(e) => onHandleDown(e, h)}
            style={{
              position: 'absolute',
              left: winLeft + fx * winW,
              top: winTop + fy * winH,
              width: handleSize, height: handleSize,
              transform: 'translate(-50%, -50%)',
              background: '#fff',
              border: `${border}px solid var(--accent-primary)`,
              borderRadius: handleSize * 0.2,
              boxSizing: 'border-box',
              pointerEvents: 'auto',
              cursor: CURSOR[h],
              zIndex: 7,
            }}
          />
        );
      })}
      {/* Done — commit & exit crop mode. Pinned to the window's bottom-right, counter-
          scaled so it stays legible at any zoom. */}
      <button
        type="button"
        data-crop-done
        onPointerDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.stopPropagation(); onDone(); }}
        style={{
          position: 'absolute',
          left: winLeft + winW,
          top: winTop + winH + 6 / z,
          transform: `scale(${1 / z})`,
          transformOrigin: 'top right',
          padding: '4px 10px',
          background: 'var(--accent-primary)',
          color: 'var(--accent-on, #fff)',
          border: 'none',
          borderRadius: 6,
          fontSize: 12,
          fontWeight: 600,
          pointerEvents: 'auto',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Done
      </button>
    </div>
  );
}
