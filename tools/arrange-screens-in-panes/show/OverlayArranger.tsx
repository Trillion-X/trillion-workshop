'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order'
import { cn } from '../../ui/show/cn'
import { LayoutStateContext } from './layout-state-context'
import { backdropRegion, containerRegion, regionAddressKey } from '../read-data/region-address'
import { regionZoneVisible } from '../read-data/region-chrome'
import { VisualLayerStack, builtinVisualLayerCapabilities, createCapabilityMap } from '../../ui/show/visual-layer-stack'
import { nodeRefAttr } from './node-ref-attr'
import { useVisualLayerSubjectResolver } from './visual-layer-subject-resolver'

// Context for overlay drag functionality
export const OverlayWindowContext = React.createContext<{
  onStartDrag?: (containerId: string, e: React.PointerEvent) => void
} | null>(null)

export type OverlayBox = {
  containerId: string
  x: number
  y: number
  w: number
  h: number
  z: number
}

type Props = {
  boxes: OverlayBox[]
  onBringToFront: (id: string) => void
  onMove: (id: string, xy: { x: number; y: number }) => void
  onResize: (id: string, size: { w: number; h: number }) => void
  onDragEnd?: () => void
  renderContainer: (id: string) => React.ReactNode
  isFocusMode?: boolean
  /** False for PiPs on a layer that is not receiving edits: shown, but inert. */
  interactive?: boolean
  /** Stacking layer of the plane, from LAYER_ORDER; defaults to picture-in-picture. */
  layer?: number
  /** Closes a window (a press outside a window that closes that way). */
  onDismiss?: (id: string) => void
  /** Right-click on a window or its backdrop: these windows are portalled out of the arrangement's own root. */
  onContextMenu?: (event: React.MouseEvent) => void
}

/** Visible extent, in px, below which a window counts as tucked away. */
export const OVERLAY_PEEK_VISIBLE_PX = 48

/** True only when the window shows no more than a thin strip on screen. */
export function overlayIsPeeking(box: {x: number; y: number; w: number; h: number}, viewportWidth: number, viewportHeight: number): boolean {
  const visibleWidth = Math.min(box.x + box.w, viewportWidth) - Math.max(box.x, 0)
  const visibleHeight = Math.min(box.y + box.h, viewportHeight) - Math.max(box.y, 0)
  return visibleWidth < OVERLAY_PEEK_VISIBLE_PX || visibleHeight < OVERLAY_PEEK_VISIBLE_PX
}

/** Room kept between a window brought back into view and the edges of the screen. */
const OVERLAY_IN_VIEW_MARGIN_PX = 16

/**
 * Where a window is drawn: where it was put, unless none of it is on screen (it
 * was put against a wider or taller window, as on a computer before the same
 * arrangement opens on a phone). Then it is drawn inside the screen, as large as
 * it was or as large as fits. A window tucked to an edge keeps a strip on screen
 * (a move never leaves less), so it stays tucked.
 */
export function overlayBoxInView<T extends {x: number; y: number; w: number; h: number}>(box: T, viewportWidth: number, viewportHeight: number): T {
  const visibleWidth = Math.min(box.x + box.w, viewportWidth) - Math.max(box.x, 0)
  const visibleHeight = Math.min(box.y + box.h, viewportHeight) - Math.max(box.y, 0)
  if (visibleWidth > 0 && visibleHeight > 0) return box
  const margin = OVERLAY_IN_VIEW_MARGIN_PX
  const w = Math.min(box.w, Math.max(160, viewportWidth - margin * 2))
  const h = Math.min(box.h, Math.max(120, viewportHeight - margin * 2))
  return {
    ...box,
    x: Math.max(0, Math.min(Math.max(box.x, margin), viewportWidth - margin - w)),
    y: Math.max(0, Math.min(Math.max(box.y, margin), viewportHeight - margin - h)),
    w,
    h,
  }
}

