// bitfield/packages/screen-arrangement/arrangers/freeform-arranger.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Spatial canvas arranger for floating/free-form window layouts.
// Uses the local graph interaction primitive for pan/zoom/camera ownership
// while preserving Society features: window resize handles, z-ordering, tab
// drops, and floating window management.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. FreeformArranger props interface unchanged (LayoutEngine compatibility)
// 2. Local graph interaction state is SSOT for camera/pan/zoom interaction
// 3. Window drag/resize still use pointer event handlers (not GraphCanvas drag)
// 4. FloatingWindowContext preserved (container-header.tsx dependency)
//
// =============================================================================

'use client'

import React from 'react'
import { m as motion } from 'framer-motion'
import { MotionFeatures } from '../../ui/motion/lazy-motion'
import { cn } from '../../ui/show/cn'
import { DRAGGING_CONTAINER_BORDER, FOCUSED_CONTAINER_BORDER } from './container-selection-look'
import { LayoutActionsContext, LayoutStateContext, TabDragContext } from './screen-arrangement-context'
import { GraphCanvas } from '../../graph-canvas/show/GraphCanvas'
import type { CanvasNodeFrame } from '../../graph-canvas/show/types'
import { useGraphCanvas } from '../../graph-canvas/show/use-graph-canvas'
import type { TabMeta } from '../read-data/layout-types'
import {
  readPlaceableSurfaceTabOrAdmitEntry,
  type PlaceableSurfaceAdmissionSurface,
} from './placeable-surface-drag'
import { RegionDropRouter } from '../../ui'
import { VisualLayerStack, createCapabilityMap, builtinVisualLayerCapabilities } from '../../ui/show/visual-layer-stack'
import { canvasRegion, containerRegion, regionAddressKey } from '../read-data/region-address'
import { regionZoneVisible } from '../read-data/region-chrome'
import { nodeRefAttr } from './node-menu-controller'
import { useVisualLayerSubjectResolver, appendRegionLayer } from './visual-layer-runtime'
import { buildRegionDropIntents, isArrangementSurfaceDrag } from './region-drop-intents'

import { FloatingWindowContext } from './floating-window-context'
export { FloatingWindowContext }

/** ===================== Types ===================== */

export type FreeformRect = { x: number; y: number; w: number; h: number }
export type FreeformWin = FreeformRect & { z: number }
export type FrameEdge = 'left' | 'right' | 'top' | 'bottom'
export type FreeformPlacementPayload =
  | { kind: 'tab'; tabId: string }
  | { kind: 'surface'; tab: TabMeta }

type WindowsMap = Record<string, FreeformWin>

/**
 * Props the engine must supply to the freeform arranger.
 * NOTE: This arranger is content-agnostic. It just boxes + positions.
 */
type Props = {
  /** Map of containerId -> { x, y, w, h, z } (pixels relative to this arranger) */
  windows: WindowsMap

  /** Camera for zoom/pan */
  camera: { scale: number; tx: number; ty: number; min?: number; max?: number }

  /** Optional: set a specific container as visually focused (adds glow) */
  focusedContainerId?: string | null

  /** Bring a window to front (engine should bump `z`) */
  onBringToFront: (containerId: string) => void

  /** Move a window to an absolute position (engine mutates state) */
  onMove: (containerId: string, xy: { x: number; y: number }) => void

  /** Resize/move a window to a rect (engine mutates state) */
  onResize: (containerId: string, rect: FreeformRect) => void

  /** Called when a drag/resize operation ends (for persistence) */
  onDragEnd?: () => void

  /** Camera change callback for zoom/pan */
  onCameraChange?: (patch: Partial<{ scale: number; tx: number; ty: number }>) => void

  /** Published admission surfaces for generic browser/OS data-transfer drops */
  placeableSurfaces?: readonly PlaceableSurfaceAdmissionSurface[]

  /**
   * Create a new floating container at a point when user drops a tab
   * in empty space. The engine should:
   *   - create containerId with given rect (default if `rect` omitted)
   *   - place the tab payload into that container's content
   */
  createContainerAt: (
    xy: { x: number; y: number },
    payload: FreeformPlacementPayload,
    rect?: Partial<FreeformRect>
  ) => Promise<void>

  /**
   * Render the content for a containerId (usually <ContainerHost id={...} />).
   * This arranger never special-cases content; it just calls this.
   */
  renderContainer: (containerId: string) => React.ReactNode

  /**
   * Optional grid/snap config
   * - grid: snap window top-left while moving (pixels). 0/undefined = no snap.
   * - boundsPadding: keep windows inside with this padding. Default 8.
   * - minSize: minimal w/h (default { w: 240, h: 160 })
   */
  options?: {
    grid?: number
    boundsPadding?: number
    minSize?: { w: number; h: number }
    defaultDropSize?: { w: number; h: number }
    clamp?: 'none' | 'viewport'
  }
}

