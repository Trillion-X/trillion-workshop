// packages/screen-arrangement/show/mark-targets.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// SSOT for the addressed-mark targets screen-arrangement exposes, and the
// pointer-space resolver the MarkInputLayer consumes. Screen-arrangement owns
// its own space geometry (tab panel rects, the canvas world camera, the
// arrangement frame); the addressed-marks package owns ink. This file is the
// translation boundary between the two (L098).
//
// Target identity is exact: markTargetKey() stable-JSONs the whole target, so
// the input layer and every display overlay MUST build targets through these
// helpers — never inline target literals (SSOT).
//
// Resolution order (topmost space wins):
//   1. the tab panel under the pointer (tile container, canvas window, PIP
//      box, and the maximized focus pane all render tab panels)
//   2. the canvas world (canvas mode — coordinates in world px, marks pan and
//      zoom with the camera)
//   3. the arrangement frame (grid mode — normalized to the arrangement root)
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Target addresses are screen-arrangement vocabulary (Society data in
//    records); no other package's vocabulary appears here
// 2. Coordinates are never clamped — ink may extend past a space's bounds
// 3. The resolver answers from live DOM geometry + camera, not cached rects
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { type SurfaceMode, baseGeometryForSurface } from '../read-data/surface-modes'
import type { MarkTarget } from '../../addressed-marks/read-data/addressed-marks'
import type { MarkPointerSpace } from '../../addressed-marks/show/MarkInputLayer'
import { hideMarks, showStrokes, type ShownStroke } from '../../addressed-marks/show/shown-marks'

/** Marks addressed to one tab's content, normalized 0..1 across its panel. */
export function markTargetForTab(tabId: string): MarkTarget {
  return {
    address: `screen-arrangement.tab:${tabId}`,
    frame: {
      id: 'content-normalized',
      axes: [{ id: 'u' }, { id: 'v' }],
    },
  }
}

/** Marks addressed to the canvas world, in world pixels (camera-independent). */
export function canvasWorldMarkTarget(): MarkTarget {
  return {
    address: 'screen-arrangement.canvas',
    frame: {
      id: 'world-2d',
      axes: [{ id: 'x', unit: 'px' }, { id: 'y', unit: 'px' }],
    },
  }
}

/** Marks addressed to the arrangement frame, normalized 0..1 across the root. */
export function frameMarkTarget(): MarkTarget {
  return {
    address: 'screen-arrangement.frame',
    frame: {
      id: 'frame-normalized',
      axes: [{ id: 'u' }, { id: 'v' }],
    },
  }
}

/** Marks addressed to the whole screen, normalized 0..1 across the window: over the sidebar, every pane and the
 *  gaps between them. */
export function screenMarkTarget(): MarkTarget {
  return {
    address: 'screen-arrangement.screen',
    frame: {
      id: 'screen-normalized',
      axes: [{ id: 'u' }, { id: 'v' }],
    },
  }
}

/** Marks shown over the whole screen and never kept (a tour's pointers and shapes): normalized 0..1 across the
 *  window like `screenMarkTarget`, drawn on their own layer above tours (LayoutEngine). */
export function shownOnScreenMarkTarget(): MarkTarget {
  return {
    address: 'screen-arrangement.shown',
    frame: {
      id: 'screen-normalized',
      axes: [{ id: 'u' }, { id: 'v' }],
    },
  }
}

/** Show strokes over the whole screen under `key` (points 0..1 of the window); `hideFromScreen(key)` takes them away. */
export function showOnScreen(key: string, strokes: readonly ShownStroke[]): void {
  showStrokes(key, shownOnScreenMarkTarget(), strokes)
}

/** Take away what `showOnScreen(key, ...)` showed. */
export const hideFromScreen = (key: string): void => hideMarks(key)

/** The mark area id for drawing over the whole screen; any other area draws in the space under the pointer. */
export const WHOLE_SCREEN_AREA = 'whole-screen'
/** The mark area id for drawing in the pane under the pointer. */
export const PANE_AREA = 'pane'

/** Every stroke over the whole screen goes to the screen target, measured against the window. */
export function resolveScreenPointerSpace(): MarkPointerSpace {
  const width = window.innerWidth || 1
  const height = window.innerHeight || 1
  return {
    target: screenMarkTarget(),
    toCoordinate: (x, y) => ({ values: [x / width, y / height] }),
    hitRadius: ERASE_HIT_RADIUS_PX / Math.min(width, height),
  }
}

const TAB_PANEL_SELECTOR = '[data-screen-arrangement-tab-panel]'
const ERASE_HIT_RADIUS_PX = 10

export interface ArrangementMarkGeometry {
  rootElement: () => HTMLElement | null
  surface: () => SurfaceMode
  camera: () => { scale: number; tx: number; ty: number }
}

/**
 * Build the MarkPointerSpace resolver for this arrangement. Pure DOM/camera
 * geometry — resolves the topmost addressed space under a client point.
 */
export function createArrangementPointerSpaceResolver(
  geometry: ArrangementMarkGeometry,
): (clientX: number, clientY: number) => MarkPointerSpace | null {
  return (clientX, clientY) => {
    const root = geometry.rootElement()
    if (!root) return null
    const rootRect = root.getBoundingClientRect()
    if (clientX < rootRect.left || clientX > rootRect.right || clientY < rootRect.top || clientY > rootRect.bottom) {
      return null
    }

    const stack = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(clientX, clientY)
      : []
    const panel = stack
      .map((element) => element.closest?.(TAB_PANEL_SELECTOR) ?? null)
      .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement && root.contains(candidate))
    if (panel) {
      const tabId = panel.getAttribute('data-tab-id')
      if (tabId) {
        const rect = panel.getBoundingClientRect()
        const width = rect.width || 1
        const height = rect.height || 1
        return {
          target: markTargetForTab(tabId),
          toCoordinate: (x, y) => ({ values: [(x - rect.left) / width, (y - rect.top) / height] }),
          hitRadius: ERASE_HIT_RADIUS_PX / Math.min(width, height),
        }
      }
    }

    if (baseGeometryForSurface(geometry.surface()) === 'floating') {
      const camera = geometry.camera()
      const zoom = camera.scale || 1
      return {
        target: canvasWorldMarkTarget(),
        toCoordinate: (x, y) => ({
          values: [
            (x - rootRect.left - camera.tx) / zoom,
            (y - rootRect.top - camera.ty) / zoom,
          ],
        }),
        hitRadius: ERASE_HIT_RADIUS_PX / zoom,
      }
    }

    const width = rootRect.width || 1
    const height = rootRect.height || 1
    return {
      target: frameMarkTarget(),
      toCoordinate: (x, y) => ({ values: [(x - rootRect.left) / width, (y - rootRect.top) / height] }),
      hitRadius: ERASE_HIT_RADIUS_PX / Math.min(width, height),
    }
  }
}