/** Fit a normal window for the duration of a viewport shrink, without changing its saved box. */
export function overlayBoxAfterViewportShrink<T extends {x: number; y: number; w: number; h: number}>(
  box: T,
  previousWidth: number,
  previousHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  alreadyFitted = false,
): T | null {
  const originalFits = box.x >= 0 && box.y >= 0
    && box.x + box.w <= viewportWidth && box.y + box.h <= viewportHeight
  const wasFullyVisible = box.x >= 0 && box.y >= 0
    && box.x + box.w <= previousWidth && box.y + box.h <= previousHeight
  if (originalFits) return null
  if (!alreadyFitted && !wasFullyVisible) return null
  return fitOverlayBox(box, viewportWidth, viewportHeight)
}

function fitOverlayBox<T extends {x: number; y: number; w: number; h: number}>(box: T, viewportWidth: number, viewportHeight: number): T {
  const margin = OVERLAY_IN_VIEW_MARGIN_PX
  const w = Math.min(box.w, Math.max(160, viewportWidth - margin * 2))
  const h = Math.min(box.h, Math.max(120, viewportHeight - margin * 2))
  return {
    ...box,
    x: Math.max(margin, Math.min(box.x, viewportWidth - margin - w)),
    y: Math.max(margin, Math.min(box.y, viewportHeight - margin - h)),
    w,
    h,
  }
}

export default function OverlayArranger({
  boxes,
  onBringToFront,
  onMove,
  onResize,
  onDragEnd,
  renderContainer,
  isFocusMode,
  interactive = true,
  layer = LAYER_ORDER.pictureInPicture,
  onDismiss,
  onContextMenu,
}: Props) {
  const rootRef = React.useRef<HTMLDivElement | null>(null)

  const root = (
    <div ref={rootRef} className="pointer-events-none fixed inset-0" style={{ zIndex: layer }} data-arrangement-pip-plane="" inert={interactive ? undefined : true} aria-hidden={interactive ? undefined : true} onContextMenu={onContextMenu}>
      {boxes.map((box) => (
        <OverlayBackdrop key={`backdrop-${box.containerId}`} box={box} isFocusMode={!!isFocusMode} onDismiss={onDismiss} />
      ))}
      {boxes.map((box) => (
        <OverlayWindow
          key={box.containerId}
          box={box}
          onBringToFront={onBringToFront}
          onMove={onMove}
          onResize={onResize}
          onDragEnd={onDragEnd}
          isFocusMode={!!isFocusMode}
        >
          {renderContainer(box.containerId)}
        </OverlayWindow>
      ))}
    </div>
  )
  // PiP windows portal out of the arrangement stage so they share the app-wide
  // stacking scale: above floating chrome such as an undocked sidebar, below
  // dialogs and menus. Later layers portal later, so upper layers stay on top.
  return typeof document === 'undefined' ? root : createPortal(root, document.body)
}

// ---------------------------------------------------------------------------
// OVERLAY BACKDROP — the whole screen behind one window
// ---------------------------------------------------------------------------
//
// A window's backdrop is its own region (backdropRegion): whatever layers its
// stack holds (a dim colour, a blur, a picture, grain) paint the screen beneath
// the window and above everything under it, and its right-click menu edits them
// like any region's. A window that closes on an outside press
// (closeOnOutsidePress) takes the press here; otherwise the backdrop lets every
// press through. A window with neither draws no backdrop at all.
// ---------------------------------------------------------------------------

const BACKDROP_CAPABILITIES = createCapabilityMap(builtinVisualLayerCapabilities)

