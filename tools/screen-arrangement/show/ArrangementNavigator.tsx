// parts/screen-arrangement/show/ArrangementNavigator.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The pane map: a small drawing of where the panes of the arrangement on screen
// are, read from the rendered arrangement, with the part in view outlined. Each
// pane tile is its own handle: press it to bring it into view, grab it anywhere
// to move it (it follows the pointer and the place it will land shows dashed
// before release). Near a pane's left, right, top or bottom edge a dashed square
// shows the part a new pane would take there, and a press adds it on that side
// (left or right splits the row, top or bottom the column). The line between two
// panes drags to resize them. Drag empty map space to move the view, wheel to
// zoom (unless a show rule hides `arrangement.zoom.map`), and press the space around the panes to add one on that side of them
// all. Open over the work, the map closes from its X or Escape. Above it sits the mode
// switch (ArrangementSurfaceControl). In a sidebar it draws into the Arrangement
// section's map slot (ArrangementSection.tsx); from there Unpin moves it into the
// shared floating panel over the work, and closing that panel pins it back. A
// sidebar closed behind its Show sidebar button still holds the map: it is drawn
// when the sidebar opens, never over the work. Only a page with no sidebar at
// all floats it, once there are two panes, closed behind its own button in the
// window's bottom-left corner group (floating-occlusion/window-corner) until the
// person opens it.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. The map reads the rendered panes (`[data-container-id]` inside the
//    viewport's own `[data-arranger]`), so it draws Tiles and Canvas alike.
// 2. Moving the view defaults to scrolling the viewport; an arranger that moves
//    a camera instead hands in `moveView`, `zoom` and `onZoomChange`.
// 3. Adding beside a pane splits that pane on that side (splitContainer); adding
//    in the space around the panes adds a pane on that side of the tiled tree;
//    an arranger that places panes freely hands in `onAddAt`. Every change goes
//    through the layout owner's actions, and the map draws only shared parts
//    (Button, NamedIcon) with its look in screen-look (layout-picker.css).
// 4. Only the arrangement of the active layer draws a map.
// 5. Unpinned is one value for the whole window (not per navigator), so
//    switching Tiles and Canvas, which swaps the navigator drawing the map,
//    keeps the map floating. The panel comes from the shared opener seam; with
//    no opener there is no Unpin.
// 6. The map never covers work unless the person asked for it: with a sidebar
//    in any state (open, rail, closed behind its button) it stays in the
//    sidebar; floating, it starts closed and joins the window corner's group
//    like every control floating in a corner, so it never sits on another,
//    toasts stack above it and what scrolls beneath it ends with room for it.
//
// =============================================================================

'use client'

import * as React from 'react'
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of'
import { createPortal } from 'react-dom'
import { Button } from '../../ui/show/button'
import { NamedIcon } from '../../ui/show/icon'
import { canOpenFloatingPanel, openFloatingPanel } from '../../ui/show/floating-panel-opener'
import { InWindowCorner } from '../../ui/show/floating-occlusion/window-corner'
import { LayoutActionsContext, LayoutStateContext } from './screen-arrangement-context'
import { NestedArrangement } from './behind-the-panes'
import { chromeZoneVisible } from '../read-data/chrome-visibility'
import { MAX_ARRANGEMENT_ZOOM, MIN_ARRANGEMENT_ZOOM } from './arrangement-zoom'
import { edgeAtPanePoint, paneResizeTarget, resizedSplitSizes, type PaneMapEdge } from './arrangement-map-actions'
import ArrangementSurfaceControl from './ArrangementSurfaceControl'
import { draggablePaneMinimumPx } from './split-tree-constraints'

export type ArrangementNavigatorPane = {
  id: string
  left: number
  top: number
  width: number
  height: number
}

/** A point in the map's content space: viewport pixels, scroll included. */
export type ArrangementMapPoint = { x: number; y: number }

export type NavigatorSnapshot = {
  panes: ArrangementNavigatorPane[]
  /** Top-left of everything drawn (panes and the part in view). */
  originX: number
  originY: number
  contentWidth: number
  contentHeight: number
  viewportWidth: number
  viewportHeight: number
  scrollLeft: number
  scrollTop: number
}

const MAP_WIDTH = 320
const MAP_HEIGHT = 192
const MAP_INSET = 12
// Tallest and shortest the floating map may grow, in pixels.
const MAP_TALLEST = 560
const MAP_SHORTEST = 280
const MAP_SHORTEST_DRAWING = 72
// In the sidebar the map is a minimap: a glance at where the panes are, never taller than a few rows of the list.
const MAP_SIDEBAR_TALLEST = 112
const WHEEL_ZOOM_SENSITIVITY = 0.001
/** The control a show rule hides to turn off zooming the panes from the map's wheel (controls.json). */
export const MAP_ZOOM_CONTROL = 'arrangement.zoom.map'
// The unpinned panel's starting size; the person's own size is remembered per kind.
const PANEL_KIND = 'arrangement-pane-map'
const PANEL_SIZE = { w: MAP_WIDTH + 32, h: MAP_SHORTEST }
// A sidebar in any state: its sections when open or a rail, its Show sidebar button when closed over narrow work.
const SIDEBAR_ON_PAGE = '[data-sidebar-section-id], [data-sidebar-open-toggle]'

