// tools/turn-frames-into-slides/read-data/board-svg-transforms.ts
//
// The board EXPORT's item-transform facets — pure, zero I/O. The live canvas applies
// four self-describing `extra.*` visual facets that the SVG/PNG export must reproduce
// so the exported artifact matches what is on screen (the "live == export" contract that
// #168/#169/#197/#213 established for ink/frame/thickness/shape):
//   * `extra.rotation` (deg, about item center) + `extra.flipX`/`extra.flipY`  → a <g> transform
//   * `extra.crop {x,y,w,h}` (0..1)                                             → an enlarged <image> rect
//   * `extra.imageFilter` (a validated CSS filter string)                       → a style filter
// These leaves own only the MATH (matching the live math exactly); `board-svg.ts` reads
// them into its blind facet loop. Reusing `crop-rect.ts` (`isCrop`/`isFullCrop`) keeps the
// full-crop epsilon a single source of truth with the live crop.

import { isCrop, isFullCrop, type Crop } from './crop-rect.ts';
import { finiteCoord } from './finite-coord.ts';

/** An item viewed for export: its world-space rect + self-describing `extra` bag. */
interface ItemBox {
  x: number;
  y: number;
  w: number;
  h: number;
  extra?: Record<string, unknown> | undefined;
}

/**
 * SVG `transform` for one item's `<g>`, reproducing the LIVE `CanvasNode` order
 * (`translate → rotate → scale`, transform-origin = center; `CanvasNode.tsx:227`).
 * Expressed about the item's world-space center `(cx,cy)`:
 *   `rotate(θ cx cy) translate(cx cy) scale(sx sy) translate(-cx -cy)`
 * `rotate` is the OUTER matrix (applied last to points) and the center-scale is INNER
 * (applied first) — matching CSS right-to-left (flip first in the node's local frame,
 * then rotation). Returns `''` for the identity (no rotation, no flip) so every item
 * without these facets exports byte-identically to today (zero-diff guarantee).
 */
export function svgItemTransform(item: ItemBox): string {
  const rot =
    typeof item.extra?.rotation === 'number' && Number.isFinite(item.extra.rotation)
      ? (item.extra.rotation as number)
      : 0;
  const flipX = item.extra?.flipX === true;
  const flipY = item.extra?.flipY === true;
  if (!rot && !flipX && !flipY) return '';
  // Sanitize the rect: a persisted/producer-written non-finite or finite-huge (overflow) x/w would
  // put `Infinity`/`NaN` into `rotate(θ cx cy)` -> INVALID SVG that breaks the whole export. finiteCoord
  // is a no-op for real geometry. (readItems preserves raw persisted geometry, so this is the boundary.)
  const cx = finiteCoord(item.x) + finiteCoord(item.w) / 2;
  const cy = finiteCoord(item.y) + finiteCoord(item.h) / 2;
  const parts: string[] = [];
  if (rot) parts.push(`rotate(${rot} ${cx} ${cy})`);
  if (flipX || flipY) {
    const sx = flipX ? -1 : 1;
    const sy = flipY ? -1 : 1;
    parts.push(`translate(${cx} ${cy}) scale(${sx} ${sy}) translate(${-cx} ${-cy})`);
  }
  return parts.join(' ');
}

/**
 * Enlarged `<image>` rect that, once clipped to the item rect, shows only `crop` of the
 * source — the SVG equivalent of the live `cropImageStyle` (image sized to `1/w × 1/h`,
 * offset by `-x/w × -y/h`). The `<image>` keeps `preserveAspectRatio="xMidYMid slice"` so
 * it covers its (enlarged) box before the clip. Absent / invalid / full crop → the plain
 * item rect (today's behavior — so an uncropped image is byte-identical).
 */
export function svgCropImageRect(
  extraCrop: unknown,
  ix: number,
  iy: number,
  iw: number,
  ih: number,
): { x: number; y: number; w: number; h: number } {
  // Sanitize the item rect: a non-finite / finite-huge iw/ih would divide through into an
  // `Infinity`/`NaN` <image> rect (finiteCoord is a no-op for real geometry). `c.w`/`c.h` are > 0
  // and finite (isCrop guarantees it), so the crop division itself is always finite.
  const x = finiteCoord(ix);
  const y = finiteCoord(iy);
  const w = finiteCoord(iw);
  const h = finiteCoord(ih);
  if (!isCrop(extraCrop) || isFullCrop(extraCrop as Crop)) return { x, y, w, h };
  const c = extraCrop as Crop;
  return {
    x: x - (c.x / c.w) * w,
    y: y - (c.y / c.h) * h,
    w: w / c.w,
    h: h / c.h,
  };
}

/**
 * The item's CSS image filter (e.g. `"saturate(1.4) contrast(1.1)"`), or `''` when absent.
 * Read guard only — #117 stored a validated CSS filter string; browsers apply CSS filter
 * functions when rasterizing SVG, so the same string yields the same pixels live and in the PNG.
 */
export function svgImageFilter(item: ItemBox): string {
  const f = item.extra?.imageFilter;
  return typeof f === 'string' && f.trim() !== '' ? f : '';
}