function OverlayBackdrop({ box, isFocusMode, onDismiss }: { box: OverlayBox; isFocusMode: boolean; onDismiss?: (id: string) => void }) {
  const layoutState = React.useContext(LayoutStateContext)
  const region = backdropRegion(box.containerId)
  const layers = layoutState?.visualLayerStacks?.[regionAddressKey(region)]?.layers ?? []
  const resolveSubject = useVisualLayerSubjectResolver(layers)
  const closes = Boolean(onDismiss && layoutState?.closeOnOutsidePress?.[box.containerId])
  if (isFocusMode || (layers.length === 0 && !closes)) return null
  return (
    <div
      className={cn('fixed inset-0', closes ? 'pointer-events-auto' : 'pointer-events-none')}
      style={{ zIndex: 999 + 2 * (box.z ?? 0) }}
      data-node-ref={nodeRefAttr(region)}
      data-overlay-backdrop={box.containerId}
      onPointerDown={closes ? (event) => { if (event.button === 0) onDismiss?.(box.containerId) } : undefined}
    >
      {layers.length > 0 ? <VisualLayerStack region={region} layers={layers} map={BACKDROP_CAPABILITIES} resolveSubject={resolveSubject} /> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// OVERLAY WINDOW — ref-based imperative drag/resize (zero re-renders during move)
// ---------------------------------------------------------------------------
//
// Same pattern as FreeformWindow: during drag/resize, position is tracked in
// refs and applied directly to the DOM element. React state is never set during
// pointer movement. The layout owner is committed ONCE on pointer up.
// This eliminates the re-render-per-pointermove cycle that made overlay drag laggy.
// ---------------------------------------------------------------------------

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
type LiveRect = { x: number; y: number; w: number; h: number }

function OverlayWindow({
  box: placed,
  onBringToFront,
  onMove,
  onResize,
  onDragEnd,
  children,
  isFocusMode,
}: {
  box: OverlayBox
  onBringToFront: (id: string) => void
  onMove: (id: string, xy: { x: number; y: number }) => void
  onResize: (id: string, size: { w: number; h: number }) => void
  onDragEnd?: () => void
  children: React.ReactNode
  isFocusMode: boolean
}) {
  const id = placed.containerId
  // The window is drawn where it was put, or inside the screen when none of it
  // would be on screen (overlayBoxInView). A move commits from where it is drawn.
  const [viewport, setViewport] = React.useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  const [viewportFit, setViewportFit] = React.useState<LiveRect | null>(null)
  const viewportFitRef = React.useRef(viewportFit)
  viewportFitRef.current = viewportFit
  const placedKey = `${placed.x}:${placed.y}:${placed.w}:${placed.h}`
  const previousPlacedKey = React.useRef(placedKey)
  const viewportRef = React.useRef(viewport)
  viewportRef.current = viewport
  React.useEffect(() => {
    const measure = () => {
      const previous = viewportRef.current
      const next = { w: window.innerWidth, h: window.innerHeight }
      const fitted = overlayBoxAfterViewportShrink(placed, previous.w, previous.h, next.w, next.h, viewportFitRef.current !== null)
      viewportFitRef.current = fitted
      setViewportFit(fitted)
      viewportRef.current = next
      setViewport(next)
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [placed.x, placed.y, placed.w, placed.h])
  React.useEffect(() => {
    if (previousPlacedKey.current !== placedKey) {
      previousPlacedKey.current = placedKey
      setViewportFit((current) => {
        if (!current) return null
        const adjusted = overlayBoxAfterViewportShrink(placed, viewport.w, viewport.h, viewport.w, viewport.h, true)
        return adjusted && (adjusted.x !== placed.x || adjusted.y !== placed.y || adjusted.w !== placed.w || adjusted.h !== placed.h)
          ? adjusted
          : null
      })
    }
  }, [placedKey, placed, viewport.w, viewport.h])
  const box = viewportFit ?? overlayBoxInView(placed, viewport.w, viewport.h)
  // Region-effective chrome: an immersive region ({'':false}) drops its frame in
  // EVERY display mode, not just the grid — so a maximized/PiP immersive container
  // shows only its surface (note #33, category-complete). Absent = framed.
  const layoutState = React.useContext(LayoutStateContext)
  const frameVisible = regionZoneVisible(layoutState?.chrome, layoutState?.regionChrome, containerRegion(id), 'container.frame')
  // A window whose chrome DATA turns off 'container.fill-height' is as tall as
  // what it shows, up to its own height: an empty message box is just the box,
  // and grows while what was shared to it is shown.
  const fillsHeight = regionZoneVisible(layoutState?.chrome, layoutState?.regionChrome, containerRegion(id), 'container.fill-height')
  const selfRef = React.useRef<HTMLDivElement | null>(null)

  // Ref-based operation tracking — no React state during drag/resize
  const activeOp = React.useRef<{ kind: 'drag' | 'resize'; edge?: ResizeEdge } | null>(null)
  const startRef = React.useRef<{ x: number; y: number; base: LiveRect } | null>(null)
  const liveRect = React.useRef<LiveRect>({ x: box.x, y: box.y, w: box.w, h: box.h })

  // Sync liveRect from props when NOT actively dragging (owner-fed snapshot changed externally)
  if (!activeOp.current) {
    liveRect.current = { x: box.x, y: box.y, w: box.w, h: box.h }
  }

  /** Apply rect directly to the DOM element — zero React overhead */
  const applyToDOM = (rect: LiveRect) => {
    const el = selfRef.current
    if (!el) return
    el.style.left = `${rect.x}px`
    el.style.top = `${rect.y}px`
    el.style.width = `${rect.w}px`
    if (fillsHeight) el.style.height = `${rect.h}px`
    else el.style.maxHeight = `${rect.h}px`
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!startRef.current || !activeOp.current) return
    // If pointer-up was missed, end drag when no buttons are pressed.
    if (e.buttons === 0) { onPointerUp(); return }

    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y

    if (activeOp.current.kind === 'drag') {
      const rect: LiveRect = {
        x: startRef.current.base.x + dx,
        y: startRef.current.base.y + dy,
        w: startRef.current.base.w,
        h: startRef.current.base.h,
      }
      liveRect.current = rect
      applyToDOM(rect)
      return
    }

    if (activeOp.current.kind === 'resize' && activeOp.current.edge) {
      const { base } = startRef.current
      const edge = activeOp.current.edge
      let { x, y, w, h } = base

      if (edge.includes('e')) w = Math.max(160, base.w + dx)
      if (edge.includes('s')) h = Math.max(120, base.h + dy)
      if (edge.includes('w')) { w = Math.max(160, base.w - dx); x = base.x + dx }
      if (edge.includes('n')) { h = Math.max(120, base.h - dy); y = base.y + dy }

      const rect: LiveRect = { x, y, w, h }
      liveRect.current = rect
      applyToDOM(rect)
    }
  }

  const onPointerUp = () => {
    const op = activeOp.current
    activeOp.current = null
    startRef.current = null
    // Restore CSS transitions
    if (selfRef.current) selfRef.current.style.transition = ''
    unbindListeners()

    if (!op) return

    // Single commit to the layout owner snapshot
    const r = liveRect.current

    // Edge snapping: keep at least 12px visible
    const vw = window.innerWidth, vh = window.innerHeight
    const peek = 12
    r.x = Math.min(Math.max(r.x, -r.w + peek), vw - peek)
    r.y = Math.min(Math.max(r.y, -r.h + peek), vh - peek)

    onMove(id, { x: r.x, y: r.y })
    if (op.kind === 'resize') onResize(id, { w: r.w, h: r.h })
    onDragEnd?.()
  }

  // Ref indirections for pointer handlers — listeners call through refs
  // so they always reach the latest closures (avoids stale onMove/onResize/onDragEnd)
  const onPointerMoveRef = React.useRef(onPointerMove)
  onPointerMoveRef.current = onPointerMove
  const onPointerUpRef = React.useRef(onPointerUp)
  onPointerUpRef.current = onPointerUp

  // Imperative listener binding — no React effect re-subscription
  const listenersRef = React.useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null)

  const bindListeners = () => {
    if (listenersRef.current) return
    const move = (e: PointerEvent) => onPointerMoveRef.current(e)
    const up = () => onPointerUpRef.current()
    listenersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', up)
  }

  const unbindListeners = () => {
    if (!listenersRef.current) return
    const { move, up } = listenersRef.current
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('pointercancel', up)
    window.removeEventListener('blur', up)
    listenersRef.current = null
  }

  // Cleanup on unmount
  React.useEffect(() => () => unbindListeners(), [])

  /** Start a drag operation (called from Move handle or direct pointer down) */
  const startDrag = (e: React.PointerEvent | PointerEvent) => {
    ;(e as any).preventDefault?.()
    activeOp.current = { kind: 'drag' }
    startRef.current = { x: (e as any).clientX, y: (e as any).clientY, base: { ...liveRect.current } }
    onBringToFront(id)
    if (selfRef.current) selfRef.current.style.transition = 'none'
    bindListeners()
  }

  // Ref indirection: context always calls the latest startDrag, avoiding stale closures
  const startDragRef = React.useRef(startDrag)
  startDragRef.current = startDrag

  /** Start a resize operation */
  const startResize = (edge: ResizeEdge, e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
    activeOp.current = { kind: 'resize', edge }
    startRef.current = { x: e.clientX, y: e.clientY, base: { ...liveRect.current } }
    onBringToFront(id)
    if (selfRef.current) selfRef.current.style.transition = 'none'
    bindListeners()
  }

  // A window is peeking only when it has been tucked away so that just a thin
  // strip stays on screen. A window that merely overhangs an edge (a remembered
  // size larger than the current window, a sub-pixel overshoot after the
  // window shrank) is still a normal window: it keeps its resize handles and
  // moves from its header. Treating any overhang as a peek removed every
  // handle and turned the whole frame into a grab target.
  const isPeeking = overlayIsPeeking(box, viewport.w, viewport.h)

  // Focus mode: render as thin peeks near nearest edge
  const peekStyle = React.useMemo(() => {
    if (!isFocusMode) return {}
    const vw = window.innerWidth, vh = window.innerHeight
    const cx = Math.min(Math.max(box.x, 0), vw - box.w)
    const cy = Math.min(Math.max(box.y, 0), vh - box.h)
    const dist = [
      { side: 'left', d: Math.abs(cx - 0) },
      { side: 'right', d: Math.abs(vw - (cx + box.w)) },
      { side: 'top', d: Math.abs(cy - 0) },
      { side: 'bottom', d: Math.abs(vh - (cy + box.h)) },
    ].sort((a, b) => a.d - b.d)[0].side as 'left' | 'right' | 'top' | 'bottom'
    const peek = 12
    const base = { width: box.w, height: box.h, left: box.x, top: box.y }
    if (dist === 'left') return { ...base, left: -box.w + peek }
    if (dist === 'right') return { ...base, left: window.innerWidth - peek }
    if (dist === 'top') return { ...base, top: -box.h + peek }
    return { ...base, top: window.innerHeight - peek }
  }, [isFocusMode, box])

  // Stable context value — calls through ref so it always reaches the latest startDrag
  const overlayContext = React.useMemo(() => ({
    onStartDrag: (_containerId: string, e: React.PointerEvent | PointerEvent) => startDragRef.current(e)
  }), [])

  return (
    <div
      ref={selfRef}
      style={isFocusMode ? { ...peekStyle, zIndex: 1000 + 2 * (box.z ?? 0) } : { left: box.x, top: box.y, width: box.w, ...(fillsHeight ? { height: box.h } : { maxHeight: box.h }), zIndex: 1000 + 2 * (box.z ?? 0) }}
      className={cn(
        'pointer-events-auto fixed flex flex-col',
        frameVisible && 'glass-surface',
        (isFocusMode || isPeeking) ? 'cursor-grab active:cursor-grabbing' : ''
      )}
      onMouseDown={() => onBringToFront(id)}
      onPointerDown={(isFocusMode || isPeeking) ? (e) => startDrag(e) : undefined}
    >
      {/* Content area: clipped to the frame's corner less its line (screen-look nested-corners.css), so what fills the
          window meets the frame's curve instead of poking a square corner into it. */}
      <OverlayWindowContext.Provider value={overlayContext}>
        <div className="flex-1 min-h-0 overflow-hidden" data-corner-follows="">
          {children}
        </div>
      </OverlayWindowContext.Provider>

      {/* Eight invisible resize handles (disabled when peeking) */}
      {!isPeeking && (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map((edge) => {
        const pos =
          edge === 'n' ? 'top-0 left-2 right-2 h-2 cursor-n-resize' :
          edge === 's' ? 'bottom-0 left-2 right-2 h-2 cursor-s-resize' :
          edge === 'e' ? 'top-2 bottom-2 right-0 w-2 cursor-e-resize' :
          edge === 'w' ? 'top-2 bottom-2 left-0 w-2 cursor-w-resize' :
          edge === 'ne' ? 'top-0 right-0 w-3 h-3 cursor-ne-resize' :
          edge === 'nw' ? 'top-0 left-0 w-3 h-3 cursor-nw-resize' :
          edge === 'se' ? 'bottom-0 right-0 w-3 h-3 cursor-se-resize' :
                          'bottom-0 left-0 w-3 h-3 cursor-sw-resize'
        return (
          <div
            key={edge}
            className={cn('absolute z-10', pos)}
            onPointerDown={(e) => startResize(edge, e)}
          />
        )
      })}
    </div>
  )
}