/** ===================== Arranger ===================== */

function FreeformArrangerMoving({
  windows,
  camera,
  focusedContainerId,
  onBringToFront,
  onMove,
  onResize,
  onDragEnd,
  onCameraChange,
  placeableSurfaces = [],
  createContainerAt,
  renderContainer,
  options
}: Props) {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const tabDrag = React.useContext(TabDragContext)
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)

  const boundsPad = options?.boundsPadding ?? 8
  const minW = options?.minSize?.w ?? 240
  const minH = options?.minSize?.h ?? 160
  const defDropW = options?.defaultDropSize?.w ?? 360
  const defDropH = options?.defaultDropSize?.h ?? 240

  /** Track tab ghost rect while dragging a tab over empty space */
  const [tabGhost, setTabGhost] = React.useState<{ x: number; y: number; w: number; h: number } | null>(null)

  /** Convert client coords to local coords of arranger surface */
  const toLocal = React.useCallback((clientX: number, clientY: number) => {
    const el = rootRef.current
    const safeClientX = Number.isFinite(clientX) ? clientX : 0
    const safeClientY = Number.isFinite(clientY) ? clientY : 0
    if (!el) return { x: safeClientX, y: safeClientY }
    const r = el.getBoundingClientRect()
    return { x: safeClientX - r.left, y: safeClientY - r.top }
  }, [])

  /** Keep a tab ghost near the cursor and inside bounds */
  const placeGhost = React.useCallback((clientX: number, clientY: number) => {
    const { x, y } = toLocal(clientX, clientY)
    const el = rootRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const w = defDropW
    const h = defDropH
    const clampedX = Math.max(boundsPad, Math.min(x - w / 2, r.width - w - boundsPad))
    const clampedY = Math.max(boundsPad, Math.min(y - h / 2, r.height - h - boundsPad))
    setTabGhost({ x: clampedX, y: clampedY, w, h })
  }, [toLocal, boundsPad, defDropW, defDropH])

  /** Open a dropped surface/file as a new floating window at the drop point. */
  const openSurfaceAtPoint = React.useCallback(async (dataTransfer: DataTransfer, clientX: number, clientY: number) => {
    const surfaceTab = readPlaceableSurfaceTabOrAdmitEntry(dataTransfer, placeableSurfaces)
    if (!surfaceTab) return false
    const { x, y } = toLocal(clientX, clientY)
    const el = rootRef.current
    if (!el) return false
    const r = el.getBoundingClientRect()
    const w = defDropW, h = defDropH
    const clampedX = Math.max(boundsPad, Math.min(x - w / 2, r.width - w - boundsPad))
    const clampedY = Math.max(boundsPad, Math.min(y - h / 2, r.height - h - boundsPad))
    await createContainerAt({ x: clampedX, y: clampedY }, { kind: 'surface', tab: surfaceTab }, { w, h })
    setTabGhost(null)
    tabDrag?.setOverContainerId?.(null)
    return true
  }, [placeableSurfaces, toLocal, defDropW, defDropH, boundsPad, createContainerAt, tabDrag])

  /** Background accepts tab-reorder drops (create new floating container). */
  const bgDragHandlers = {
    onDragOver: (e: React.DragEvent) => {
      const isTab = e.dataTransfer.types.includes('application/x-tab-id')
      const isSurface = isArrangementSurfaceDrag(e.dataTransfer)
      if (isTab || isSurface) {
        e.preventDefault()
        e.dataTransfer.dropEffect = isTab ? 'move' : 'copy'
        // Ghost only for a tab reorder; file/surface drops are routed by the
        // RegionDropRouter, which renders its own zones.
        if (isTab) placeGhost(e.clientX, e.clientY)
        tabDrag?.setOverContainerId?.('frame')
        tabDrag?.setEdgeHover?.(null)
      }
    },
    onDragLeave: () => {
      setTabGhost(null)
      tabDrag?.setOverContainerId?.(null)
    },
    onDrop: async (e: React.DragEvent) => {
      // File/surface drops are owned by the RegionDropRouter. Only a tab reorder
      // (create a floating window from a dragged tab) is handled here.
      const isTab = e.dataTransfer.types.includes('application/x-tab-id')
      if (!isTab) return
      e.preventDefault()
      const tabId = e.dataTransfer.getData('application/x-tab-id')
      const { x, y } = toLocal(e.clientX, e.clientY)
      const el = rootRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const w = defDropW, h = defDropH
      const clampedX = Math.max(boundsPad, Math.min(x - w / 2, r.width - w - boundsPad))
      const clampedY = Math.max(boundsPad, Math.min(y - h / 2, r.height - h - boundsPad))
      await createContainerAt({ x: clampedX, y: clampedY }, { kind: 'tab', tabId }, { w, h })
      setTabGhost(null)
      tabDrag?.setDraggingTabId?.(null)
      tabDrag?.setOverContainerId?.(null)
    }
  }

  // The canvas region's drop intents: a surface dragged out of a screen opens as a window at the drop point
  // (default); a picture from the computer dropped on the empty canvas, off every window, becomes its background.
  const canvasDropIntents = buildRegionDropIntents({
    region: canvasRegion(),
    openAsTab: (drop) => openSurfaceAtPoint(drop.dataTransfer, drop.clientX, drop.clientY),
    setBackground: (descriptor) => {
      if (!layoutState || !layoutActions) return
      appendRegionLayer(layoutState, layoutActions.applyLayoutState, canvasRegion(), descriptor)
    },
  })

  /** Convert windows map to CanvasNodeFrame for GraphCanvas */
  const nodes = React.useMemo(() => {
    return Object.entries(windows).map(([id, win]) => ({
      id,
      x: win.x,
      y: win.y,
      width: win.w,
      height: win.h,
    } as CanvasNodeFrame))
  }, [windows])

  const canvasEngineRef = React.useRef<HTMLDivElement>(null)
  const {
    camera: graphCamera,
    selectedNodeId: graphSelectedNodeId,
    selectNode: graphSelectNode,
    draggedNodeId: graphDraggedNodeId,
    zoomToFit: graphZoomToFit,
    startCanvasPan,
  } = useGraphCanvas({
    nodes,
    canvasRef: canvasEngineRef,
    initialCamera: {
      zoom: camera?.scale ?? 1,
      pan_x: camera?.tx ?? 0,
      pan_y: camera?.ty ?? 0,
    },
    onCameraChange: React.useCallback((cam) => {
      onCameraChange?.({ scale: cam.zoom, tx: cam.pan_x, ty: cam.pan_y })
    }, [onCameraChange]),
    enableNodeDrag: false,
  })

  /** GraphCanvas renderNode callback */
  const renderNode = React.useCallback(
    (node: CanvasNodeFrame) => {
      const win = windows[node.id]
      if (!win) return null
      return (
        <FreeformWindow
          key={node.id}
          id={node.id}
          win={win}
          focused={focusedContainerId === node.id}
          onBringToFront={onBringToFront}
          onMove={(xy) => onMove(node.id, xy)}
          onResize={(rect) => onResize(node.id, rect)}
          onDragEnd={onDragEnd}
          render={() => renderContainer(node.id)}
          boundsGetter={() => rootRef.current?.getBoundingClientRect() ?? null}
          options={{ grid: options?.grid, boundsPad, minW, minH, clamp: options?.clamp }}
          scale={graphCamera.zoom}
        />
      )
    },
    [windows, focusedContainerId, onBringToFront, onMove, onResize, onDragEnd, renderContainer, graphCamera.zoom, boundsPad, minW, minH, options]
  )

  // Canvas-region wallpaper: an authored layer stack painted behind the nodes,
  // parallaxing with the camera. Absent = today's look (neutral surface) — zero
  // regression. Image/video/dot-grid all arrive as DATA in this stack.
  const canvasStack = layoutState?.visualLayerStacks?.[regionAddressKey(canvasRegion())]
  const canvasSubjectResolver = useVisualLayerSubjectResolver(canvasStack?.layers ?? [])
  const canvasUnderlay = canvasStack && canvasStack.layers.length > 0 ? (
    <VisualLayerStack
      region={canvasRegion()}
      layers={canvasStack.layers}
      map={createCapabilityMap(builtinVisualLayerCapabilities)}
      resolveSubject={canvasSubjectResolver}
      camera={{ panX: graphCamera.pan_x, panY: graphCamera.pan_y, zoom: graphCamera.zoom }}
    />
  ) : null

  return (
    <div
      ref={rootRef}
      className="relative flex-1 h-full overflow-hidden min-h-0 min-w-0"
      data-arranger="freeform"
      data-node-ref={nodeRefAttr(canvasRegion())}
      {...bgDragHandlers}
    >
      {/* GraphCanvas renders nodes while the local graph hook owns camera/pan interaction */}
      <RegionDropRouter region={canvasRegion()} intents={canvasDropIntents}>
      <GraphCanvas
        underlay={canvasUnderlay}
        nodes={nodes}
        renderNode={renderNode}
        emptyState={null}
        camera={graphCamera}
        selectedNodeId={graphSelectedNodeId}
        draggedNodeId={graphDraggedNodeId}
        selectNode={graphSelectNode}
        zoomToFit={graphZoomToFit}
        canvasRef={canvasEngineRef}
        onCanvasPointerDown={(e) => {
          const target = e.target as HTMLElement
          if (!target.closest('[data-graph-node]')) {
            startCanvasPan(e.clientX, e.clientY)
          }
        }}
      />
      </RegionDropRouter>

      {/* Tab drop ghost (screen-space overlay) */}
      {tabGhost && (
        <div
          className="pointer-events-none absolute rounded-xl border-2 border-dashed border-[var(--border-focus)] bg-[var(--glass-bg-subtle)] backdrop-blur-sm"
          style={{ left: tabGhost.x, top: tabGhost.y, width: tabGhost.w, height: tabGhost.h, zIndex: 10_000 }}
        />
      )}
    </div>
  )
}