// Whether the person unpinned the pane map (invariant 5).
let mapUnpinned = false
const unpinnedListeners = new Set<() => void>()
function setMapUnpinned(next: boolean): void {
  if (mapUnpinned === next) return
  mapUnpinned = next
  for (const listener of unpinnedListeners) listener()
}
function subscribeMapUnpinned(listener: () => void): () => void {
  unpinnedListeners.add(listener)
  return () => { unpinnedListeners.delete(listener) }
}
function useMapUnpinned(): boolean {
  return React.useSyncExternalStore(subscribeMapUnpinned, () => mapUnpinned, () => false)
}

export function arrangementZoomForWheelDelta(zoom: number, deltaY: number, deltaMode = 0): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return zoom
  const pixelsPerUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1
  const delta = deltaY * pixelsPerUnit * WHEEL_ZOOM_SENSITIVITY
  return Math.max(MIN_ARRANGEMENT_ZOOM, Math.min(
    MAX_ARRANGEMENT_ZOOM,
    Math.round((zoom - delta) * 100) / 100,
  ))
}

function belongsToViewport(element: Element, viewport: HTMLElement): boolean {
  return element.closest('[data-arranger]') === (viewport.matches('[data-arranger]') ? viewport : null)
}

function viewportPanes(viewport: HTMLElement): HTMLElement[] {
  const ids = new Set<string>()
  return Array.from(viewport.querySelectorAll<HTMLElement>('[data-container-id]'))
    .filter((element) => {
      const id = element.dataset.containerId
      if (!id || ids.has(id) || !belongsToViewport(element, viewport)) return false
      ids.add(id)
      return true
    })
}

export function readArrangementNavigatorSnapshot(viewport: HTMLElement): NavigatorSnapshot {
  const viewportRect = viewport.getBoundingClientRect()
  const panes = viewportPanes(viewport)
    .flatMap((element) => {
      const id = element.dataset.containerId
      const rect = element.getBoundingClientRect()
      if (!id || rect.width <= 0 || rect.height <= 0) return []
      return [{
        id,
        left: rect.left - viewportRect.left - viewport.clientLeft + viewport.scrollLeft,
        top: rect.top - viewportRect.top - viewport.clientTop + viewport.scrollTop,
        width: rect.width,
        height: rect.height,
      }]
    })
  // The map describes pane placement plus the part in view. A page inside one
  // pane may have an arbitrarily long scroll body; including the viewport's
  // scroll extent would shrink every pane into a line, so only the visible
  // rectangle joins the panes. Canvas panes can sit left of or above it.
  const inView = { left: viewport.scrollLeft, top: viewport.scrollTop, width: viewport.clientWidth, height: viewport.clientHeight }
  const drawn = [...panes, inView]
  const originX = Math.min(...drawn.map((box) => box.left))
  const originY = Math.min(...drawn.map((box) => box.top))
  return {
    panes,
    originX,
    originY,
    contentWidth: Math.max(1, Math.max(...drawn.map((box) => box.left + box.width)) - originX),
    contentHeight: Math.max(1, Math.max(...drawn.map((box) => box.top + box.height)) - originY),
    viewportWidth: viewport.clientWidth,
    viewportHeight: viewport.clientHeight,
    scrollLeft: viewport.scrollLeft,
    scrollTop: viewport.scrollTop,
  }
}

export function arrangementNavigatorScrollBehavior(prefersReducedMotion: boolean): ScrollBehavior {
  return prefersReducedMotion ? 'instant' : 'smooth'
}

/** The pane under a content point, if any. */
export function paneAtPoint(panes: readonly ArrangementNavigatorPane[], point: ArrangementMapPoint): ArrangementNavigatorPane | null {
  return panes.find((pane) => point.x >= pane.left && point.x <= pane.left + pane.width
    && point.y >= pane.top && point.y <= pane.top + pane.height) ?? null
}

/** What a point on the pane map is over: the inside edge of a pane (a press adds a pane there), the rest of a pane,
 *  or the space around the panes (a press adds a pane on that side of them all). */
export type PaneMapHit =
  | { kind: 'add'; paneId: string; edge: PaneMapEdge }
  | { kind: 'pane'; paneId: string }
  | { kind: 'around'; edge: PaneMapEdge }
  | { kind: 'none' }

// How deep the band along a pane's inside edge that adds a pane is: this share of the pane, at most this many map pixels.
const ADD_BAND_SHARE = 0.3
const ADD_BAND_MOST = 28

/** The side of a drawn pane (map pixels) whose inside band a point is in, nearest first, or null in its middle. */
export function addEdgeInTile(tile: { x: number; y: number; w: number; h: number }, point: { x: number; y: number }): PaneMapEdge | null {
  const across = Math.min(tile.w * ADD_BAND_SHARE, ADD_BAND_MOST)
  const down = Math.min(tile.h * ADD_BAND_SHARE, ADD_BAND_MOST)
  const reach: Array<[PaneMapEdge, number]> = [
    ['left', (point.x - tile.x) / across],
    ['right', (tile.x + tile.w - point.x) / across],
    ['top', (point.y - tile.y) / down],
    ['bottom', (tile.y + tile.h - point.y) / down],
  ]
  const [edge, depth] = reach.reduce((best, next) => (next[1] < best[1] ? next : best))
  return depth < 1 ? edge : null
}

