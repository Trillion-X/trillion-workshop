/** Manual zoom range for the tiled arrangement canvas. */
export const MIN_ARRANGEMENT_ZOOM = 0.05
export const MAX_ARRANGEMENT_ZOOM = 1.5
export const ARRANGEMENT_ZOOM_STEP = 0.1

export function clampArrangementZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(MIN_ARRANGEMENT_ZOOM, Math.min(MAX_ARRANGEMENT_ZOOM, value))
}

/**
 * Return the largest scale at which the complete arrangement fits in the
 * viewport, with a little breathing room around the edges. Fit never enlarges
 * a small arrangement above normal size; manual zoom can still go beyond it.
 */
export function calculateArrangementFitZoom(
  contentWidth: number,
  contentHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 24,
): number {
  if (
    !Number.isFinite(contentWidth) ||
    !Number.isFinite(contentHeight) ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    contentWidth <= 0 ||
    contentHeight <= 0 ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) return 1

  const inset = Math.max(0, Number.isFinite(padding) ? padding : 0)
  const availableWidth = Math.max(1, viewportWidth - inset * 2)
  const availableHeight = Math.max(1, viewportHeight - inset * 2)
  return clampArrangementZoom(Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight))
}