/** ===================== Window ===================== */

type WinProps = {
  id: string
  win: FreeformWin
  focused: boolean
  onBringToFront: (id: string) => void
  onMove: (xy: { x: number; y: number }) => void
  onResize: (rect: FreeformRect) => void
  onDragEnd?: () => void
  render: () => React.ReactNode
  boundsGetter: () => DOMRect | null
  options: { grid?: number; boundsPad: number; minW: number; minH: number; clamp?: 'none' | 'viewport' }
  scale: number
}

function FreeformWindow({
  id,
  win,
  focused,
  onBringToFront,
  onMove,
  onResize,
  onDragEnd,
  render,
  boundsGetter,
  options,
  scale
}: WinProps) {
  const { grid, boundsPad, minW, minH } = options
  const divRef = React.useRef<HTMLDivElement>(null)

  // Region-effective chrome: an immersive region ({'':false}) drops its floating
  // window frame too, so a freeform immersive container shows only its surface
  // (note #33, category-complete across all arrangers). Absent = framed.
  const layoutState = React.useContext(LayoutStateContext)
  const frameVisible = regionZoneVisible(layoutState?.chrome, layoutState?.regionChrome, containerRegion(id), 'container.frame')

  // Live rect tracked in a ref — mutated directly during drag/resize (no React renders).
  // Committed to the layout owner only on pointer-up.
  const liveRect = React.useRef<FreeformRect>({ x: win.x, y: win.y, w: win.w, h: win.h })
  const activeOp = React.useRef<{ kind: 'drag' | 'resize'; edge?: ResizeEdge } | null>(null)
  const startRef = React.useRef<{ x: number; y: number; base: FreeformRect } | null>(null)

  // Sync liveRect from props when NOT actively dragging (owner-fed snapshot changed externally)
  if (!activeOp.current) {
    liveRect.current = { x: win.x, y: win.y, w: win.w, h: win.h }
  }

  /** Clamp & snap a rect to bounds + grid */
  const clampRect = (rect: FreeformRect) => {
    const b = boundsGetter()
    if (options.clamp === 'none' || !b) {
      const w = Math.max(minW, rect.w)
      const h = Math.max(minH, rect.h)
      let x = rect.x, y = rect.y
      if (grid && grid > 0) { x = Math.round(x / grid) * grid; y = Math.round(y / grid) * grid }
      return { x, y, w, h }
    }
    const w = Math.max(minW, Math.min(rect.w, b.width - 2 * boundsPad))
    const h = Math.max(minH, Math.min(rect.h, b.height - 2 * boundsPad))
    let x = Math.max(boundsPad, Math.min(rect.x, b.width - w - boundsPad))
    let y = Math.max(boundsPad, Math.min(rect.y, b.height - h - boundsPad))
    if (grid && grid > 0) { x = Math.round(x / grid) * grid; y = Math.round(y / grid) * grid }
    return { x, y, w, h }
  }

  /** Apply rect directly to the DOM element — zero React overhead.
   *  CanvasNode already positions the window at (win.x, win.y) via transform,
   *  so left/top are DELTA from the CanvasNode origin. */
  const applyToDOM = (rect: FreeformRect) => {
    const el = divRef.current
    if (!el) return
    el.style.left = `${rect.x - win.x}px`
    el.style.top = `${rect.y - win.y}px`
    el.style.width = `${rect.w}px`
    el.style.height = `${rect.h}px`
  }

  React.useLayoutEffect(() => {
    if (activeOp.current) return
    const el = divRef.current
    if (!el) return
    el.style.left = '0px'
    el.style.top = '0px'
    el.style.width = `${win.w}px`
    el.style.height = `${win.h}px`
  }, [win.x, win.y, win.w, win.h])

  /** Header/drag surface handlers (move window) */
  const onHeaderPointerDown = (e: React.PointerEvent) => {
    try { (e.currentTarget as HTMLElement)?.setPointerCapture?.(e.pointerId) } catch {}
    activeOp.current = { kind: 'drag' }
    startRef.current = { x: e.clientX, y: e.clientY, base: { ...liveRect.current } }
    onBringToFront(id)
    // Kill CSS transitions during drag for instant feedback
    if (divRef.current) divRef.current.style.transition = 'none'
    bindListeners()
  }

  const startResize = (edge: ResizeEdge, e: React.PointerEvent) => {
    activeOp.current = { kind: 'resize', edge }
    startRef.current = { x: e.clientX, y: e.clientY, base: { ...liveRect.current } }
    onBringToFront(id)
    if (divRef.current) divRef.current.style.transition = 'none'
    bindListeners()
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!startRef.current || !activeOp.current) return
    const dx = (e.clientX - startRef.current.x) / scale
    const dy = (e.clientY - startRef.current.y) / scale

    if (activeOp.current.kind === 'drag') {
      const rect = clampRect({
        x: startRef.current.base.x + dx,
        y: startRef.current.base.y + dy,
        w: startRef.current.base.w,
        h: startRef.current.base.h,
      })
      liveRect.current = rect
      applyToDOM(rect)
      return
    }

    if (activeOp.current.kind === 'resize' && activeOp.current.edge) {
      const next = applyResizeGeom(activeOp.current.edge, startRef.current.base, dx, dy, minW, minH)
      const rect = clampRect(next)
      liveRect.current = rect
      applyToDOM(rect)
    }
  }

  const onPointerUp = () => {
    const op = activeOp.current
    activeOp.current = null
    // Restore CSS transitions
    if (divRef.current) divRef.current.style.transition = ''

    if (!op) return

    // Single commit to the layout owner snapshot
    const r = liveRect.current
    if (op.kind === 'drag') {
      onMove({ x: r.x, y: r.y })
    } else {
      onResize(r)
    }

    startRef.current = null
    onDragEnd?.()
    unbindListeners()
  }

  // Bind/unbind window listeners imperatively (no React effect re-subscription)
  const listenersRef = React.useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null)

  const bindListeners = () => {
    if (listenersRef.current) return // already bound
    const move = (e: PointerEvent) => onPointerMove(e)
    const up = () => onPointerUp()
    listenersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const unbindListeners = () => {
    if (!listenersRef.current) return
    window.removeEventListener('pointermove', listenersRef.current.move)
    window.removeEventListener('pointerup', listenersRef.current.up)
    listenersRef.current = null
  }

  // Cleanup on unmount
  React.useEffect(() => () => unbindListeners(), [])

  const isDragging = activeOp.current?.kind === 'drag'
  // The same focused look as tiles (container-selection-look.ts), never a fixed colour.
  const borderGlow = focused ? FOCUSED_CONTAINER_BORDER : 'border-[var(--border-primary)] hover:border-[var(--border-secondary)]'

  return (
    <div
      ref={divRef}
      className={cn(
        'absolute flex flex-col',
        frameVisible && 'rounded-xl border bg-[var(--glass-bg-primary)] backdrop-blur-md shadow-[0_0_20px_rgba(0,0,0,0.2)]',
        isDragging ? DRAGGING_CONTAINER_BORDER : 'cursor-default',
        frameVisible && borderGlow
      )}
      style={{ left: 0, top: 0, width: win.w, height: win.h, zIndex: win.z }}
      data-floating-window={id}
      data-container-id={id}
      data-pane-id={id}
      onMouseDown={() => onBringToFront(id)}
    >
      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <FloatingWindowContext.Provider value={{
          onStartDrag: (containerId, e) => {
            if (containerId === id) onHeaderPointerDown(e)
          }
        }}>
          {render()}
        </FloatingWindowContext.Provider>
      </div>

      {/* Resize handles (8) */}
      <ResizeHandle edge="n"  onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="s"  onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="e"  onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="w"  onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="ne" onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="nw" onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="se" onStart={(edge, e) => startResize(edge, e)} />
      <ResizeHandle edge="sw" onStart={(edge, e) => startResize(edge, e)} />
    </div>
  )
}

