// packages/group/show/RotateHandle.tsx
//
// The free-rotation handle — a blind overlay (L090). Given exactly one selected
// item's world rect + its current rotation, it draws a small circular grip above
// the item's top edge with a thin stem (Figma/Canva/Miro canon), and reports a
// pointer-down on the grip so the board can begin a rotate gesture. It knows
// nothing about rotation math or persistence — the board owns the gesture; this
// only places the grip and forwards the press.
//
// Rendered INSIDE the world transform (like SelectionHud / SnapGuideLayer) so it
// tracks the item in world space; the stem length, grip radius, and stroke are
// scaled by `1/zoom` so the affordance stays a constant size on screen at any
// zoom. The grip + stem sit above the item's top-center and rotate WITH the item
// (offset rotated by θ about the center) so the handle always points "up" out of
// the rotated top edge. Raw SVG is the irreducible canvas-geometry primitive.

import React from 'react';

export interface RotateHandleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RotateHandleProps {
  /** The single selected item's world rect, or null to hide the handle. */
  rect: RotateHandleRect | null;
  /** The item's current rotation in degrees (0 when absent). */
  rotation: number;
  zoom: number;
  /** Pointer-down on the grip → begin the rotate gesture (client coords). */
  onRotateStart: (clientX: number, clientY: number, pointerId: number, target: HTMLElement | SVGElement) => void;
  /** Double-click the grip → set the item's rotation back to 0. When not provided,
   *  the grip simply has no double-click action. */
  onReset?: () => void;
}

function rot(vx: number, vy: number, rad: number): { x: number; y: number } {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: vx * c - vy * s, y: vx * s + vy * c };
}

export function RotateHandle({ rect, rotation, zoom, onRotateStart, onReset }: RotateHandleProps) {
  if (!rect) return null;
  const k = 1 / Math.max(zoom, 0.0001); // world units per screen pixel
  const stem = 22 * k; // how far above the top edge the grip floats
  const grip = 6 * k; // grip circle radius
  const theta = (rotation * Math.PI) / 180;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  // Local positions (before rotation): top-edge midpoint and the grip above it.
  const edge = rot(0, -rect.h / 2, theta);
  const knob = rot(0, -rect.h / 2 - stem, theta);
  const ex = cx + edge.x;
  const ey = cy + edge.y;
  const gx = cx + knob.x;
  const gy = cy + knob.y;
  return (
    <svg
      aria-hidden
      style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 1, overflow: 'visible', pointerEvents: 'none' }}
    >
      <line x1={ex} y1={ey} x2={gx} y2={gy} stroke="var(--accent, #2563eb)" strokeWidth={1.5 * k} />
      <circle
        cx={gx}
        cy={gy}
        r={grip}
        fill="var(--surface, #ffffff)"
        stroke="var(--accent, #2563eb)"
        strokeWidth={1.5 * k}
        style={{ pointerEvents: 'auto', cursor: 'grab' }}
        // The board's stage stops listening once a press starts here; we forward
        // the press and let the stage's pointer-move/up drive the rotation.
        onPointerDown={(e) => {
          e.stopPropagation();
          onRotateStart(e.clientX, e.clientY, e.pointerId, e.currentTarget);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onReset?.();
        }}
      />
    </svg>
  );
}
