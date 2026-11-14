// packages/ui/show/canvas-shape/CanvasShape.tsx
//
// A bbox-FILLING geometric shape primitive for canvas items. Renders a caller-
// supplied SVG path (authored in a 0..100 percent viewBox) non-uniformly scaled to
// fill the whole parent box, with `children` (e.g. a label) centred on top.
//
// WHY (#213): a canvas "shape" used to be a CSS `clip-path` applied to content that
// did not fill the box — so a circle clipped whatever partial-height content existed
// and rendered as a "dome". This primitive makes the shape a FILLING path: it always
// spans the box, so a circle is a full circle. It is the live twin of the SVG export
// path (same geometry → live == export).
//
// BLIND / GENERIC (L090): this component never knows WHAT shape it draws — the `path`
// is opaque DATA supplied by the caller's shape catalog. Adding a shape is a new DATA
// row in that catalog; this renderer is unchanged. `preserveAspectRatio="none"` +
// `vector-effect="non-scaling-stroke"` keep the fill box-filling and the border crisp
// under the non-uniform scale.

import React from 'react';
import type { TuningShadow } from '../tuning-panel/TuningFields';

export interface CanvasShapeProps {
  /** The bbox-filling SVG path `d`, authored in a 0..100 percent viewBox. */
  readonly path: string;
  /** Fill color (any CSS color / token). Absent → a neutral surface token. */
  readonly fill?: string;
  /** Stroke color. Absent → a neutral strong-border token. */
  readonly stroke?: string;
  /** Stroke width in CSS px (kept crisp via non-scaling-stroke). Default 1. */
  readonly strokeWidth?: number;
  /** A shadow that follows the shape's own outline (x, y, blur, spread, colour, opacity in CSS px). Absent or null → none. */
  readonly shadow?: TuningShadow | null;
  /** Content rendered centred ON TOP of the shape (e.g. the item's label). */
  readonly children?: React.ReactNode;
}

/** The shape once more beneath it in the shadow's colour: grown by its spread (a non-scaling stroke), moved by x and y,
 *  softened by its blur, so a circle's shadow is a circle. */
function ShapeShadow({ path, shadow }: { path: string; shadow: TuningShadow }) {
  if (!(shadow.opacity > 0)) return null;
  return (
    <svg
      aria-hidden="true"
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      data-canvas-shape-shadow=""
      style={{
        position: 'absolute',
        inset: 0,
        display: 'block',
        overflow: 'visible',
        transform: `translate(${shadow.x}px, ${shadow.y}px)`,
        filter: shadow.blur > 0 ? `blur(${shadow.blur / 2}px)` : undefined,
        opacity: Math.min(1, shadow.opacity),
      }}
    >
      <path d={path} fill={shadow.colour} stroke={shadow.colour} strokeWidth={Math.max(0, shadow.spread) * 2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Renders `path` as a box-filling SVG shape with centred `children` on top. */
export const CanvasShape: React.FC<CanvasShapeProps> = ({
  path,
  fill,
  stroke,
  strokeWidth = 1,
  shadow,
  children,
}) => (
  <div style={{ position: 'relative', width: '100%', height: '100%' }}>
    {shadow ? <ShapeShadow path={path} shadow={shadow} /> : null}
    <svg
      aria-hidden="true"
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: 'absolute', inset: 0, display: 'block' }}
    >
      <path
        d={path}
        fill={fill ?? 'var(--surface-secondary)'}
        stroke={stroke ?? 'var(--border-primary)'}
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  </div>
);
