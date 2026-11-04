// parts/screen-arrangement/read-data/pane-sizes.ts
//
// PURPOSE
//   How panes size and snap: the smallest a pane may be dragged to, the size its screen is still laid out at, how far
//   a cut edge fades, how much of a pane a new split takes, how long a pane added beside or below is, where a dragged edge snaps (points along or across the split, how close it must come, how softly it settles) and how far an arrow key moves an edge. Defaults are DATA in
//   ../pane-sizes.json; the person's own choice (workspace preference screen-arrangement.pane-sizes, kept by
//   ../show/use-pane-sizes.ts) wins key by key and is handed here, so geometry reads one current value without
//   reaching for records.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No number here is a size; every value comes from pane-sizes.json or the person.
//   2. snapPanePx is pure: the same request, stage and settings give the same answer.

import PANE_SIZES from '../pane-sizes.json' with { type: 'json' }

export type PaneSizes = {
  drag_minimum_px: number
  content_minimum_width_px: number
  content_minimum_height_px: number
  cut_fade_px: number
  new_pane_share_percent: number
  snap_on: boolean
  snap_within_px: number
  snap_points_percent: readonly string[]
  snap_ease_ms: number
  added_pane_width_px: number
  added_pane_height_px: number
  arrow_step_px: number
  arrow_big_step_px: number
}

/** The workspace preference holding the person's own pane sizes. */
export const PANE_SIZES_PREFERENCE = 'screen-arrangement.pane-sizes'
export const DEFAULT_PANE_SIZES: PaneSizes = PANE_SIZES.defaults
export const PANE_SIZE_SECTIONS = PANE_SIZES.sections

/** Defaults with the person's own values laid over them, each kept only when it has the default's type. */
export function readPaneSizes(own: unknown): PaneSizes {
  if (!own || typeof own !== 'object') return DEFAULT_PANE_SIZES
  const merged: Record<string, unknown> = { ...DEFAULT_PANE_SIZES }
  for (const [key, value] of Object.entries(own as Record<string, unknown>)) {
    const fallback = (DEFAULT_PANE_SIZES as Record<string, unknown>)[key]
    if (fallback === undefined) continue
    if (Array.isArray(fallback) ? Array.isArray(value) : typeof value === typeof fallback) merged[key] = value
  }
  return merged as PaneSizes
}

let current: PaneSizes = DEFAULT_PANE_SIZES

/** The pane sizes in force now (the person's, once their preference has been read). */
export function paneSizesNow(): PaneSizes {
  return current
}

export function setPaneSizesNow(next: PaneSizes): void {
  current = next
}

/** Where a dragged pane edge lands: the nearest snap point within reach, else where it was asked to go. */
export function snapPanePx(requestedPx: number, stagePx: number, sizes: PaneSizes = current): { px: number; snapped: boolean } {
  if (!sizes.snap_on || !(stagePx > 0)) return { px: requestedPx, snapped: false }
  let best: number | null = null
  for (const point of sizes.snap_points_percent) {
    const px = (Number(point) / 100) * stagePx
    if (!Number.isFinite(px)) continue
    if (Math.abs(px - requestedPx) <= sizes.snap_within_px && (best === null || Math.abs(px - requestedPx) < Math.abs(best - requestedPx))) best = px
  }
  return best === null ? { px: requestedPx, snapped: false } : { px: best, snapped: true }
}

/**
 * Where an arrow key moves a pane edge from `currentPx`: the next snap point that way while snapping is on (points
 * within a pixel of where it is are passed), else, and past the last point, one step (`big` with Shift held).
 */
export function arrowPanePx(currentPx: number, stagePx: number, direction: 1 | -1, big: boolean, sizes: PaneSizes = current): number {
  const step = big ? sizes.arrow_big_step_px : sizes.arrow_step_px
  if (sizes.snap_on && stagePx > 0 && !big) {
    const ahead = sizes.snap_points_percent
      .map((point) => (Number(point) / 100) * stagePx)
      .filter((px) => Number.isFinite(px) && (px - currentPx) * direction > 1)
      .sort((a, b) => (a - b) * direction)
    if (ahead.length) return ahead[0]
  }
  return currentPx + direction * step
}