/** Which side of the panes a point lies on: where a new tiled pane goes. */
export function sideOfPanes(panes: readonly ArrangementNavigatorPane[], point: ArrangementMapPoint): { dir: 'row' | 'column'; position: 'before' | 'after' } {
  if (!panes.length) return { dir: 'row', position: 'after' }
  const left = Math.min(...panes.map((pane) => pane.left))
  const top = Math.min(...panes.map((pane) => pane.top))
  const right = Math.max(...panes.map((pane) => pane.left + pane.width))
  const bottom = Math.max(...panes.map((pane) => pane.top + pane.height))
  const sides = [
    { dir: 'row' as const, position: 'before' as const, reach: (left - point.x) / Math.max(1, right - left) },
    { dir: 'row' as const, position: 'after' as const, reach: (point.x - right) / Math.max(1, right - left) },
    { dir: 'column' as const, position: 'before' as const, reach: (top - point.y) / Math.max(1, bottom - top) },
    { dir: 'column' as const, position: 'after' as const, reach: (point.y - bottom) / Math.max(1, bottom - top) },
  ]
  const outward = sides.reduce((best, side) => (side.reach > best.reach ? side : best))
  return { dir: outward.dir, position: outward.position }
}

function paneLabel(index: number, total: number): string {
  return `Go to pane ${index + 1} of ${total}`
}

