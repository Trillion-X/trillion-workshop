// packages/addressed-marks/read-data/marks-to-svg.ts
//
// PURE ink → SVG export serializer, OWNED by addressed-marks (the package that owns the
// ink representation). Consumers (e.g. the board export) compose the returned fragment as
// an OPAQUE overlay without knowing stroke structure — the decoupling contract: the board
// never imports addressed-marks internals, it only receives this fragment + bounds.
//
// The geometry + style here MATCH the on-screen render (show/AddressedMarkLayer.tsx
// `pathData`/`strokeFor`/`strokeWidthFor`) byte-for-byte so the export looks identical to
// the canvas: `M x0 y0 L x1 y1 …` (+ ` Z` when closed), round caps, the style's
// stroke/width/opacity. `point.values[0]` = x, `values[1]` = y, in the SAME world frame
// the marks were drawn in (so a board export needs no transform).

import type { MarkMaterial, MarkCoordinatePoint, MarkStyleRecord } from './addressed-marks';

export interface MarksSvgBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface MarksSvgResult {
  /** SVG fragment (zero or more `<path>` stroke elements). Empty string when no ink. */
  readonly svg: string;
  /** World-space bounds of all ink, or null when there is no ink to frame. */
  readonly bounds: MarksSvgBounds | null;
}

export interface MarksToSvgOptions {
  /** Fallback stroke when a style carries only a design TOKEN (CSS `var()` cannot resolve
   *  in a standalone exported SVG) or no colour at all. Default neutral ink. */
  readonly defaultStroke?: string;
}

const X = 0;
const Y = 1;

function px(point: MarkCoordinatePoint, axis: number): number {
  const v = point.values[axis];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Same `M/L … Z` builder the on-screen MarkPath uses (show/AddressedMarkLayer `pathData`). */
function pathData(points: readonly MarkCoordinatePoint[], closed?: boolean): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${px(point, X)} ${px(point, Y)}`)
    .join(' ')
    .concat(closed ? ' Z' : '');
}

/** The export stroke colour: the concrete style colour, else the default (a CSS-var token
 *  cannot resolve in a standalone SVG, so it falls back rather than emit a broken `var()`). */
function strokeFor(style: MarkStyleRecord | null | undefined, fallback: string): string {
  return style?.stroke && style.stroke.length > 0 ? style.stroke : fallback;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialize a resolved `MarkMaterial` (from `materializeMarkRecords`) into an SVG stroke
 * fragment + its world-space bounds. Stroke-only (pen/shape outlines) — decoration fills are
 * a future enhancement. Hidden/erased paths are already excluded by the material builder.
 */
export function marksToSvg(material: MarkMaterial, opts: MarksToSvgOptions = {}): MarksSvgResult {
  const fallback = opts.defaultStroke ?? '#1a1a1a';
  const parts: string[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const path of material.paths) {
    const points = path.coordinateSet.points;
    if (points.length === 0) continue;
    const d = pathData(points, path.coordinateSet.closed);
    const stroke = strokeFor(path.style, fallback);
    const strokeWidth = path.style?.strokeWidth ?? 3;
    const strokeOpacity = path.style?.strokeOpacity ?? 1;
    parts.push(
      `<path d="${escapeAttr(d)}" fill="none" stroke="${escapeAttr(stroke)}" ` +
        `stroke-width="${strokeWidth}" stroke-opacity="${strokeOpacity}" ` +
        `stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`,
    );
    for (const point of points) {
      const x = px(point, X);
      const y = px(point, Y);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  const bounds = minX === Infinity ? null : { minX, minY, maxX, maxY };
  return { svg: parts.join(''), bounds };
}
