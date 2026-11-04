// packages/group/show/image-footprint.ts
//
// The aspect-preserving placement footprint for an image (#215, pure leaf, zero I/O).
// A picked/dropped/pasted image used to land at the board's default note size
// (220×160), squishing a portrait photo into a landscape box. This composes the
// #214 draft-footprint primitive: given an image's natural pixel size, it returns
// the world-unit `w`/`h` a draft should carry so the placed node matches the
// image's real aspect ratio, capped so a huge photo doesn't dominate the canvas.
// The measuring (decode the bytes) is injected DOM I/O; THIS is the pure math.

export interface ImageFootprintOptions {
  /** Longest placed edge in world units (the cap). Default 480. */
  readonly maxLong?: number;
  /** Shortest placed edge floor in world units (keeps a thin pano usable). Default 80. */
  readonly minShort?: number;
}

/**
 * The world-unit footprint for an image of natural size `natW×natH`, preserving
 * aspect ratio with the long edge capped at `maxLong`. Returns null for a
 * non-positive/degenerate size so the caller falls back to the item default.
 */
export function imageFootprint(
  natW: number,
  natH: number,
  options: ImageFootprintOptions = {},
): { w: number; h: number } | null {
  if (!(natW > 0) || !(natH > 0) || !Number.isFinite(natW) || !Number.isFinite(natH)) return null;
  const maxLong = options.maxLong ?? 480;
  const minShort = options.minShort ?? 80;
  const scale = maxLong / Math.max(natW, natH); // scale the long edge TO maxLong (up or down — the canvas-legibility target)
  // Floor the SHORT edge so an extreme aspect (thin panorama / tall strip) stays grabbable. Scale BOTH
  // edges by the SAME factor `k` (aspect-preserving) using the UNROUNDED projected short edge as the
  // divisor. The old code divided by the ALREADY-ROUNDED short edge, which for an extreme aspect (e.g.
  // 1×1_000_000) rounds to 0 → `minShort / 0 === Infinity` → a non-finite footprint from a representable
  // (untrusted, decoded) image size. `shortProj > 0` (natW,natH > 0, scale > 0) → `k` is always finite.
  const shortProj = Math.min(natW, natH) * scale;
  const k = shortProj < minShort ? minShort / shortProj : 1;
  return { w: Math.round(natW * scale * k), h: Math.round(natH * scale * k) };
}