export function ArrangementNavigator({
  viewportRef,
  enabled = true,
  zoom = 1,
  onZoomChange,
  onPaneSelect,
  moveView,
  onAddAt,
  watch,
}: {
  viewportRef: React.RefObject<HTMLElement | null>
  enabled?: boolean
  zoom?: number
  onZoomChange?: (zoom: number) => void
  onPaneSelect?: (pane: ArrangementNavigatorPane) => void
  /** Move the part in view by this many viewport pixels (a camera arrangement); scrolling is the default. */
  moveView?: (delta: { x: number; y: number }) => void
  /** Add a pane at this content point (a free arrangement); a pane on that side of the tiled tree is the default. */
  onAddAt?: (point: ArrangementMapPoint, snapshot: NavigatorSnapshot) => void
  /** Redraw when this changes (a camera or window moved without the viewport scrolling). */
  watch?: unknown
}) {
  const [snapshot, setSnapshot] = React.useState<NavigatorSnapshot | null>(null)
  const [mapSize, setMapSize] = React.useState({ width: MAP_WIDTH, height: MAP_HEIGHT })
  // Held as state, not a ref: the map moves between hosts, and each move mounts
  // a new element that its listeners must follow.
  const [mapElement, setMapElement] = React.useState<HTMLDivElement | null>(null)
  const [mapPointer, setMapPointer] = React.useState<{ x: number; y: number } | null>(null)
  // On the line between two panes a press resizes, so no pane shows where an add would go.
  const [onResizeLine, setOnResizeLine] = React.useState(false)
  const mapDrag = React.useRef<{
    pointerId: number
    moved: boolean
    startedOnPane: boolean
    startX: number
    startY: number
    sourcePaneId?: string
    intent: 'navigate' | 'move' | 'resize'
    edge?: PaneMapEdge
  } | null>(null)
  const [expanded, setExpanded] = React.useState(true)
  // Floating with no sidebar, the map starts closed behind its button (invariant 6).
  const [floatingOpen, setFloatingOpen] = React.useState(false)
  const [selectedTargetContainerId, setSelectedTargetContainerId] = React.useState<string | null>(null)
  const [selectedTargetPosition, setSelectedTargetPosition] = React.useState<{ x: number; y: number } | null>(null)
  // The pane the keyboard is on, which offers a pane on each of its sides.
  const [focusedPaneId, setFocusedPaneId] = React.useState<string | null>(null)
  const [mapHost, setMapHost] = React.useState<HTMLElement | null>(null)
  // An arrangement inside a screen of another leaves the sidebar's map slot to the outermost one.
  const nested = React.useContext(NestedArrangement)
  const [sidebarPresent, setSidebarPresent] = React.useState(false)
  const [activeLayer, setActiveLayer] = React.useState(true)
  const unpinned = useMapUnpinned()
  const [panelBody, setPanelBody] = React.useState<HTMLElement | null>(null)
  useShowChange()
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const mapId = React.useId()
  const placementTargetId = selectedTargetContainerId
    && layoutState?.containers[selectedTargetContainerId]
    ? selectedTargetContainerId
    : layoutState?.focusedContainerId ?? null
  const updateRef = React.useRef<() => void>(() => {})

  React.useEffect(() => {
    const findHost = () => {
      setMapHost(nested ? null : document.querySelector<HTMLElement>('[data-arrangement-map-host]'))
      setSidebarPresent(!!document.querySelector(SIDEBAR_ON_PAGE))
      setActiveLayer(!viewportRef.current?.closest('[data-arrangement-layer]:not([data-active-layer])'))
    }
    findHost()
    const observer = new MutationObserver(findHost)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [viewportRef, nested])

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || !enabled) {
      setSnapshot(null)
      updateRef.current = () => {}
      return
    }

    let frame = 0
    const observedPanes = new Set<Element>()
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => setSnapshot(readArrangementNavigatorSnapshot(viewport)))
    }
    updateRef.current = update
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    const observeCurrentPanes = () => {
      if (!resizeObserver) return
      const currentPanes = new Set(viewportPanes(viewport))
      for (const pane of observedPanes) {
        if (!currentPanes.has(pane)) {
          resizeObserver.unobserve(pane)
          observedPanes.delete(pane)
        }
      }
      for (const pane of currentPanes) {
        if (!observedPanes.has(pane)) {
          resizeObserver.observe(pane)
          observedPanes.add(pane)
        }
      }
    }
    resizeObserver?.observe(viewport)
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => {
      observeCurrentPanes()
      update()
    })
    mutationObserver?.observe(viewport, { childList: true, subtree: true })
    observeCurrentPanes()
    viewport.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    update()

    return () => {
      cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [enabled, viewportRef])

  React.useEffect(() => { updateRef.current() }, [watch])

  // Unpinned, the map leaves the sidebar slot for the shared floating panel;
  // closing the panel pins it back. Only the navigator the slot belongs to
  // (the active layer's) opens one.
  const opensPanel = unpinned && !!mapHost && activeLayer
  React.useEffect(() => {
    if (!opensPanel) return
    let closingHere = false
    let handle: ReturnType<typeof openFloatingPanel> = null
    // The panel renders synchronously into its own root, which React refuses
    // while this effect's commit is still running, so open it just after.
    const timer = setTimeout(() => {
      try {
        handle = openFloatingPanel(null, {
          label: 'Pane map',
          kind: PANEL_KIND,
          size: PANEL_SIZE,
          exclusive: false,
          liveRegions: false,
          closeAs: { label: 'Pin pane map to the sidebar', icon: 'Pin' },
          onClose: () => { if (!closingHere) setMapUnpinned(false) },
        })
      } catch { handle = null }
      if (!handle) { setMapUnpinned(false); return }
      setPanelBody(handle.body)
    })
    return () => { closingHere = true; clearTimeout(timer); setPanelBody(null); handle?.close() }
  }, [opensPanel])

  // Held in the sidebar the map is the Arrangement section itself, so it shows
  // whenever there is an arrangement, even an empty canvas: pressing it adds a
  // pane. Floating over the work, it appears only once there are two panes.
  const hosted = !!mapHost
  const inPanel = opensPanel
  const mapOpen = hosted ? expanded : floatingOpen
  const showMap = !!(enabled && chromeZoneVisible(layoutState?.chrome, 'navigation') && snapshot && (hosted || snapshot.panes.length >= 2))

  // The wheel over the map zooms the arrangement and nothing else. React
  // attaches wheel listeners as passive, so the sidebar holding the map would
  // scroll it out from under the pointer; only a native non-passive listener
  // can keep the gesture on the map.
  // Zooming from the map is control `arrangement.zoom.map`, asked at each wheel: hidden by a show rule, the wheel over
  // the map scrolls what holds it like anywhere else.
  const wheelZoom = React.useRef({ zoom, onZoomChange })
  wheelZoom.current = { zoom, onZoomChange }
  React.useEffect(() => {
    const element = mapElement
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      const { zoom: current, onZoomChange: change } = wheelZoom.current
      if (!change || !event.deltaY || !controlShown(MAP_ZOOM_CONTROL)) return
      event.preventDefault()
      change(arrangementZoomForWheelDelta(current, event.deltaY, event.deltaMode))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [mapElement])

  React.useEffect(() => {
    const element = mapElement
    if (!element || typeof ResizeObserver === 'undefined') return
    const resize = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) setMapSize({ width, height })
    })
    resize.observe(element)
    return () => resize.disconnect()
  }, [mapElement])

  // Open over the work, the map closes on Escape like anything else opened over it (a host's own Escape, the Mac
  // menu bar panel's, reaches it the same way through the page).
  React.useEffect(() => {
    if (hosted || !floatingOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setFloatingOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape, true)
    return () => window.removeEventListener('keydown', closeOnEscape, true)
  }, [hosted, floatingOpen])

  if (!activeLayer || !layoutState || !layoutActions || !controlShown('arrangement.navigation')) return null
  if (!hosted && (sidebarPresent || !showMap)) return null
  // Unpinned and the panel not open yet: the slot stays empty rather than flash.
  if (inPanel && !panelBody) return null

  // The map is exactly as tall as the arrangement drawn at its width, up to
  // about half the window: every pane stays in view and in proportion, and no
  // empty glass sits above or below the drawing.
  const tallest = hosted && !inPanel ? MAP_SIDEBAR_TALLEST : typeof window === 'undefined' ? MAP_TALLEST : Math.min(MAP_TALLEST, Math.max(MAP_SHORTEST, window.innerHeight * 0.52))
  const scale = showMap && snapshot
    ? Math.min((mapSize.width - MAP_INSET * 2) / snapshot.contentWidth, (tallest - MAP_INSET * 2) / snapshot.contentHeight)
    : 1
  const drawnWidth = showMap && snapshot ? snapshot.contentWidth * scale : 0
  const drawnHeight = showMap && snapshot ? snapshot.contentHeight * scale : 0
  const mapHeight = showMap && snapshot ? Math.max(hosted && !inPanel ? 0 : MAP_SHORTEST_DRAWING, Math.ceil(drawnHeight + MAP_INSET * 2)) : MAP_HEIGHT
  const offsetX = (mapSize.width - drawnWidth) / 2
  const offsetY = (mapHeight - drawnHeight) / 2
  const originX = snapshot?.originX ?? 0
  const originY = snapshot?.originY ?? 0
  const toMap = (x: number, y: number) => ({ x: offsetX + (x - originX) * scale, y: offsetY + (y - originY) * scale })
  const toContent = (x: number, y: number): ArrangementMapPoint => ({ x: (x - offsetX) / scale + originX, y: (y - offsetY) / scale + originY })
  const currentPaneIndex = showMap && snapshot ? snapshot.panes.findIndex((pane) => (
    pane.left < snapshot.scrollLeft + snapshot.viewportWidth
    && pane.left + pane.width > snapshot.scrollLeft
    && pane.top < snapshot.scrollTop + snapshot.viewportHeight
    && pane.top + pane.height > snapshot.scrollTop
  )) : -1
  const scrollBehavior = arrangementNavigatorScrollBehavior(
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  )

  const shiftView = (delta: { x: number; y: number }, behavior: ScrollBehavior) => {
    const viewport = viewportRef.current
    if (!viewport || !Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return
    if (moveView) {
      moveView(delta)
      return
    }
    viewport.scrollTo({
      left: Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, viewport.scrollLeft + delta.x)),
      top: Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, viewport.scrollTop + delta.y)),
      behavior,
    })
  }
  const centreOn = (point: ArrangementMapPoint, behavior: ScrollBehavior) => {
    const viewport = viewportRef.current
    if (!viewport) return
    shiftView({
      x: point.x - (viewport.scrollLeft + viewport.clientWidth / 2),
      y: point.y - (viewport.scrollTop + viewport.clientHeight / 2),
    }, behavior)
  }
  const scrollToPane = (pane: ArrangementNavigatorPane) => {
    if (onPaneSelect) {
      onPaneSelect(pane)
      return
    }
    centreOn({ x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }, scrollBehavior)
  }
  const activeTiledRoot = () => {
    if (!layoutState) return null
    const activeLayouts = layoutState.layers?.find((layer) => layer.id === layoutState.activeLayerId)?.layouts ?? layoutState.layouts
    return activeLayouts.find((layout) => layout.type === 'tiled')?.root ?? null
  }
  // The split a pane's edge resizes, as it is drawn: a row drawn as a stack on a narrow stage has no edge across.
  const drawnResizeTarget = (containerId: string, edge: PaneMapEdge) => {
    const root = activeTiledRoot()
    const target = root ? paneResizeTarget(root, containerId, edge) : null
    const viewport = viewportRef.current
    if (!target || !viewport) return null
    const parent = Array.from(viewport.querySelectorAll<HTMLElement>('[data-split-id]'))
      .find((element) => element.dataset.splitId === target.path.join('.'))
    if (!parent || parent.dataset.narrowColumn === 'true') return null
    if (parent.dataset.splitDir && parent.dataset.splitDir !== target.dir) return null
    return { target, parent }
  }
  const commitMapResizeBy = (containerId: string, edge: PaneMapEdge, growBy: number) => {
    const drawn = drawnResizeTarget(containerId, edge)
    if (!drawn) return
    const { target, parent } = drawn
    const children = Array.from(parent.querySelectorAll<HTMLElement>('[data-split-child]'))
      .filter((element) => element.parentElement === parent)
    if (children.length < 2 || target.containerIndex >= children.length || target.neighborIndex >= children.length) return
    const horizontal = target.dir === 'row'
    // Layout pixels, as the pane edges themselves measure: the painted boxes over the arrangement's zoom, each pane
    // down to the same drag minimum its own edge stops at.
    const painted = parent.getBoundingClientRect()
    const layoutLength = horizontal ? parent.offsetWidth : parent.offsetHeight
    const paintedLength = horizontal ? painted.width : painted.height
    const zoomed = layoutLength > 0 && paintedLength > 0 ? paintedLength / layoutLength : 1
    const sizes = children.map((child) => {
      const rect = child.getBoundingClientRect()
      return (horizontal ? rect.width : rect.height) / zoomed
    })
    const minimums = children.map((child) => draggablePaneMinimumPx(horizontal, Number.parseFloat(horizontal ? child.style.minWidth : child.style.minHeight) || 0))
    const nextSizes = resizedSplitSizes(sizes, target.containerIndex, target.neighborIndex, growBy / zoomed, minimums)
    if (nextSizes) layoutActions.resizeSplit(nextSizes, target.path)
  }
  const commitMapResize = (drag: NonNullable<typeof mapDrag.current>, point: ArrangementMapPoint) => {
    if (drag.intent !== 'resize' || !drag.sourcePaneId || !drag.edge || !drag.moved) return
    const start = toContent(drag.startX, drag.startY)
    const horizontal = drag.edge === 'left' || drag.edge === 'right'
    const delta = horizontal ? point.x - start.x : point.y - start.y
    const growBy = drag.edge === 'left' || drag.edge === 'top' ? -delta : delta
    commitMapResizeBy(drag.sourcePaneId, drag.edge, growBy)
  }
  // Where a point on the map lands: the line between two panes resizes them, a band along a pane's inside edge adds a
  // pane on that side of it, the rest of a pane is the pane itself (press to go to it, drag to move it), and the space
  // around the panes adds a pane on that side of them all.
  const tileOf = (pane: ArrangementNavigatorPane) => {
    const at = toMap(pane.left, pane.top)
    return { x: at.x + 1, y: at.y + 1, w: Math.max(2, pane.width * scale - 2), h: Math.max(2, pane.height * scale - 2) }
  }
  const hitAt = (point: { x: number; y: number }): PaneMapHit => {
    if (!snapshot) return { kind: 'none' }
    for (const pane of snapshot.panes) {
      const tile = tileOf(pane)
      if (point.x < tile.x || point.x > tile.x + tile.w || point.y < tile.y || point.y > tile.y + tile.h) continue
      const edge = addEdgeInTile(tile, point)
      return edge ? { kind: 'add', paneId: pane.id, edge } : { kind: 'pane', paneId: pane.id }
    }
    const side = sideOfPanes(snapshot.panes, toContent(point.x, point.y))
    return { kind: 'around', edge: side.dir === 'row' ? (side.position === 'before' ? 'left' : 'right') : (side.position === 'before' ? 'top' : 'bottom') }
  }
  /** The part of the map a new or moved pane would take: that side of one pane, or that side of all of them. */
  const landingRect = (edge: PaneMapEdge, paneId?: string) => {
    if (!snapshot) return null
    const pane = paneId ? snapshot.panes.find((one) => one.id === paneId) : null
    const box = pane ? tileOf(pane) : (() => {
      const at = toMap(snapshot.originX, snapshot.originY)
      return { x: at.x, y: at.y, w: snapshot.contentWidth * scale, h: snapshot.contentHeight * scale }
    })()
    const share = pane ? 0.5 : 1 / 3
    const w = edge === 'left' || edge === 'right' ? box.w * share : box.w
    const h = edge === 'top' || edge === 'bottom' ? box.h * share : box.h
    return { x: edge === 'right' ? box.x + box.w - w : box.x, y: edge === 'bottom' ? box.y + box.h - h : box.y, w, h }
  }
  const addBeside = (paneId: string, edge: PaneMapEdge) => {
    // A free arrangement (a canvas) places the new pane at that side of the pane instead of splitting a tree.
    const box = onAddAt ? landingRect(edge, paneId) : null
    if (onAddAt && box && snapshot) {
      onAddAt(toContent(box.x + box.w / 2, box.y + box.h / 2), snapshot)
      return
    }
    const horizontal = edge === 'left' || edge === 'right'
    layoutActions.splitContainer(paneId, horizontal ? 'row' : 'column', undefined, edge === 'left' || edge === 'top' ? 'before' : 'after')
    setSelectedTargetContainerId(paneId)
  }
  const addAround = (edge: PaneMapEdge, point: ArrangementMapPoint) => {
    if (!snapshot) return
    if (onAddAt) {
      onAddAt(point, snapshot)
      return
    }
    layoutActions.splitAtRoot(edge === 'left' || edge === 'right' ? 'row' : 'column', edge === 'left' || edge === 'top' ? 'before' : 'after')
  }
  const moveTo = (sourcePaneId: string, hit: PaneMapHit) => {
    if (hit.kind === 'add') {
      if (hit.paneId === sourcePaneId) return
      const horizontal = hit.edge === 'left' || hit.edge === 'right'
      layoutActions.moveContainerToEdge(sourcePaneId, hit.paneId, horizontal ? 'row' : 'column', hit.edge === 'left' || hit.edge === 'top' ? 'before' : 'after')
    } else if (hit.kind === 'around') {
      layoutActions.moveContainerToRoot(sourcePaneId, hit.edge === 'left' || hit.edge === 'right' ? 'row' : 'column', hit.edge === 'left' || hit.edge === 'top' ? 'before' : 'after')
    } else return
    setSelectedTargetContainerId(sourcePaneId)
  }
  /** Where a dragged pane lands: a pane's side, or (over a pane's middle) the side of it nearest the pointer. */
  const dropAt = (point: { x: number; y: number }, sourcePaneId: string): PaneMapHit => {
    const hit = hitAt(point)
    if ((hit.kind === 'add' || hit.kind === 'pane') && hit.paneId === sourcePaneId) return { kind: 'none' }
    if (hit.kind === 'pane' && snapshot) {
      const pane = snapshot.panes.find((one) => one.id === hit.paneId)
      if (pane) return { kind: 'add', paneId: pane.id, edge: edgeAtPanePoint(pane, toContent(point.x, point.y)) }
    }
    return hit
  }

  const drag = mapDrag.current
  const hover = mapPointer && showMap && !drag?.moved && !onResizeLine ? hitAt(mapPointer) : null
  const landing = drag?.moved && drag.intent === 'move' && drag.sourcePaneId && mapPointer
    ? dropAt(mapPointer, drag.sourcePaneId)
    : hover && (hover.kind === 'add' || hover.kind === 'around') ? hover : null
  const landingBox = landing && (landing.kind === 'add' || landing.kind === 'around')
    ? landingRect(landing.edge, landing.kind === 'add' ? landing.paneId : undefined)
    : null
  const indexOf = (paneId: string) => (snapshot?.panes.findIndex((pane) => pane.id === paneId) ?? -1) + 1

  const canUnpin = hosted && !inPanel && canOpenFloatingPanel()
  const toggleMap = () => (hosted ? setExpanded : setFloatingOpen)((value) => !value)
  // Floating over the work, hiding the map is closing it, so it reads as a close.
  const mapToggle = (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      aria-expanded={mapOpen}
      aria-controls={mapId}
      aria-label={mapOpen ? 'Hide pane map' : 'Show pane map'}
      title={mapOpen ? 'Hide pane map' : 'Show pane map'}
      onClick={toggleMap}
    >
      <NamedIcon name={!hosted && mapOpen ? 'X' : mapOpen || !hosted ? 'Map' : 'MapOff'} size="xs" aria-hidden="true" />
    </Button>
  )
  const header = (
    <div className="flex min-w-0 items-start justify-between gap-1">
      <ArrangementSurfaceControl embedded targetContainerId={placementTargetId} targetPosition={selectedTargetPosition} />
      {showMap || canUnpin ? (
        <div className="flex h-7 shrink-0 items-center gap-1">
          {canUnpin ? (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Unpin pane map"
              title="Unpin pane map"
              onClick={() => setMapUnpinned(true)}
            >
              <NamedIcon name="PinOff" size="xs" aria-hidden="true" />
            </Button>
          ) : null}
          {showMap ? mapToggle : null}
        </div>
      ) : null}
    </div>
  )

  const pointOf = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }
  const map = showMap && snapshot && mapOpen ? (
    <div
      id={mapId}
      ref={setMapElement}
      role="group"
      aria-label="Pane map. Drag a pane to move it, choose a side of a pane to add one there, drag the line between panes to resize them, or choose a pane to bring it into view."
      data-pane-map-surface
      data-pane-map-pointer={drag?.moved ? drag.intent : hover?.kind ?? undefined}
      className={hosted && !inPanel ? 'relative mt-1 overflow-hidden rounded-md touch-none' : 'relative mt-2 overflow-hidden rounded-md bg-[var(--glass-bg-subtle)] touch-none'}
      style={{ width: '100%', height: mapHeight }}
      onPointerDown={(event) => {
        if (event.button > 0) return
        const point = pointOf(event)
        const element = event.target instanceof Element ? event.target : null
        const resizeHandle = element?.closest<HTMLElement>('[data-pane-map-resize-edge]') ?? null
        const hit = hitAt(point)
        const sourcePaneId = resizeHandle?.dataset.paneId ?? (hit.kind === 'add' || hit.kind === 'pane' ? hit.paneId : undefined)
        mapDrag.current = {
          pointerId: event.pointerId,
          moved: false,
          startedOnPane: !!sourcePaneId,
          startX: point.x,
          startY: point.y,
          ...(sourcePaneId ? { sourcePaneId } : {}),
          intent: resizeHandle ? 'resize' : sourcePaneId ? 'move' : 'navigate',
          ...(resizeHandle?.dataset.paneMapResizeEdge ? { edge: resizeHandle.dataset.paneMapResizeEdge as PaneMapEdge } : {}),
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setMapPointer(point)
      }}
      onPointerMove={(event) => {
        const point = pointOf(event)
        setMapPointer(point)
        if (!mapDrag.current) setOnResizeLine(event.target instanceof Element && !!event.target.closest('[data-pane-map-resize-edge]'))
        const current = mapDrag.current
        if (!current || current.pointerId !== event.pointerId) return
        if (!current.moved && Math.hypot(point.x - current.startX, point.y - current.startY) < 4) return
        current.moved = true
        if (current.intent === 'navigate') centreOn(toContent(point.x, point.y), 'instant')
      }}
      onPointerUp={(event) => {
        const current = mapDrag.current
        if (!current || current.pointerId !== event.pointerId) return
        const point = pointOf(event)
        const contentPoint = toContent(point.x, point.y)
        mapDrag.current = null
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
        if (current.intent === 'resize') {
          commitMapResize(current, contentPoint)
          if (current.sourcePaneId) setSelectedTargetContainerId(current.sourcePaneId)
        } else if (current.intent === 'move' && current.sourcePaneId) {
          if (current.moved) {
            moveTo(current.sourcePaneId, dropAt(point, current.sourcePaneId))
            setSelectedTargetPosition(contentPoint)
          } else {
            const hit = hitAt(point)
            const pane = snapshot.panes.find((one) => one.id === current.sourcePaneId)
            if (hit.kind === 'add') addBeside(hit.paneId, hit.edge)
            else if (pane) {
              setSelectedTargetContainerId(pane.id)
              setSelectedTargetPosition({ x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 })
              scrollToPane(pane)
            }
          }
        } else if (!current.moved) {
          const hit = hitAt(point)
          if (hit.kind === 'around') addAround(hit.edge, contentPoint)
        }
        // Once the panes changed, the map redraws from the new layout with no landing left over the new pane; the next
        // pointer move shows one again.
        setMapPointer(current.intent === 'navigate' && current.moved ? point : null)
      }}
      onPointerCancel={() => {
        mapDrag.current = null
        setMapPointer(null)
      }}
      onPointerLeave={() => { if (!mapDrag.current) { setMapPointer(null); setOnResizeLine(false) } }}
    >
      <div
        aria-hidden="true"
        data-pane-map-viewport
        className="pointer-events-none absolute z-[1] rounded-sm border border-[var(--border-secondary,var(--text-muted))] bg-[var(--glass-bg-subtle)]"
        style={{
          left: toMap(snapshot.scrollLeft, snapshot.scrollTop).x,
          top: toMap(snapshot.scrollLeft, snapshot.scrollTop).y,
          width: Math.max(2, snapshot.viewportWidth * scale),
          height: Math.max(2, snapshot.viewportHeight * scale),
        }}
      />
      {/* Each pane is its own picture and its own handle: press anywhere on it to go to it, drag it to move it. */}
      {snapshot.panes.map((pane, index) => {
        const tile = tileOf(pane)
        const isCurrent = index === currentPaneIndex
        const dotSize = Math.max(3, Math.min(14, 8 * zoom))
        const lifted = drag?.moved && drag.intent === 'move' && drag.sourcePaneId === pane.id
        return (
          <Button
            key={pane.id}
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute z-10 min-h-0 min-w-0 rounded-[3px] p-0"
            style={{ left: tile.x, top: tile.y, width: tile.w, height: tile.h }}
            aria-label={`${paneLabel(index, snapshot.panes.length)}. Drag to move this pane.`}
            aria-current={isCurrent ? 'location' : undefined}
            aria-pressed={pane.id === placementTargetId}
            data-pane-map-dot
            data-pane-map-tile
            data-pane-map-current={isCurrent ? '' : undefined}
            data-pane-map-lifted={lifted ? '' : undefined}
            data-pane-id={pane.id}
            onFocus={() => setFocusedPaneId(pane.id)}
            onClick={(event) => {
              // A press of the pointer is handled on the map; this is Enter or Space.
              if (event.detail !== 0) return
              setSelectedTargetContainerId(pane.id)
              setSelectedTargetPosition({ x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 })
              scrollToPane(pane)
            }}
          >
            <span aria-hidden="true" data-pane-map-dot-mark style={{ width: dotSize, height: dotSize }} />
          </Button>
        )
      })}
      {/* The line between two panes: drag it (or press the arrow keys) to give one more room and the other less. */}
      {snapshot.panes.flatMap((pane, index) => (['right', 'bottom'] as const)
        .filter((edge) => drawnResizeTarget(pane.id, edge))
        .map((edge) => {
          const tile = tileOf(pane)
          const across = edge === 'right'
          const resizing = !!(drag?.moved && drag.intent === 'resize' && drag.sourcePaneId === pane.id && drag.edge === edge && mapPointer)
          const offset = resizing && mapPointer && drag ? (across ? mapPointer.x - drag.startX : mapPointer.y - drag.startY) : 0
          return (
            <Button
              key={`${pane.id}-${edge}`}
              type="button"
              variant="ghost"
              size="icon-xs"
              className="absolute z-20 min-h-0 min-w-0 rounded-none p-0"
              style={across
                ? { left: tile.x + tile.w - 4 + offset, top: tile.y, width: 9, height: tile.h }
                : { left: tile.x, top: tile.y + tile.h - 4 + offset, width: tile.w, height: 9 }}
              aria-label={`Resize pane ${index + 1} from its ${edge} edge`}
              title="Drag to resize"
              data-pane-map-resize-edge={edge}
              data-pane-map-resizing={resizing ? '' : undefined}
              data-pane-id={pane.id}
              onKeyDown={(event) => {
                const negative = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                const positive = event.key === 'ArrowRight' || event.key === 'ArrowDown'
                if (!negative && !positive) return
                if (across !== (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
                event.preventDefault()
                commitMapResizeBy(pane.id, edge, negative ? -16 : 16)
              }}
            >
              <span aria-hidden="true" data-pane-map-resize-line={across ? 'across' : 'down'} />
            </Button>
          )
        }))}
      {/* Adding from the keyboard: a focused pane offers a pane on each of its sides. */}
      {focusedPaneId && !drag ? (['left', 'right', 'top', 'bottom'] as const).flatMap((edge) => {
        const box = landingRect(edge, focusedPaneId)
        if (!box) return []
        return [(
          <Button
            key={`add-${edge}`}
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute z-[15] min-h-0 min-w-0 p-0 opacity-0 focus-visible:opacity-100"
            style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
            aria-label={`Add a pane to the ${edge} of pane ${indexOf(focusedPaneId)}`}
            data-pane-map-add-button={edge}
            onClick={(event) => { if (event.detail === 0) addBeside(focusedPaneId, edge) }}
          >
            <NamedIcon name="Plus" size="xs" aria-hidden="true" />
          </Button>
        )]
      }) : null}
      {/* Where a pane would land: dashed, on the side the pointer is near (a press adds one there) or where a dragged
          pane drops. */}
      {landing && landingBox && (landing.kind === 'add' || landing.kind === 'around') ? (
        <span
          aria-hidden="true"
          data-pane-map-landing={drag?.moved ? 'move' : 'add'}
          data-pane-map-landing-edge={landing.edge}
          data-pane-map-landing-pane={landing.kind === 'add' ? landing.paneId : 'around'}
          {...(drag?.moved ? { 'data-pane-map-drop-preview': landing.edge, 'data-pane-map-drop-target': landing.kind === 'add' ? landing.paneId : 'frame' } : {})}
          style={{ left: landingBox.x, top: landingBox.y, width: landingBox.w, height: landingBox.h }}
        >
          {drag?.moved ? null : <NamedIcon name="Plus" size="xs" />}
        </span>
      ) : null}
      {/* The dragged pane follows the pointer until it is let go. */}
      {drag?.moved && drag.intent === 'move' && drag.sourcePaneId && mapPointer ? (() => {
        const source = snapshot.panes.find((pane) => pane.id === drag.sourcePaneId)
        if (!source) return null
        const tile = tileOf(source)
        const w = Math.min(tile.w, 64)
        const h = Math.min(tile.h, 48)
        return (
          <span
            aria-hidden="true"
            data-pane-map-ghost
            style={{ left: mapPointer.x - w / 2, top: mapPointer.y - h / 2, width: w, height: h }}
          />
        )
      })() : null}
    </div>
  ) : null

  // Floating, it sits in the window's bottom-left corner group, where the sidebar's button would be: there is no
  // sidebar on this page (invariant 6).
  const navigator = hosted ? (
    <aside
      aria-label="Arrangement navigation"
      className="w-full min-w-0 p-1"
      data-arrangement-navigator
      onPointerDown={(event) => event.stopPropagation()}
    >
      {header}
      {map}
    </aside>
  ) : (
    <aside
      aria-label="Arrangement navigation"
      className={floatingOpen
        ? 'glass-surface w-[min(20rem,calc(100vw-2rem))] rounded-xl p-2'
        : 'glass-surface rounded-full p-1'}
      data-arrangement-navigator
      data-floating-pane-map={floatingOpen ? 'open' : 'closed'}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {floatingOpen ? header : mapToggle}
      {map}
    </aside>
  )
  const navigatorHost = inPanel ? panelBody : mapHost
  return navigatorHost ? createPortal(navigator, navigatorHost) : <InWindowCorner corner="bottom-left">{navigator}</InWindowCorner>
}