/** ===================== Resize Handles ===================== */

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

function ResizeHandle({ edge, onStart }: { edge: ResizeEdge; onStart: (edge: ResizeEdge, e: React.PointerEvent) => void }) {
  const posCls =
    edge === 'n'  ? 'top-0 left-2 right-2 h-2 cursor-n-resize' :
    edge === 's'  ? 'bottom-0 left-2 right-2 h-2 cursor-s-resize' :
    edge === 'e'  ? 'right-0 top-2 bottom-2 w-2 cursor-e-resize' :
    edge === 'w'  ? 'left-0 top-2 bottom-2 w-2 cursor-w-resize' :
    edge === 'ne' ? 'right-0 top-0 w-3 h-3 cursor-ne-resize' :
    edge === 'nw' ? 'left-0 top-0 w-3 h-3 cursor-nw-resize' :
    edge === 'se' ? 'right-0 bottom-0 w-3 h-3 cursor-se-resize' :
                    'left-0 bottom-0 w-3 h-3 cursor-sw-resize'

  return (
    <div
      className={cn('absolute z-10', posCls)}
      onPointerDown={(e) => {
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch {}
        onStart(edge, e)
      }}
    >
      {/* visible rails/knobs */}
      <motion.div
        className={cn(
          'absolute bg-[var(--glass-bg-subtle)]0 rounded',
          edge === 'n' || edge === 's'
            ? 'left-1/2 -translate-x-1/2 w-1 h-full'
            : edge === 'e' || edge === 'w'
            ? 'top-1/2 -translate-y-1/2 h-1 w-full'
            : 'inset-0'
        )}
        initial={false}
        animate={{ opacity: 0.0 }}
        whileHover={{ opacity: 0.8 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
      />
    </div>
  )
}

/** ===================== Geometry helpers ===================== */

function applyResizeGeom(
  edge: ResizeEdge,
  base: FreeformRect,
  dx: number,
  dy: number,
  minW: number,
  minH: number
): FreeformRect {
  let { x, y, w, h } = base

  const clampW = (val: number) => Math.max(minW, val)
  const clampH = (val: number) => Math.max(minH, val)

  switch (edge) {
    case 'e': w = clampW(w + dx); break
    case 's': h = clampH(h + dy); break
    case 'w': {
      const nx = x + dx
      const nw = clampW(w - dx)
      // If clamping reduced more than allowed, adjust x accordingly
      if (nw === minW && dx > 0) {
        x = x + (w - minW)
        w = minW
      } else {
        x = nx
        w = nw
      }
      break
    }
    case 'n': {
      const ny = y + dy
      const nh = clampH(h - dy)
      if (nh === minH && dy > 0) {
        y = y + (h - minH)
        h = minH
      } else {
        y = ny
        h = nh
      }
      break
    }
    case 'ne': {
      // east + north
      const ny = y + dy
      const nh = clampH(h - dy)
      if (nh === minH && dy > 0) {
        y = y + (h - minH)
        h = minH
      } else {
        y = ny
        h = nh
      }
      w = clampW(w + dx)
      break
    }
    case 'nw': {
      // west + north
      const nx = x + dx
      const ny = y + dy
      const nh = clampH(h - dy)
      const nw = clampW(w - dx)

      if (nw === minW && dx > 0) {
        x = x + (w - minW)
        w = minW
      } else {
        x = nx
        w = nw
      }

      if (nh === minH && dy > 0) {
        y = y + (h - minH)
        h = minH
      } else {
        y = ny
        h = nh
      }
      break
    }
    case 'se': {
      w = clampW(w + dx)
      h = clampH(h + dy)
      break
    }
    case 'sw': {
      // west + south
      const nx = x + dx
      const nw = clampW(w - dx)

      if (nw === minW && dx > 0) {
        x = x + (w - minW)
        w = minW
      } else {
        x = nx
        w = nw
      }

      h = clampH(h + dy)
      break
    }
  }

  return { x, y, w, h }
}

// Drawn inside MotionFeatures (ui/motion/lazy-motion.tsx): its motion arrives after the first paint, without remounting.
export default function FreeformArranger(props: React.ComponentProps<typeof FreeformArrangerMoving>) {
  return <MotionFeatures><FreeformArrangerMoving {...props} /></MotionFeatures>
}
