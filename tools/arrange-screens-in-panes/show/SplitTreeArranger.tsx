// src/packages/shell/layout/arrangers/split-tree-arranger.tsx
'use client'

import { reportScreenCommand } from '../../ui/show/action-feedback/action-feedback'
import React from 'react'
import { m as motion } from 'framer-motion'
import { MotionFeatures } from '../../ui/motion/lazy-motion'
import { cn } from '../../ui/show/cn'
import { DRAGGING_CONTAINER_BORDER, FOCUSED_CONTAINER_BORDER } from './container-selection-look'
import { usePrefersReducedMotion } from '../../ui/show/use-media-query/use-media-query'
import { ArrangementHostDataContext, ArrangementStageContext, DragContext, TabDragContext, LayoutStateContext } from './screen-arrangement-context'
import type { LeafNode, SplitNode, SplitTreeNode, TabMeta } from '../read-data/layout-types'
import { chromeZoneVisible } from '../read-data/chrome-visibility'
import { regionZoneVisible, zoneControl } from '../read-data/region-chrome'
import { containerRegion } from '../read-data/region-address'
import { isPaneDragTarget, TAB_EDGE_DROP_PX } from './region-drop-intents'
import { layoutBoundsWithin } from './layout-bounds'
import { controlShown } from '../../ui/show/show-rules/show-of'
import { isOverSelectedRecordDropOwner } from '../../ui/show/selection'
import { hasPlaceableSurface, readPlaceableSurfaceTab } from './placeable-surface-drag'
import { ArrangementNavigator } from './ArrangementNavigator'
import { useSwitchLayoutPastEdge } from './continuous-layout-navigation'
import { clampArrangementZoom } from './arrangement-zoom'
import { bindArrangementCanvasGestures } from './canvas-gestures'
import { ContainerSizeRegion } from '../../ui/show/container-size'
import { placeSeamSlot, seamMark, SEAM_MARK, useSeamClaims, type SeamClaim } from '../../ui/show/seam-slots'
import { dockSeamKey } from '../../ui/show/dockable-placement/dockable-placement'
import {
  minUsableContainerHeightPx,
  minUsableContainerWidthPx,
  paneCutFadePx,
  paneDragMinimumPx,
  draggablePaneMinimumPx,
  minimumSplitTreeSize,
  drawnSplitTree,
  paneCrossPx,
  renderablePanePx,
  renderableSplitShare,
  fittedContentLengthPx,
  resizePaneInStage,
  splitSizeUnit,
} from './split-tree-constraints'
import { arrowPanePx, paneSizesNow, snapPanePx } from '../read-data/pane-sizes'
import { usePaneSizes } from './use-pane-sizes'
import { LocalSurfaceVisibilityContext } from './embedded-surface-content'
import { containerIsVisible, visibleSplitTree } from '../read-data/surface-visibility'

const TAB_EDGE_PX = TAB_EDGE_DROP_PX // widen container-edge activation
// FRAME_EDGE_PX = 32 — reserved for frame-edge drop zone logic (wired later)

/** ========== Types (Arranger-side) ========== */
export type FrameEdge = 'left' | 'right' | 'top' | 'bottom'

// A drop on a pane's edge splits it: control `arrangement.split`, which a show rule can hide (region-chrome zoneControl).
function paneEdgeAt(element: HTMLElement, clientX: number, clientY: number): FrameEdge | null {
  if (!controlShown(zoneControl('split'))) return null
  const r = element.getBoundingClientRect()
  const x = clientX - r.left, y = clientY - r.top
  if (x < 0 || y < 0 || x > r.width || y > r.height) return null
  if (x <= TAB_EDGE_PX) return 'left'
  if (r.width - x <= TAB_EDGE_PX) return 'right'
  if (y <= TAB_EDGE_PX) return 'top'
  if (r.height - y <= TAB_EDGE_PX) return 'bottom'
  return null
}

export type DropTarget =
  | { kind: 'frame-edge'; edge: FrameEdge }
  | { kind: 'container-edge'; containerId: string; edge: FrameEdge }
  | { kind: 'split-gutter'; dir: 'row' | 'column'; beforeId: string; afterId: string }

export type SurfacePlacementPayload =
  | { kind: 'tab'; tabId: string }
  | { kind: 'surface'; tab: TabMeta }

type PaneEntryOrigin = 'left' | 'right' | 'top' | 'bottom'

/** ========== Props expected by the Arranger (engine supplies these) ========== */
type Props = {
  /** The split-tree to render (leaves reference containers) */
  root: SplitTreeNode
  /** Which container is focused (others will dim). Pass null/undefined for normal mode */
  focusedContainerId?: string | null
  /** Disable edge UI when frame edges are active */
  disableEdgeUI?: boolean
  /**
   * This arranger holds the window's panes: it marks its seams and lays a slot on a seam something claims
   * (ui/show/seam-slots). Ignored inside a screen's own arrangement, which never takes the window's things.
   */
  windowSeams?: boolean

  /** Structural ops: emitted when a container drag is dropped on a target */
  onDropTarget: (t: DropTarget) => void
  /** Optional: center-drop swap for container↔container when no edge/gutter drop was chosen */
  onSwapContainers?: (a: string, b: string) => void
  /** Handle tab drops into container center (move tab to existing container) */
  onDropTabIntoContainer?: (containerId: string, tabId: string) => Promise<void> | void
  /** Handle tab drops at container edge (create new container and move tab there) */
  onDropTabAtContainerEdge?: (containerId: string, edge: FrameEdge, tabId: string) => Promise<void> | void
  /** Handle placeable surface drops at container edge (create new container with new surface tab) */
  onDropSurfaceAtContainerEdge?: (containerId: string, edge: FrameEdge, tab: TabMeta) => Promise<void> | void

  /**
   * A pane's edge was dragged. `sizesPx` is every child of the split at `path`,
   * in zoom-independent layout pixels, with only the dragged pane changed. The
   * engine records them as that split's pixel sizes; the arranger stays pure.
   */
  onResize: (path: number[], sizesPx: number[]) => void
  /**
   * A pane's own length across its split was dragged (its height in a row, its width in a stack): the child at
   * `index` of the split at `path`, in layout pixels, or null when it fills the split again.
   */
  onResizeCross?: (path: number[], index: number, lengthPx: number | null) => void

  /**
   * Creating a NEW container from a tab drag:
   * - frame edges
   * - split gutters
   * The engine implements these to create a new container and place the tab payload.
   */
  splitAtFrameEdge: (
    edge: FrameEdge,
    payload: SurfacePlacementPayload,
    opts?: { optimistic?: boolean }
  ) => Promise<void>

  splitBetween: (
    dir: 'row' | 'column',
    beforeId: string,
    afterId: string,
    payload: SurfacePlacementPayload
  ) => Promise<void>

  /** Renderer for a container's contents (usually your ContainerHost) */
  renderContainer: (containerId: string) => React.ReactNode
}

/** ========== Helpers ========== */
function isLeaf(n: SplitTreeNode): n is LeafNode {
  return n.kind === 'leaf'
}

function getLeafId(leaf: LeafNode): string {
  return leaf.containerId
}

export function arrangementCameraSize(width: number, height: number, scale: number) {
  return { layoutWidth: width, layoutHeight: height, paintedWidth: width * scale, paintedHeight: height * scale }
}

/** The smallest canvas the tree needs: the split's own minimum, the same on every screen. */
/** The axes along which no minimum holds a pane: its content's length, or no neighbour to be dragged against. */
type Fitting = 'height' | 'width' | 'both'
function fits(fitting: Fitting | undefined, axis: 'height' | 'width'): boolean {
  return fitting === axis || fitting === 'both'
}
function fittingOf(axes: { width: boolean; height: boolean }): Fitting | undefined {
  return axes.width && axes.height ? 'both' : axes.width ? 'width' : axes.height ? 'height' : undefined
}

function minimumArrangementSize(tree: SplitTreeNode, frameVisible: boolean) {
  return minimumSplitTreeSize(tree, frameVisible ? 4 : 0)
}

function collectLeafIds(n: SplitTreeNode, out: string[] = []): string[] {
  if (isLeaf(n)) {
    const id = getLeafId(n)
    if (id) out.push(id)
    return out
  }
  n.children.forEach((c) => collectLeafIds(c, out))
  return out
}

function splitEntryOrigin(dir: 'row' | 'column', index: number): PaneEntryOrigin {
  if (dir === 'row') return index === 0 ? 'right' : 'left'
  return index === 0 ? 'bottom' : 'top'
}

function paneEntryOrigins(root: SplitTreeNode): Map<string, PaneEntryOrigin> {
  const origins = new Map<string, PaneEntryOrigin>()
  const visit = (node: SplitTreeNode) => {
    if (node.kind === 'leaf') return
    node.children.forEach((child, index) => {
      if (child.kind === 'leaf' && child.containerId) {
        origins.set(child.containerId, splitEntryOrigin(node.dir, index))
      } else {
        visit(child)
      }
    })
  }
  visit(root)
  return origins
}

/**
 * The angle a new pane's reveal sweeps across it: away from the pane it was
 * split from, tilted, so it reads as sliding out from under that pane.
 */
function paneRevealAngle(origin: PaneEntryOrigin | null): number {
  if (origin === 'right') return 285
  if (origin === 'top') return 195
  if (origin === 'bottom') return 15
  return 105
}

/**
 * A soft-edged band that uncovers the pane as `--pane-reveal` runs 0% to 100%:
 * hidden at the start, fully shown at the end, a 40% feathered edge between.
 */
function paneRevealMask(origin: PaneEntryOrigin | null): string {
  return `linear-gradient(${paneRevealAngle(origin)}deg, #000 calc(var(--pane-reveal) * 1.4 - 40%), transparent calc(var(--pane-reveal) * 1.4))`
}

const PANE_REVEAL_FROM = { '--pane-reveal': '0%', filter: 'blur(12px)', opacity: 0.35 } as Record<string, string | number>
const PANE_REVEAL_TO = { '--pane-reveal': '100%', filter: 'blur(0px)', opacity: 1 } as Record<string, string | number>

function subtreeRect(ids: string[], scope: ParentNode = document): DOMRect | null {
  const rects: DOMRect[] = []
  for (const id of ids) {
    const el = scope.querySelector<HTMLElement>(`[data-container-id="${id}"]`)
    if (!el) continue
    rects.push(el.getBoundingClientRect())
  }
  if (!rects.length) return null
  const l = Math.min(...rects.map(r => r.left))
  const t = Math.min(...rects.map(r => r.top))
  const r = Math.max(...rects.map(r => r.right))
  const b = Math.max(...rects.map(r => r.bottom))
  const w = r - l, h = b - t
  return { x: l, y: t, left: l, top: t, right: r, bottom: b, width: w, height: h, toJSON(){return this as any} } as DOMRect
}

function rectSignature(rect: DOMRect | null): string {
  if (!rect) return 'null'
  return [
    rect.left,
    rect.top,
    rect.width,
    rect.height,
  ].map((value) => Math.round(value * 100) / 100).join(':')
}

function guttersSignature(
  gutters: Array<{ key: string; dir: 'row'|'column'; beforeId: string; afterId: string; rect: DOMRect }>
): string {
  return gutters
    .map((g) => [
      g.key,
      g.dir,
      g.beforeId,
      g.afterId,
      rectSignature(g.rect),
    ].join('|'))
    .join('||')
}

/** ========== Arranger ========== */
function SplitTreeArrangerMoving({
  root: savedRoot,
  focusedContainerId,
  disableEdgeUI,
  onDropTarget,
  onSwapContainers,
  onDropTabIntoContainer,
  onDropTabAtContainerEdge,
  onDropSurfaceAtContainerEdge,
  onResize,
  onResizeCross = () => {},
  splitAtFrameEdge,
  splitBetween,
  renderContainer,
  windowSeams = false,
}: Props) {
  // Pane sizes are the person's (use-pane-sizes.ts): a change there redraws every pane's minimum at once.
  usePaneSizes()
  const viewportRef = React.useRef<HTMLDivElement>(null)
  // The window's things sit on this arranger's seams only when it holds the window's panes (seam-slots invariant 3).
  const [servesWindow, setServesWindow] = React.useState(false)
  React.useLayoutEffect(() => {
    setServesWindow(windowSeams && !viewportRef.current?.closest('[data-embedded-screen-arrangement]'))
  }, [windowSeams])
  const seamClaims = useSeamClaims()
  const seams = React.useMemo<SeamContextValue>(() => ({
    serves: servesWindow,
    claims: servesWindow ? new Map(seamClaims.map((claim) => [dockSeamKey(claim.seam), claim])) : new Map(),
  }), [servesWindow, seamClaims])
  const [viewportSize, setViewportSize] = React.useState({ width: 0, height: 0 })
  const [viewZoom, setViewZoom] = React.useState(1)
  const effectiveViewZoom = clampArrangementZoom(viewZoom)
  const shouldReduceMotion = usePrefersReducedMotion()
  const currentContainerIds = collectLeafIds(savedRoot)
  const previousContainerIds = React.useRef<string[] | null>(null)
  const enteringContainerIds = new Set(
    previousContainerIds.current === null
      ? []
      : currentContainerIds.filter((id) => !previousContainerIds.current?.includes(id)),
  )
  const entryOrigins = paneEntryOrigins(savedRoot)
  previousContainerIds.current = currentContainerIds
  const viewZoomRef = React.useRef(effectiveViewZoom)
  viewZoomRef.current = effectiveViewZoom
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const measure = () => {
      // clientWidth/clientHeight include padding. The canvas sits inside this
      // padded viewport, so using the full client box adds one padding band's
      // worth of scroll to an otherwise single-row layout.
      const style = window.getComputedStyle(viewport)
      const horizontalPadding = (Number.parseFloat(style.paddingLeft) || 0)
        + (Number.parseFloat(style.paddingRight) || 0)
      const verticalPadding = (Number.parseFloat(style.paddingTop) || 0)
        + (Number.parseFloat(style.paddingBottom) || 0)
      setViewportSize({
        width: Math.max(0, viewport.clientWidth - horizontalPadding),
        height: Math.max(0, viewport.clientHeight - verticalPadding),
      })
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(viewport)
    return () => observer?.disconnect()
  }, [])
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    return bindArrangementCanvasGestures(
      viewport,
      () => viewZoomRef.current,
      (next) => {
        viewZoomRef.current = next
        setViewZoom(clampArrangementZoom(next))
      },
    )
  }, [])
  // After the canvas gestures, so a wheel the canvas takes (zoom) never also switches layouts.
  useSwitchLayoutPastEdge(viewportRef)

  const drag = React.useContext(DragContext)
  const tab = React.useContext(TabDragContext)
  const layoutState = React.useContext(LayoutStateContext)
  const hiddenSurfaces = React.useContext(LocalSurfaceVisibilityContext)
  // The arranger's outer padding + inter-pane gap are CHROME (the visual frame
  // around content) — gated by the same subtractive chrome-visibility map every
  // other zone consults. An immersive view (`chrome:{'':false}`) hides the
  // `surface.frame` zone → no padding, no gap → the content fills edge-to-edge
  // (note #33: "drop a video, I only want the video — no padding/margin/border").
  // Absent map = visible = today's framed editor (zero regression).
  const frameVisible = chromeZoneVisible(layoutState?.chrome, 'surface.frame')
  // Keep the split tree in one layout coordinate system. CSS `zoom` changes
  // layout sizes, so Fit squeezed the panes and even changed the resize floor.
  // The camera scales only the painted canvas; the tree retains its dimensions.
  // The canvas is the stage: panes divide it and scroll inside themselves. Only
  // a pane size the person dragged out (or a row of panes wider than the
  // stage) makes the arrangement scroll.
  // A row that stacks below a width (SplitNode.stackBelow) is drawn as a stack on a narrower stage; a length dragged
  // there is that pane's own height in its saved row, never its width.
  const host = React.useContext(ArrangementHostDataContext)
  const stacksBelow = host.stackRowsThatDoNotFit ? (row: SplitNode) => row.children.length * minUsableContainerWidthPx() : undefined
  const { root, stacked } = drawnSplitTree(savedRoot, viewportSize.width, stacksBelow)
  // The stage the layout owner settles each change against: a row the person places side by side stays so here.
  const stage = React.useContext(ArrangementStageContext)
  if (stage) stage.current = { width: viewportSize.width, ...(stacksBelow ? { stacksBelow } : {}) }
  const onResizeDrawn = (path: number[], sizesPx: number[]) => {
    if (!stacked.has(path.join('.'))) return onResize(path, sizesPx)
    sizesPx.forEach((lengthPx, index) => onResizeCross(path, index, lengthPx))
  }
  const onResizeCrossDrawn = (path: number[], index: number, lengthPx: number | null) => {
    if (!stacked.has(path.join('.'))) onResizeCross(path, index, lengthPx)
  }
  const visibleRoot = layoutState && hiddenSurfaces?.size
    ? visibleSplitTree(root, id => containerIsVisible(layoutState, id, hiddenSurfaces)) : root
  const minimumCanvasSize = visibleRoot ? minimumArrangementSize(visibleRoot, frameVisible) : { width: 0, height: 0 }
  const canvasWidth = Math.max(viewportSize.width, minimumCanvasSize.width)
  const canvasHeight = Math.max(viewportSize.height, minimumCanvasSize.height)
  const cameraSize = arrangementCameraSize(canvasWidth, canvasHeight, effectiveViewZoom)
  const [placeableDragging, setPlaceableDragging] = React.useState(false)
  const showTargets = !!drag?.draggingId || !!tab?.draggingTabId || placeableDragging
  // Prefer container-edge targets over split-gutters, and hide all arranger edge UI
  // when frame-edge UI is active upstream.
  const suppressGutters = !!disableEdgeUI || !!drag?.edgeHover || !!tab?.edgeHover

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-1" data-arrangement-viewport-shell>
      <div
        ref={viewportRef}
        className={cn(
          'relative flex-1 h-full overflow-auto min-h-0 min-w-0',
          frameVisible && 'p-2',
        )}
        data-arranger="split-tree"
        data-arrangement-placing={drag?.draggingId || tab?.draggingTabId || placeableDragging ? 'true' : undefined}
        onDragOverCapture={(event) => {
          if (isOverSelectedRecordDropOwner(event.dataTransfer, event.clientX, event.clientY)) {
            setPlaceableDragging(false)
            return
          }
          if (!hasPlaceableSurface(event.dataTransfer)) return
          setPlaceableDragging(true)
        }}
        onDragLeave={() => setPlaceableDragging(false)}
        // Pane-owned capture handlers stop propagation when they accept a drop.
        // Clear the viewport hint before that handler, including nested owners.
        onDropCapture={() => setPlaceableDragging(false)}
        onDragEnd={() => setPlaceableDragging(false)}
      >
        <div
          className="relative"
          data-arrangement-zoom
          style={{ width: cameraSize.paintedWidth, height: cameraSize.paintedHeight }}
        >
          <div
            data-arrangement-camera
            style={{
              width: cameraSize.layoutWidth,
              height: cameraSize.layoutHeight,
              transform: `scale(${effectiveViewZoom})`,
              transformOrigin: 'top left',
            }}
          >
            <SeamContext.Provider value={seams}>
            <RenderNode
            node={root}
            // Nothing sits beside the whole arrangement, so the stage holds no minimum on either axis.
            fitting="both"
            // Which pane has focus is marked only when there is more than one to tell apart; a lone pane keeps its
            // plain card outline instead of a permanent focus colour.
            focusedContainerId={root.kind === 'split' ? focusedContainerId ?? null : null}
            disableEdgeUI={disableEdgeUI}
            path={[]}
            enteringContainerIds={enteringContainerIds}
            entryOrigins={entryOrigins}
            shouldReduceMotion={shouldReduceMotion}
            onResize={onResizeDrawn}
            onResizeCross={onResizeCrossDrawn}
            renderContainer={renderContainer}
            onDropTarget={onDropTarget}
            onSwapContainers={onSwapContainers}
            onDropTabIntoContainer={onDropTabIntoContainer}
            onDropTabAtContainerEdge={onDropTabAtContainerEdge}
            onDropSurfaceAtContainerEdge={onDropSurfaceAtContainerEdge}
            />
            </SeamContext.Provider>
          </div>
        </div>
      </div>
      {/* Drag targets stay fixed to the visible viewport while the tree scrolls. */}
      {showTargets && (
        <GutterTargets
          root={root}
          viewportRef={viewportRef}
          onDropTarget={onDropTarget}
          splitAtFrameEdge={splitAtFrameEdge}
          splitBetween={splitBetween}
          showGutters={!suppressGutters && (!!drag?.draggingId || placeableDragging)}
        />
      )}
      <ArrangementNavigator
        viewportRef={viewportRef}
        enabled={!showTargets}
        zoom={effectiveViewZoom}
        onZoomChange={(value) => setViewZoom(clampArrangementZoom(value))}
      />
    </div>
  )
}

/**
 * Holds its box (a split's child) at the length of the content it holds along the split: the far edge of the furthest
 * `[data-fits-content]` element inside it (a card that draws at its own height marks itself; one that draws nothing
 * takes no room), or a new pane's length when it holds none. Follows the content as it grows, shrinks or is replaced, so a pane holding a card reads as that
 * card, and a row of cards as tall as its tallest.
 */
function FitsContentLength({ dir }: { dir: 'row' | 'column' }) {
  const ref = React.useRef<HTMLSpanElement>(null)
  const paneSizes = usePaneSizes()
  const contentMinimum = dir === 'column' ? paneSizes.content_minimum_height_px : paneSizes.content_minimum_width_px
  React.useLayoutEffect(() => {
    const box = ref.current?.parentElement
    if (!box) return
    const tall = dir === 'column'
    const watched = new Set<Element>()
    const originalMinimums = new Map<HTMLElement, string>()
    const sizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => later()) : null
    const viewport = box.closest('[data-arranger="split-tree"]')
    // A nested arrangement allocates its own content. Measure its outer host,
    // never reach through its scroller to fit each of its internal panes again.
    const own = (element: Element) => element.closest('[data-arranger="split-tree"]') === viewport
    function measure() {
      // The content's length is its natural length in the pane's own layout, never the length this pass set: a card
      // that fills its pane measured the pane's current size, and each pass added 2px to that size, so it never settled.
      const along = tall ? 'height' : 'width'
      box!.style[along] = ''
      // Inner fitters allocate their pane boxes after their content has drawn. That moves later content without
      // resizing any leaf; watching only the leaves left an outer phone stack at its earlier row height. Follow
      // those independent allocation sizes through the same observer, and stop watching removed descendants.
      const measuring = new Set([...box!.querySelectorAll('[data-fits-content], [data-split-child], [data-arrangement-pane]')].filter(own))
      for (const element of watched) if (!measuring.has(element)) { sizes?.unobserve(element); watched.delete(element) }
      for (const element of measuring) if (!watched.has(element)) { watched.add(element); sizes?.observe(element) }
      let end = 0
      let found = false
      let unmarkedEnd = 0
      box!.querySelectorAll<HTMLElement>('[data-fits-content]').forEach((element) => {
        if (!own(element)) return
        const placed = layoutBoundsWithin(element, box!)
        if (!placed) return
        found = true
        const start = tall ? placed.y : placed.x
        end = Math.max(end, start + (tall ? element.scrollHeight : element.scrollWidth))
      })
      // An automatically fitted subtree can contain another share split. Give each unmarked screen its
      // content-sized minimum before measuring the outer fit, so a 3:2 nested column cannot squeeze its
      // second screen below the shared minimum. A screen with an explicit fit marker owns its natural size;
      // an empty marked card therefore remains zero-height.
      box!.querySelectorAll<HTMLElement>('[data-arrangement-pane]').forEach((pane) => {
        if (!own(pane)) return
        const property = tall ? 'minHeight' : 'minWidth'
        const child = pane.closest<HTMLElement>('[data-split-child]') ?? pane
        if ([...pane.querySelectorAll('[data-fits-content]')].some(own)) {
          for (const element of [child, pane]) {
            const original = originalMinimums.get(element)
            if (original !== undefined) { element.style[property] = original; originalMinimums.delete(element) }
          }
          return
        }
        found = true
        const min = `${contentMinimum}px`
        // Constrain the actual flex child, not only the leaf inside it. That
        // lets flex distribute space after every child's floor, independent
        // of skewed saved weights, rather than growing a giant canvas.
        for (const element of [child, pane]) {
          if (!originalMinimums.has(element)) originalMinimums.set(element, element.style[property])
          if (element.style[property] !== min) element.style[property] = min
        }
        const placed = layoutBoundsWithin(pane, box!)
        if (!placed) return
        const start = tall ? placed.y : placed.x
        // These screens fill their allocated pane and scroll inside it. Their
        // scroll size is not an intrinsic extent: feeding it back plus padding
        // would grow the automatic stack on every observer pass.
        unmarkedEnd = Math.max(unmarkedEnd, start + contentMinimum)
      })
      // A card that draws nothing (a part with nothing to say yet) takes no room; only a pane holding no card at all
      // takes a new pane's length.
      const length = `${Math.max(Math.ceil(unmarkedEnd), fittedContentLengthPx(end, found, tall ? paneSizesNow().added_pane_height_px : paneSizesNow().added_pane_width_px))}px`
      const style = box!.style
      if ((tall ? style.height : style.width) !== length) {
        if (tall) style.height = length
        else style.width = length
      }
    }
    measure()
    let asked = 0
    const later = () => { if (!asked) asked = requestAnimationFrame(() => { asked = 0; measure() }) }
    const added = new MutationObserver(later)
    // Controlled text can change its intrinsic extent without adding a node
    // or resizing its clipped host. Refit on those updates too.
    added.observe(box, { childList: true, characterData: true, subtree: true })
    return () => {
      cancelAnimationFrame(asked); added.disconnect(); sizes?.disconnect(); box.style.removeProperty(tall ? 'height' : 'width')
      for (const [pane, original] of originalMinimums) pane.style[tall ? 'minHeight' : 'minWidth'] = original
    }
  }, [dir, contentMinimum])
  return <span ref={ref} hidden data-fits-content-length />
}

/** ========== Split renderer ========== */
function RenderNode({
  node,
  focusedContainerId,
  disableEdgeUI,
  path,
  enteringContainerIds,
  entryOrigins,
  shouldReduceMotion,
  onResize,
  onResizeCross,
  renderContainer,
  onDropTarget,
  onSwapContainers,
  onDropTabIntoContainer,
  onDropTabAtContainerEdge,
  onDropSurfaceAtContainerEdge,
  fitting,
}: {
  node: SplitTreeNode
  /** The axes no minimum holds here: a child drawn at its content's length, or a pane with no neighbour along that
   *  axis (nobody can drag it smaller there, so its size is the stage's and its screen is never cut). */
  fitting?: Fitting
  focusedContainerId: string | null
  disableEdgeUI?: boolean
  path: number[]
  enteringContainerIds: ReadonlySet<string>
  entryOrigins: ReadonlyMap<string, PaneEntryOrigin>
  shouldReduceMotion: boolean
  onResize: (path: number[], sizesPx: number[]) => void
  onResizeCross: (path: number[], index: number, lengthPx: number | null) => void
  renderContainer: (containerId: string) => React.ReactNode
  onDropTarget: (t: DropTarget) => void
  onSwapContainers?: (a: string, b: string) => void
  onDropTabIntoContainer?: (containerId: string, tabId: string) => Promise<void> | void
  onDropTabAtContainerEdge?: (containerId: string, edge: FrameEdge, tabId: string) => Promise<void> | void
  onDropSurfaceAtContainerEdge?: (containerId: string, edge: FrameEdge, tab: TabMeta) => Promise<void> | void
}) {
  // Pane sizes are the person's (use-pane-sizes.ts): a change there redraws every pane's minimum at once.
  usePaneSizes()
  // The inter-pane gap is frame chrome (same `surface.frame` zone as the
  // arranger's outer padding), hidden for an immersive view (`chrome:{'':false}`).
  // RenderNode is a separate component, so it reads the chrome map from context
  // itself (SSOT — one resolver, no prop-threading).
  const layoutState = React.useContext(LayoutStateContext)
  const hiddenSurfaces = React.useContext(LocalSurfaceVisibilityContext)
  const frameVisible = chromeZoneVisible(layoutState?.chrome, 'surface.frame')
  const shownTree = (tree: SplitTreeNode) => layoutState && hiddenSurfaces?.size
    ? visibleSplitTree(tree, id => containerIsVisible(layoutState, id, hiddenSurfaces)) : tree
  const minSizeFor = (tree: SplitTreeNode) => {
    const shown = shownTree(tree)
    return shown ? minimumArrangementSize(shown, frameVisible) : { width: 0, height: 0 }
  }
  const minimumSize = minSizeFor(node)
  const seams = React.useContext(SeamContext)
  if (!shownTree(node)) return null
  if (node.kind === 'split') {
    const visibleChildCount = node.children.filter(child => shownTree(child)).length
    // Editing reveals conditional pieces. Do not commit partial measurements
    // as saved lengths while a split has temporarily absent children.
    const resizeVisible = chromeZoneVisible(layoutState?.chrome, 'container.resize') && visibleChildCount === node.children.length
    // Every screen draws the saved split as it is, side by side or stacked, with a resize handle after every pane:
    // on a phone too, where a pane can be dragged down to a sliver beside the one in use.
    const isRow = node.dir === 'row'
    const dirCls = isRow ? 'flex-row' : 'flex-col'
    const pixelSizes = splitSizeUnit(node) === 'px'
    // Kept lengths draw every pane at exactly its saved length; the split runs past the window and the arrangement scrolls.
    const keptLengths = pixelSizes && node.keepLengths === true
    const pathStr = path.join('.')

    return (
      <div
        data-split-id={pathStr}
        data-split-dir={node.dir}
        data-split-size-unit={pixelSizes ? 'px' : 'share'}
        data-split-keeps-lengths={keptLengths ? 'true' : undefined}
        className={cn(
          'flex h-full w-full min-h-0 min-w-0',
          frameVisible && 'gap-1',
          dirCls,
        )}
        style={{ minWidth: fits(fitting, 'width') ? 0 : minimumSize.width, minHeight: fits(fitting, 'height') ? 0 : minimumSize.height }}
      >
        {node.children.map((child, i) => {
          if (!shownTree(child)) return null
          const childMinimumSize = minSizeFor(child)
          const minimumAlong = isRow ? childMinimumSize.width : childMinimumSize.height
          // A share fills the split in proportion to its siblings. A pixel size
          // is drawn the same way, weighted by its saved length: on the stage it
          // was dragged on it is exactly that length (the sizes add up to the
          // stage), and on a narrower or wider window the panes scale together
          // and never run past the edge, each held at its minimum.
          // A pixel length of 0 is the child's content's length (FitsContentLength measures it).
          const fitsContent = pixelSizes && node.sizes[i] === 0
          const crossPx = paneCrossPx(node, i)
          const childFitting = fittingOf({
            width: isRow ? fitsContent || (visibleChildCount === 1 && fits(fitting, 'width')) : crossPx === null && fits(fitting, 'width'),
            height: isRow ? crossPx === null && fits(fitting, 'height') : fitsContent || (visibleChildCount === 1 && fits(fitting, 'height')),
          })
          const flex = fitsContent
            ? '0 0 auto'
            : keptLengths
            ? `0 0 ${renderablePanePx(node.sizes[i], draggablePaneMinimumPx(isRow, minimumAlong))}px`
            : pixelSizes
              ? `${renderablePanePx(node.sizes[i], draggablePaneMinimumPx(isRow, minimumAlong))} 1 0px`
              : `${renderableSplitShare(node.sizes[i], node.children.length)} 1 0px`
          // A pane with its own length across the split (its height in a row) sits at the split's start at that
          // length; the rest of the split's thickness stays open beside it.
          const key = isLeaf(child)
            ? `leaf-${getLeafId(child) ?? 'unknown'}-${pathStr}-${i}`
            : `split-${pathStr}-${i}`
          return (
            <React.Fragment key={key}>
              <SplitChildBox
                // A new pane in a pixel split opens from nothing to its size,
                // pushing the panes after it over as it grows.
                grow={pixelSizes && !shouldReduceMotion
                  && child.kind === 'leaf' && enteringContainerIds.has(getLeafId(child) ?? '')}
                growAxis={isRow ? 'row' : 'column'}
                data-split-child={i}
                data-pane-entry-origin={
                  child.kind === 'leaf' && enteringContainerIds.has(getLeafId(child) ?? '')
                    ? splitEntryOrigin(node.dir, i)
                    : undefined
                }
                data-pane-motion-reduced={shouldReduceMotion ? 'true' : undefined}
                // Moving panes may glide. Resizing reflows their live controls;
                // FLIP size scaling stretches text and nested arrangements.
                layout={shouldReduceMotion ? false : 'position'}
                transition={{
                  layout: {
                    duration: shouldReduceMotion ? 0 : 0.38,
                    ease: [0.22, 1, 0.36, 1],
                  },
                }}
                className={cn(
                  'relative overflow-visible min-w-0 min-h-0',
                  crossPx === null && (isRow ? 'h-full' : 'w-full'),
                )}
                data-pane-cross={crossPx === null ? undefined : 'own'}
                style={{
                  flex,
                  minWidth: fits(childFitting, 'width') ? 0 : childMinimumSize.width,
                  minHeight: fits(childFitting, 'height') ? 0 : childMinimumSize.height,
                  ...(crossPx === null ? {} : { alignSelf: 'flex-start', [isRow ? 'height' : 'width']: crossPx }),
                }}
                aria-hidden={false}
              >
                <RenderNode
                  node={child}
                  fitting={childFitting}
                  focusedContainerId={focusedContainerId}
                  disableEdgeUI={disableEdgeUI}
                  path={[...path, i]}
                  enteringContainerIds={enteringContainerIds}
                  entryOrigins={entryOrigins}
                  shouldReduceMotion={shouldReduceMotion}
                  onResize={onResize}
                  onResizeCross={onResizeCross}
                  renderContainer={renderContainer}
                  onDropTarget={onDropTarget}
                  onSwapContainers={onSwapContainers}
                  onDropTabIntoContainer={onDropTabIntoContainer}
                  onDropTabAtContainerEdge={onDropTabAtContainerEdge}
                  onDropSurfaceAtContainerEdge={onDropSurfaceAtContainerEdge}
                />
                {fitsContent ? <FitsContentLength dir={node.dir} /> : null}
                {/* Every pane in a split owns its far edge across the split too (its bottom in a row, its right side
                    in a stack): dragging it gives the pane its own height or width. */}
                {resizeVisible && <CrossResizeHandle
                  dir={node.dir}
                  savedLength={crossPx}
                  onCommit={(lengthPx) => onResizeCross(path, i, lengthPx)}
                />}
              </SplitChildBox>

              {/* Every pane owns the edge after it, including the last one, so
                  any pane can grow or shrink without touching a neighbour. An
                  edge with a pane after it is a seam of the window (seam-slots).
                  A thing on the seam (the sidebar's bar) resizes the same pane
                  from either side of it and from its own empty room, so the
                  edge after it is that pane's edge too. */}
              {(() => {
                if (!resizeVisible) return null
                const edge = { dir: node.dir, index: i, savedSize: node.sizes[i], onCommit: (sizesPx: number[]) => onResize(path, sizesPx) }
                const claim = i < node.children.length - 1 ? seams.claims.get(dockSeamKey({ split: path, after: i })) : undefined
                return (
                  <>
                    <ResizeHandle
                      seamOf={seams.serves && i < node.children.length - 1 ? seamMark({ split: path, after: i }) : undefined}
                      {...edge}
                    />
                    {claim ? <SeamSlotBox claim={claim} axis={isRow ? 'vertical' : 'horizontal'} edge={edge} /> : null}
                    {claim ? <ResizeHandle {...edge} /> : null}
                  </>
                )
              })()}
            </React.Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <LeafView
      leaf={node}
      fitting={fitting}
      entering={enteringContainerIds.has(getLeafId(node) ?? '')}
      entryOrigin={entryOrigins.get(getLeafId(node) ?? '') ?? null}
      shouldReduceMotion={shouldReduceMotion}
      focusedContainerId={focusedContainerId}
      disableEdgeUI={disableEdgeUI}
      renderContainer={renderContainer}
      onDropTarget={onDropTarget}
      onSwapContainers={onSwapContainers}
      onDropTabIntoContainer={onDropTabIntoContainer}
      onDropTabAtContainerEdge={onDropTabAtContainerEdge}
      onDropSurfaceAtContainerEdge={onDropSurfaceAtContainerEdge}
    />
  )
}

/**
 * One pane's box in a split. When `grow` is set on its first render, the box
 * starts at no length and its flex basis eases to its size, so the panes after
 * it slide over instead of jumping. Once grown it is an ordinary box: no
 * transition is left behind to lag a later edge drag.
 */
function SplitChildBox({
  grow,
  growAxis,
  style,
  children,
  ...rest
}: React.ComponentProps<typeof motion.div> & {
  grow: boolean
  growAxis: 'row' | 'column'
}) {
  const [phase, setPhase] = React.useState<'start' | 'growing' | 'settled'>(grow ? 'start' : 'settled')
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (phase !== 'start') return
    // One frame at no length, then the transition runs to the real basis.
    const frame = requestAnimationFrame(() => setPhase('growing'))
    return () => cancelAnimationFrame(frame)
  }, [phase])
  React.useEffect(() => {
    // While it grows, the arrangement follows its far edge, so the new pane
    // slides into view from the side it opens toward instead of growing
    // somewhere past the edge of the window.
    if (phase !== 'growing') return
    const box = boxRef.current
    const scroller = box ? scrollParent(box, growAxis) : null
    if (!box || !scroller) return
    let frame = 0
    const follow = () => {
      const edge = box.getBoundingClientRect()
      const view = scroller.getBoundingClientRect()
      if (growAxis === 'row') {
        const past = edge.right - view.right
        if (past > 0) scroller.scrollLeft += past
      } else {
        const past = edge.bottom - view.bottom
        if (past > 0) scroller.scrollTop += past
      }
      frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => cancelAnimationFrame(frame)
  }, [phase, growAxis])
  const min = growAxis === 'row' ? 'minWidth' : 'minHeight'
  const own = style as React.CSSProperties
  const shown: React.CSSProperties = phase === 'start'
    ? { ...own, flex: '0 0 0px', [min]: 0, overflow: 'hidden' }
    : phase === 'growing'
      ? {
          ...own,
          overflow: 'hidden',
          transition: `flex-basis var(--pane-grow-duration, 420ms) var(--pane-grow-ease, cubic-bezier(0.22, 1, 0.36, 1)), ${growAxis === 'row' ? 'min-width' : 'min-height'} var(--pane-grow-duration, 420ms) var(--pane-grow-ease, cubic-bezier(0.22, 1, 0.36, 1))`,
        }
      : own
  return (
    <motion.div
      {...rest}
      ref={boxRef}
      data-pane-growing={phase !== 'settled' ? 'true' : undefined}
      style={shown}
      onTransitionEnd={(event: React.TransitionEvent) => {
        if (phase === 'growing' && event.target === event.currentTarget) setPhase('settled')
      }}
    >
      {children}
    </motion.div>
  )
}

/** The nearest ancestor that scrolls along `axis`. */
function scrollParent(node: HTMLElement, axis: 'row' | 'column'): HTMLElement | null {
  for (let at = node.parentElement; at; at = at.parentElement) {
    const style = getComputedStyle(at)
    const overflow = axis === 'row' ? style.overflowX : style.overflowY
    if (overflow === 'auto' || overflow === 'scroll') return at
  }
  return null
}

/** ========== Leaf (container) ========== */
/**
 * Whether a pane cuts its screen's foot: a pane dragged shorter than the height its screen is laid out at shows the
 * part that fits, and the bottom fades out (screen-look edge-fade.css reads `data-pane-cut`). Across, a screen always
 * lays out at its pane's own width (its content reflows by container queries), so it is never cut sideways.
 */
function usePaneCut(ref: React.RefObject<HTMLElement | null>, fitting?: Fitting): 'y' | undefined {
  const [cut, setCut] = React.useState<'y' | undefined>(undefined)
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver !== 'function') return
    const measure = () => {
      // Along the axis a pane fits its content, the content is never cut.
      const next = !fits(fitting, 'height') && element.clientHeight > 0 && element.clientHeight < minUsableContainerHeightPx() ? 'y' : undefined
      setCut((current) => current === next ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, fitting])
  return cut
}

function LeafView({
  leaf,
  entering,
  entryOrigin,
  shouldReduceMotion,
  focusedContainerId,
  disableEdgeUI,
  renderContainer,
  onDropTarget,
  onSwapContainers,
  onDropTabIntoContainer,
  onDropTabAtContainerEdge,
  onDropSurfaceAtContainerEdge,
  fitting,
}: {
  leaf: LeafNode
  /** The axes the screen is not held at the pane minimum along (see RenderNode). */
  fitting?: Fitting
  entering: boolean
  entryOrigin: PaneEntryOrigin | null
  shouldReduceMotion: boolean
  focusedContainerId: string | null
  disableEdgeUI?: boolean
  renderContainer: (containerId: string) => React.ReactNode
  onDropTarget: (t: DropTarget) => void
  onSwapContainers?: (a: string, b: string) => void
  onDropTabIntoContainer?: (containerId: string, tabId: string) => Promise<void> | void
  onDropTabAtContainerEdge?: (containerId: string, edge: FrameEdge, tabId: string) => Promise<void> | void
  onDropSurfaceAtContainerEdge?: (containerId: string, edge: FrameEdge, tab: TabMeta) => Promise<void> | void
}) {
  // Pane sizes are the person's (use-pane-sizes.ts): a change there redraws every pane's minimum at once.
  usePaneSizes()
  const containerId = getLeafId(leaf)
  // A pane is new only on the render that first draws it. It reveals once,
  // then carries no mask or blur, so its glass and scrolling stay untouched.
  const enteredNow = React.useRef(entering).current
  const [revealing, setRevealing] = React.useState(() => entering && !shouldReduceMotion)
  const paneRef = React.useRef<HTMLDivElement | null>(null)
  const contentRef = React.useRef<HTMLDivElement | null>(null)
  const cut = usePaneCut(contentRef, fitting)
  React.useEffect(() => {
    // The arrangement grew to make room, so the new pane may sit past the edge
    // of the window: bring it into view.
    // A pane that grows into place is followed by its split box instead.
    if (!enteredNow || paneRef.current?.closest('[data-pane-growing]')) return
    paneRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: shouldReduceMotion ? 'auto' : 'smooth' })
  }, [enteredNow, shouldReduceMotion])
  const drag = React.useContext(DragContext)
  const tabDrag = React.useContext(TabDragContext)
  const layoutState = React.useContext(LayoutStateContext)
  // This container's OWN frame chrome (glass-surface border/bg + inner padding).
  // Gated by the `container.frame` zone of THIS region's effective chrome, so an
  // immersive container (regionChrome[key]={'':false}) drops its frame while its
  // siblings keep theirs (note #33). Absent = framed (no regression).
  const containerFrameVisible = regionZoneVisible(
    layoutState?.chrome, layoutState?.regionChrome, containerRegion(containerId), 'container.frame',
  )

  const dragging = drag?.draggingId === containerId
  const isOver = drag?.overId === containerId
  const someDragging = !!drag?.draggingId

  const isTabOver = tabDrag?.overContainerId === containerId
  const someTabDragging = !!tabDrag?.draggingTabId
  const isEdgeHover = tabDrag?.edgeHover?.containerId === containerId
  const isContainerEdgeHover = drag?.edgeHover?.containerId === containerId

  // EDGE_PX = 40 — reserved for container-edge drop detection

  React.useEffect(() => {
    const pane = paneRef.current
    if (!pane || disableEdgeUI) return
    // A hosted screen may mount its own React root inside this pane. React's
    // synthetic capture handler does not cross that root, but DOM capture does.
    const onEdgeDragOver = (event: DragEvent) => {
      if (!isPaneDragTarget(pane, event.target)) return
      if (event.dataTransfer && isOverSelectedRecordDropOwner(event.dataTransfer, event.clientX, event.clientY)) return
      const edge = paneEdgeAt(pane, event.clientX, event.clientY)
      if (!edge) return
      const types = Array.from(event.dataTransfer?.types ?? [])
      const hasTab = types.includes('application/x-tab-id')
      const hasSurface = !!event.dataTransfer && hasPlaceableSurface(event.dataTransfer)
      const hasContainer = types.includes('application/x-container-id')
      if (!hasTab && !hasSurface && !hasContainer) return
      event.preventDefault()
      event.stopPropagation()
      if (hasTab || hasSurface) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = hasSurface ? 'copy' : 'move'
        tabDrag?.setEdgeHover({ containerId, edge })
        tabDrag?.setOverContainerId(null)
      } else if (drag?.draggingId !== containerId) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        drag?.setEdgeHover?.({ containerId, edge })
        drag?.setOverId(null)
      }
    }
    const onEdgeDrop = (event: DragEvent) => {
      if (!isPaneDragTarget(pane, event.target)) return
      if (event.dataTransfer && isOverSelectedRecordDropOwner(event.dataTransfer, event.clientX, event.clientY)) return
      const edge = paneEdgeAt(pane, event.clientX, event.clientY)
      if (!edge || !event.dataTransfer) return
      const types = Array.from(event.dataTransfer.types)
      const hasTab = types.includes('application/x-tab-id')
      const hasSurface = hasPlaceableSurface(event.dataTransfer)
      const hasContainer = types.includes('application/x-container-id')
      if (!hasTab && !hasSurface && !hasContainer) return
      event.preventDefault()
      event.stopPropagation()
      if (hasTab) {
        const tabId = event.dataTransfer.getData('application/x-tab-id') || tabDrag?.draggingTabId
        if (tabId) void onDropTabAtContainerEdge?.(containerId, edge, tabId)
        tabDrag?.setEdgeHover(null)
        tabDrag?.setOverContainerId(null)
        tabDrag?.setDraggingTabId(null)
      } else if (hasSurface) {
        const surfaceTab = readPlaceableSurfaceTab(event.dataTransfer)
        if (surfaceTab) void onDropSurfaceAtContainerEdge?.(containerId, edge, surfaceTab)
        tabDrag?.setEdgeHover(null)
        tabDrag?.setOverContainerId(null)
      } else if (hasContainer) {
        const fromId = event.dataTransfer.getData('application/x-container-id') || drag?.draggingId
        if (fromId && fromId !== containerId) onDropTarget({ kind: 'container-edge', containerId, edge })
        drag?.setDraggingId(null)
        drag?.setOverId(null)
        drag?.setEdgeHover?.(null)
      }
    }
    pane.addEventListener('dragover', onEdgeDragOver, true)
    pane.addEventListener('drop', onEdgeDrop, true)
    return () => {
      pane.removeEventListener('dragover', onEdgeDragOver, true)
      pane.removeEventListener('drop', onEdgeDrop, true)
    }
  }, [containerId, disableEdgeUI, drag, onDropSurfaceAtContainerEdge, onDropTabAtContainerEdge, onDropTarget, tabDrag])

  const dragProps = {
    draggable: false, // drag is started by a chrome/handle inside the container
    onDragOverCapture: (e: React.DragEvent) => {
      if (!isPaneDragTarget(e.currentTarget as HTMLElement, e.target)) return
      if (isOverSelectedRecordDropOwner(e.dataTransfer, e.clientX, e.clientY)) return
      if (disableEdgeUI) return
      const hasContainer = e.dataTransfer.types.includes('application/x-container-id')
      const hasTab = e.dataTransfer.types.includes('application/x-tab-id')
      const hasSurface = hasPlaceableSurface(e.dataTransfer)
      if (!hasContainer && !hasTab && !hasSurface) return

      e.preventDefault()

      const edge = paneEdgeAt(e.currentTarget as HTMLElement, e.clientX, e.clientY)

      if (!edge) {
        drag?.setEdgeHover?.(null)
        tabDrag?.setEdgeHover?.(null)
        if (hasContainer) {
          drag?.setOverId?.(containerId)
        }
        if (hasTab) {
          tabDrag?.setOverContainerId?.(containerId)
        }
        if (hasSurface) {
          tabDrag?.setOverContainerId?.(containerId)
        }
      } else {
        // Native pane capture owns edge drops, including screens with their own React root.
        // Handle edge preview here for ordinary React descendants too.
        if (hasContainer && someDragging && !dragging) {
          e.dataTransfer.dropEffect = 'move'
          drag?.setEdgeHover?.({ containerId, edge })
          drag?.setOverId(null)
        } else if (hasTab || hasSurface) {
          e.dataTransfer.dropEffect = hasSurface ? 'copy' : 'move'
          tabDrag?.setEdgeHover({ containerId, edge })
          tabDrag?.setOverContainerId(null)
        }
      }
    },
    // Accept drops in bubble phase for both tabs and containers
    onDragOver: (e: React.DragEvent) => {
      if (!isPaneDragTarget(e.currentTarget as HTMLElement, e.target)) return
      if (isOverSelectedRecordDropOwner(e.dataTransfer, e.clientX, e.clientY)) return
      const t = e.dataTransfer.types
      if (t.includes('application/x-tab-id') || t.includes('application/x-container-id') || hasPlaceableSurface(e.dataTransfer)) {
        e.preventDefault()
        e.dataTransfer.dropEffect = hasPlaceableSurface(e.dataTransfer) ? 'copy' : 'move'
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (disableEdgeUI) return
      // Dragleave also fires when the pointer enters a child of this pane.
      // Keep the edge preview until the pointer actually leaves the pane.
      if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
      if (drag?.overId === containerId) drag.setOverId(null)
      if (drag?.edgeHover?.containerId === containerId) drag.setEdgeHover?.(null)
      // Do not clear center-hover during tab drags; prevents flicker when moving over children
      const isTab = e.dataTransfer?.types?.includes?.('application/x-tab-id')
      const isSurface = hasPlaceableSurface(e.dataTransfer)
      if (!isTab && !isSurface && tabDrag?.overContainerId === containerId) tabDrag.setOverContainerId(null)
      if (tabDrag?.edgeHover?.containerId === containerId) tabDrag.setEdgeHover(null)
    },
    // Do not stop propagation here; center overlay below needs bubble-phase events.
    onDragEnterCapture: (_e: React.DragEvent) => {},
    onDropCapture: (e: React.DragEvent) => {
      if (!isPaneDragTarget(e.currentTarget as HTMLElement, e.target)) return
      if (isOverSelectedRecordDropOwner(e.dataTransfer, e.clientX, e.clientY)) return
      // Run before children to avoid content stealing the drop.
      const types = e.dataTransfer.types
      const hasTab = types.includes('application/x-tab-id')
      const hasContainer = types.includes('application/x-container-id')
      const hasSurface = hasPlaceableSurface(e.dataTransfer)
      if (!hasTab && !hasContainer && !hasSurface) return

      e.preventDefault()

      // The pane's native capture listener handles every edge drop. This React
      // handler remains for center drops that belong to child owners.
      if (!disableEdgeUI && paneEdgeAt(e.currentTarget as HTMLElement, e.clientX, e.clientY)) return

      // Do not stopPropagation here; center overlay (below) will handle tab center-drops.

      // --- TAB drop handling ---
      if (hasTab) {
        // Center tab-drops are handled by the overlay below.
      }

      if (hasSurface) {
        // Center surface drops are handled by ContainerHost.
      }

      // --- CONTAINER drop handling (swap or edge) ---
      if (hasContainer) {
        const fromId = drag?.draggingId || e.dataTransfer.getData('application/x-container-id')
        if (fromId && fromId !== containerId) {
          onSwapContainers?.(fromId, containerId)
        }
        // Clear container-drag state
        drag?.setDraggingId?.(null)
        drag?.setOverId?.(null)
        drag?.setEdgeHover?.(null)
      }
    }
  }

  return (
    <motion.div
      {...(dragProps as any)}
      className={cn(
        "relative flex h-full w-full min-h-0 min-w-0 flex-col transition-all duration-200 motion-reduce:transition-none",
        revealing && '!transition-none',
        containerFrameVisible && 'glass-surface',
        dragging
          ? cn(DRAGGING_CONTAINER_BORDER, 'shadow-[0_0_0_1px_rgba(255,255,255,0.2)]')
          : focusedContainerId === containerId
          ? FOCUSED_CONTAINER_BORDER
          : "hover:!border-[var(--border-secondary)]",
        isOver && !dragging ? '!border-[var(--border-focus)] bg-[var(--glass-bg-subtle)]' : '',
        isTabOver && !dragging ? '!border-[var(--border-focus)] bg-[var(--glass-bg-subtle)] !border-2' : '',
        someDragging && !dragging && !isOver ? 'opacity-60 !border-dashed !border-[var(--border-secondary)]' : '',
        someTabDragging && !isTabOver && !isEdgeHover ? 'opacity-60' : ''
      )}
      data-container-id={containerId}
      data-arrangement-pane
      data-pane-entering={entering ? 'true' : undefined}
      data-pane-motion-reduced={shouldReduceMotion ? 'true' : undefined}
      ref={paneRef}
      data-pane-revealing={revealing ? 'true' : undefined}
      // A pane can be dragged down to a sliver (pane-sizes.json); its screen keeps its own layout size inside it.
      style={{
        minWidth: paneDragMinimumPx(),
        minHeight: paneDragMinimumPx(),
        ...(revealing ? { maskImage: paneRevealMask(entryOrigin), WebkitMaskImage: paneRevealMask(entryOrigin) } : {}),
      }}
      // Reduced motion draws the pane at once: no sweep, no blur.
      initial={revealing ? PANE_REVEAL_FROM : false}
      animate={revealing ? PANE_REVEAL_TO : undefined}
      transition={{ duration: 0.56, ease: [0.22, 1, 0.36, 1], opacity: { duration: 0.34, ease: 'easeOut' } }}
      onAnimationComplete={() => { if (revealing) setRevealing(false) }}
    >
      {/* Light veil for container drag over */}
      {isOver && !dragging && !isContainerEdgeHover && (
        <div className="pointer-events-none absolute inset-0 rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-sm" />
      )}
      {/* Glass veil for tab drag center-hover */}
      {isTabOver && !isEdgeHover && (
        <div className="pointer-events-none absolute inset-0 rounded-xl bg-[var(--glass-bg-subtle)] backdrop-blur-sm" />
      )}
      {/* Edge overlays */}
      {isContainerEdgeHover && (
        <EdgeOverlay edge={drag?.edgeHover?.edge} label="move container here" />
      )}
      {isEdgeHover && (
        <EdgeOverlay edge={tabDrag?.edgeHover?.edge} label="+ new container" />
      )}

      {/* Container content */}
      {/* Every hosted surface sits inside the named `surface` size container,
          so it adapts to this pane's width rather than the window's. */}
      <motion.div
        ref={contentRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-pane-cut={cut}
        style={{ '--pane-cut-fade': `${paneCutFadePx()}px` } as React.CSSProperties}
        data-pane-content-entering={entering ? 'true' : undefined}
        initial={entering && !shouldReduceMotion ? { opacity: 0, y: 6 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: shouldReduceMotion ? 0 : 0.32, delay: shouldReduceMotion ? 0 : 0.06, ease: 'easeOut' }}
      >
      {/* The screen lays out at the pane's own width and reflows in it; a pane dragged shorter than the screen's own
          height shows the part that fits (see usePaneCut). */}
      <ContainerSizeRegion
        className={cn('flex-1 overflow-auto', containerFrameVisible && 'px-2 pb-2 pt-0')}
        style={{ minWidth: 0, minHeight: fits(fitting, 'height') ? 0 : minUsableContainerHeightPx() }}
      >
        {renderContainer(containerId)}
      </ContainerSizeRegion>
      </motion.div>

      {/* Center tab drops are routed by the container's shared drop-intent router,
          beside surface drops. Edge drops remain on this arranger above. */}
    </motion.div>
  )
}

function EdgeOverlay({ edge, label }: { edge?: FrameEdge, label: string }) {
  const colorCls = 'border-[var(--border-focus)] bg-[var(--glass-bg-subtle)] text-[var(--text-secondary)]'

  return (
    <div className={cn(
      'pointer-events-none absolute rounded-lg border-2 border-dashed backdrop-blur-sm flex items-center justify-center text-xs font-medium z-50',
      colorCls,
      edge === 'left'   ? 'left-2 top-2 bottom-2 w-16' :
      edge === 'right'  ? 'right-2 top-2 bottom-2 w-16' :
      edge === 'top'    ? 'top-2 left-2 right-2 h-16' :
                          'bottom-2 left-2 right-2 h-16'
    )}>
      {label}
    </div>
  )
}

/** ========== Seam slots ========== */
type SeamContextValue = { serves: boolean; claims: ReadonlyMap<string, SeamClaim> }
const SeamContext = React.createContext<SeamContextValue>({ serves: false, claims: new Map() })

/**
 * The room a claimed seam keeps between two panes; the thing that claimed it draws itself inside (seam-slots). A
 * press on its own room (not on a control the thing draws, nor its grip) drags the pane edge it sits on, as the
 * resize handles on either side of it do.
 */
const SEAM_SLOT_OWN_INPUT = 'button, a, input, select, textarea, [role="button"], [role="slider"], [data-sidebar-bar-grip]'
function SeamSlotBox({ claim, axis, edge }: { claim: SeamClaim; axis: 'vertical' | 'horizontal'; edge: PaneEdge }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const { begin } = usePaneEdgeDrag(ref, edge)
  const beginRef = React.useRef(begin)
  beginRef.current = begin
  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    placeSeamSlot(claim.seam, { element, axis })
    return () => placeSeamSlot(claim.seam, null)
  }, [axis, claim.seam])
  // The thing on the seam is drawn into this box through a portal, so its presses reach this box only in the page.
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const press = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (event.target instanceof Element && event.target.closest(SEAM_SLOT_OWN_INPUT)) return
      beginRef.current(event)
    }
    element.addEventListener('pointerdown', press)
    return () => element.removeEventListener('pointerdown', press)
  }, [])
  return (
    <div
      ref={ref}
      data-seam-slot={seamMark(claim.seam)}
      data-seam-axis={axis}
      // Its resize cursor is set here, not by class: the arranger's look styles every split child with a resize-cursor
      // class as a zero-size edge (split-arranger.css).
      className="relative flex min-h-0 min-w-0 touch-none"
      style={axis === 'vertical'
        ? { flex: `0 0 ${claim.thickness}px`, width: claim.thickness, alignSelf: 'stretch', cursor: 'col-resize' }
        : { flex: `0 0 ${claim.thickness}px`, height: claim.thickness, alignSelf: 'stretch', cursor: 'row-resize' }}
    />
  )
}

/** ========== Resize Handle ========== */
type PaneMeasure = {
  panes: HTMLElement[]
  /** Every pane of the split along its axis, in layout (zoom-independent) pixels. */
  sizes: number[]
  /** The resized pane's own minimum along the axis, in layout pixels. */
  minimum: number
  /** Every pane's own minimum along the axis, in pane order. */
  minimums: number[]
  /** The length the panes share: the split's length less its gaps, in layout pixels. */
  stage: number
  /** Painted pixels per layout pixel: the arrangement's current zoom. */
  scale: number
  /** The split keeps its lengths: a pane changes alone and the split grows or shrinks with it. */
  kept: boolean
  /** The length snap points are fractions of: the stage, or for a split that keeps its lengths the visible window. */
  snapStage: number
}

/**
 * Read the split this handle belongs to straight from the page. Sizes come from
 * the painted boxes divided by the zoom, so a drag at 40% zoom and one at 100%
 * record the same layout pixels.
 */
function measurePanes(handle: HTMLElement | null, dir: 'row' | 'column', index: number): PaneMeasure | null {
  const parent = handle?.parentElement
  if (!parent) return null
  const panes = [...parent.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && child.hasAttribute('data-split-child'),
  )
  const pane = panes[index]
  if (!pane) return null
  const row = dir === 'row'
  const layoutLength = row ? parent.offsetWidth : parent.offsetHeight
  const paintedParent = parent.getBoundingClientRect()
  const paintedLength = row ? paintedParent.width : paintedParent.height
  const scale = layoutLength > 0 && paintedLength > 0 ? paintedLength / layoutLength : 1
  const sizes = panes.map((one) => {
    const painted = one.getBoundingClientRect()
    return (row ? painted.width : painted.height) / scale
  })
  const minimums = panes.map((one) => draggablePaneMinimumPx(row, Number.parseFloat(row ? one.style.minWidth : one.style.minHeight) || 0))
  const style = getComputedStyle(parent)
  const gap = Number.parseFloat(row ? style.columnGap : style.rowGap) || 0
  // A slot on a seam (a thin bar between two panes) keeps its own room; the panes share the rest.
  const slots = [...parent.children].reduce((sum, child) => sum + (child instanceof HTMLElement && child.hasAttribute('data-seam-slot')
    ? (row ? child.offsetWidth : child.offsetHeight) : 0), 0)
  const stage = layoutLength - Math.max(0, parent.children.length - 1) * gap - slots
  const kept = parent.dataset.splitKeepsLengths === 'true'
  return { panes, sizes, minimum: minimums[index], minimums, stage, scale, kept, snapStage: kept ? visibleArrangementLength(parent, row, scale) : stage }
}

/** The arrangement's visible length along an axis, in layout pixels: what a pane on a split that runs past it sees. */
function visibleArrangementLength(element: HTMLElement, row: boolean, scale: number): number {
  const viewport = element.closest<HTMLElement>('[data-arranger="split-tree"]')
  if (!viewport) return row ? element.offsetWidth : element.offsetHeight
  // Inside the arranger's own padding, as the stage itself is measured.
  const style = getComputedStyle(viewport)
  const padding = row
    ? (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    : (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  return ((row ? viewport.clientWidth : viewport.clientHeight) - padding) / scale
}

/** One pane at a new length while every other pane keeps its own: the split grows or shrinks by the difference. */
function keepOtherPanes(sizes: readonly number[], index: number, requestedPx: number, minimumPx: number): { sizes: number[]; atMinimum: boolean } {
  const next = [...sizes]
  next[index] = Math.max(minimumPx, requestedPx)
  return { sizes: next, atMinimum: requestedPx <= minimumPx }
}

/** Draw pane sizes directly while a drag is live; React takes over on commit. */
function paintPaneSizes(panes: HTMLElement[], sizes: number[], easeMs = 0) {
  panes.forEach((pane, at) => {
    // A snap settles softly over the person's snap softness; a free drag follows the pointer exactly.
    pane.style.transition = easeMs > 0 ? `flex-basis ${easeMs}ms cubic-bezier(0.22, 1, 0.36, 1)` : ''
    pane.style.flex = `0 0 ${sizes[at]}px`
  })
}

/** One pane's edge: the split it sits in, the pane it resizes and where a finished drag goes. */
type PaneEdge = {
  dir: 'row' | 'column'
  /** The pane this edge sits after; only that pane changes size. */
  index: number
  /** The saved size, so the announced value follows every committed change. */
  savedSize: number | undefined
  onCommit: (sizesPx: number[]) => void
}

/**
 * Dragging one pane's edge, from any element that sits in the pane's split (its resize handle, or a thing on the seam
 * after it). The element's parent is the split; the panes are read from the page on every drag.
 */
function usePaneEdgeDrag(ref: React.RefObject<HTMLElement | null>, { dir, index, savedSize, onCommit }: PaneEdge) {
  const [atMinimum, setAtMinimum] = React.useState(false)
  const [announced, setAnnounced] = React.useState({ size: 0, minimum: 0 })
  const dragRef = React.useRef<{ x: number; y: number; measure: PaneMeasure; element: HTMLElement } | null>(null)
  const listenersRef = React.useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void } | null>(null)
  const commitRef = React.useRef(onCommit)
  commitRef.current = onCommit
  const row = dir === 'row'

  const resizeTo = (measure: PaneMeasure, requestedPx: number, snap = false) => {
    const snapped = snap ? snapPanePx(requestedPx, measure.snapStage) : { px: requestedPx, snapped: false }
    // A split that keeps its lengths changes only the dragged pane; any other split stays as long as its stage.
    const next = measure.kept
      ? keepOtherPanes(measure.sizes, index, snapped.px, measure.minimum)
      : resizePaneInStage(measure.sizes, index, snapped.px, measure.minimums, measure.stage)
    paintPaneSizes(measure.panes, next.sizes, snapped.snapped ? paneSizesNow().snap_ease_ms : 0)
    setAtMinimum((current) => current === next.atMinimum ? current : next.atMinimum)
    setAnnounced({ size: next.sizes[index], minimum: measure.minimum })
    return next
  }

  const requestedFromPointer = (e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag) return null
    const paintedDelta = row ? e.clientX - drag.x : e.clientY - drag.y
    return drag.measure.sizes[index] + paintedDelta / drag.measure.scale
  }

  const unbindListeners = () => {
    if (!listenersRef.current) return
    window.removeEventListener('pointermove', listenersRef.current.move)
    window.removeEventListener('pointerup', listenersRef.current.up)
    listenersRef.current = null
  }

  const bindListeners = () => {
    if (listenersRef.current) return
    const move = (e: PointerEvent) => {
      const drag = dragRef.current
      const requested = requestedFromPointer(e)
      if (!drag || requested === null) return
      resizeTo(drag.measure, requested, true)
    }
    const up = (e: PointerEvent) => {
      const drag = dragRef.current
      if (drag?.element.hasPointerCapture?.(e.pointerId)) drag.element.releasePointerCapture(e.pointerId)
      const requested = requestedFromPointer(e)
      // pointerup can carry the final device coordinate before the browser has
      // dispatched its last pointermove, so the release position is the size.
      if (drag && requested !== null) { commitRef.current(resizeTo(drag.measure, requested, true).sizes); drag.measure.panes.forEach((pane) => { pane.style.transition = '' }); reportScreenCommand(row ? 'Changed pane width' : 'Changed pane height', 'Workspace') }
      dragRef.current = null
      document.body.style.cursor = 'auto'
      document.body.style.userSelect = 'auto'
      window.setTimeout(() => setAtMinimum(false), 280)
      unbindListeners()
    }
    listenersRef.current = { move, up }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  React.useEffect(() => () => unbindListeners(), [])

  /** Start a drag at this pointer; false when the element is not in a split. */
  const begin = (e: { pointerId: number; clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) => {
    const element = ref.current
    const measure = measurePanes(element, dir, index)
    if (!element || !measure) return false
    e.preventDefault()
    e.stopPropagation()
    element.setPointerCapture?.(e.pointerId)
    setAtMinimum(false)
    dragRef.current = { x: e.clientX, y: e.clientY, measure, element }
    document.body.style.cursor = row ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    bindListeners()
    return true
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    const grow = row ? 'ArrowRight' : 'ArrowDown'
    const shrink = row ? 'ArrowLeft' : 'ArrowUp'
    if (e.key !== grow && e.key !== shrink && e.key !== 'Home') return
    const measure = measurePanes(ref.current, dir, index)
    if (!measure) return
    e.preventDefault()
    // An arrow moves the edge to the next snap point that way, or by the person's step (pane-sizes.ts arrowPanePx).
    const requested = e.key === 'Home'
      ? measure.minimum
      : arrowPanePx(measure.sizes[index], measure.snapStage, e.key === grow ? 1 : -1, e.shiftKey)
    commitRef.current(resizeTo(measure, requested).sizes)
    window.setTimeout(() => setAtMinimum(false), 900)
  }

  // Announce the pane's current size after every committed change.
  React.useLayoutEffect(() => {
    const measure = measurePanes(ref.current, dir, index)
    if (!measure) return
    const next = { size: measure.sizes[index], minimum: measure.minimum }
    setAnnounced((current) => current.size === next.size && current.minimum === next.minimum ? current : next)
  }, [dir, index, savedSize])

  return { atMinimum, announced, begin, handleKeyDown }
}

function ResizeHandle({
  seamOf,
  ...edge
}: PaneEdge & {
  /** The seam this edge is, when a pane follows it in the window's arrangement (seam-slots SEAM_MARK). */
  seamOf?: string
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [isHovered, setIsHovered] = React.useState(false)
  const { atMinimum, announced, begin, handleKeyDown } = usePaneEdgeDrag(ref, edge)
  const row = edge.dir === 'row'
  const handlePointerDown = (e: React.PointerEvent) => { begin(e) }

  const axis = row ? 'width' : 'height'
  const minimumPx = Math.round(announced.minimum || paneDragMinimumPx())
  const valueText = atMinimum
    ? `Pane reached its minimum ${axis} of ${minimumPx} pixels.`
    : `Pane ${axis} ${Math.round(announced.size)} pixels. Use the arrow keys to resize this pane only; Home moves to its minimum.`

  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={row ? 'Resize pane width' : 'Resize pane height'}
      aria-valuemin={minimumPx}
      aria-valuenow={Math.round(announced.size)}
      aria-valuetext={valueText}
      tabIndex={0}
      data-resize-limit={atMinimum ? 'minimum' : undefined}
      data-pane-resize-edge={row ? 'width' : 'height'}
      {...(seamOf ? { [SEAM_MARK]: seamOf } : {})}
      className={cn(
        // A finger dragging the edge resizes, never scrolls the page (touch-none).
        'group relative z-10 flex-shrink-0 touch-none',
        row ? 'w-0 cursor-col-resize' : 'h-0 cursor-row-resize'
      )}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      {/* Invisible hit area: a finger needs a wider one than a mouse pointer. */}
      <div className={cn(
        'absolute',
        row ? 'w-3 h-full -left-1.5 pointer-coarse:w-7 pointer-coarse:-left-3.5' : 'h-3 w-full -top-1.5 pointer-coarse:h-7 pointer-coarse:-top-3.5'
      )} />

      {/* Visible rail */}
      <motion.div
        className={cn(
          'absolute rounded bg-[var(--glass-bg-subtle)]0',
          row
            ? 'top-0 bottom-0 left-1/2 -translate-x-1/2 w-0.5'
            : 'left-0 right-0 top-1/2 -translate-y-1/2 h-0.5'
        )}
        initial={false}
        animate={{ opacity: isHovered || atMinimum ? 0.9 : 0, scale: isHovered || atMinimum ? 1 : 0.5 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        style={{
          backgroundColor: atMinimum ? 'var(--accent-primary, var(--border-focus))' : 'var(--border-focus)',
          boxShadow: atMinimum ? '0 0 0 2px color-mix(in srgb, var(--accent-primary, var(--border-focus)) 30%, transparent)' : undefined,
        }}
      />
      {atMinimum && (
        <span
          aria-hidden="true"
          data-resize-boundary-label
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-[var(--accent-primary)] bg-[var(--bg-surface)] px-2 py-1 text-xs font-medium text-[var(--text-primary)] shadow-sm"
        >
          Minimum {minimumPx} px
        </span>
      )}
    </div>
  )
}

/**
 * A pane's far edge across its split (its bottom in a row, its right side in a stack). Dragging it gives the pane its
 * own height (or width), snapping to the person's points of the visible window like every pane edge; the arrow keys
 * step to the next point, and Home or a double press lets the pane fill its split again. The pane's box is painted
 * directly during the drag; the saved length comes back through the split on commit.
 */
function CrossResizeHandle({ dir, savedLength, onCommit }: {
  /** The split the pane sits in; the handle resizes across it. */
  dir: 'row' | 'column'
  /** The pane's own length across the split, or null while it fills. */
  savedLength: number | null
  onCommit: (lengthPx: number | null) => void
}) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [isHovered, setIsHovered] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const commitRef = React.useRef(onCommit)
  commitRef.current = onCommit
  // Across a row the pane's height changes; across a stack its width.
  const heightOfPane = dir === 'row'
  const lengthName = heightOfPane ? 'height' : 'width'

  const measure = () => {
    const box = ref.current?.parentElement
    const split = box?.parentElement
    if (!box || !split) return null
    const layoutLength = heightOfPane ? split.offsetHeight : split.offsetWidth
    const painted = split.getBoundingClientRect()
    const paintedLength = heightOfPane ? painted.height : painted.width
    const scale = layoutLength > 0 && paintedLength > 0 ? paintedLength / layoutLength : 1
    return {
      box,
      scale,
      length: heightOfPane ? box.offsetHeight : box.offsetWidth,
      stage: visibleArrangementLength(split, !heightOfPane, scale),
    }
  }

  const paint = (box: HTMLElement, lengthPx: number | null, easeMs = 0) => {
    box.style.transition = easeMs > 0 ? `${lengthName} ${easeMs}ms cubic-bezier(0.22, 1, 0.36, 1)` : ''
    box.style[lengthName] = lengthPx === null ? '' : `${lengthPx}px`
    box.style.alignSelf = lengthPx === null ? '' : 'flex-start'
  }

  const lengthFor = (requestedPx: number, stage: number) => {
    const snapped = snapPanePx(requestedPx, stage)
    return { px: Math.max(paneDragMinimumPx(), snapped.px), snapped: snapped.snapped }
  }

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = measure()
    if (!start) return
    e.preventDefault()
    e.stopPropagation()
    const element = e.currentTarget
    element.setPointerCapture?.(e.pointerId)
    const from = heightOfPane ? e.clientY : e.clientX
    const requested = (event: PointerEvent) => start.length + ((heightOfPane ? event.clientY : event.clientX) - from) / start.scale
    setDragging(true)
    document.body.style.cursor = heightOfPane ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (event: PointerEvent) => {
      const next = lengthFor(requested(event), start.stage)
      paint(start.box, next.px, next.snapped ? paneSizesNow().snap_ease_ms : 0)
    }
    const up = (event: PointerEvent) => {
      if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const next = lengthFor(requested(event), start.stage)
      paint(start.box, next.px)
      start.box.style.transition = ''
      document.body.style.cursor = 'auto'
      document.body.style.userSelect = 'auto'
      setDragging(false)
      commitRef.current(next.px)
      reportScreenCommand(heightOfPane ? 'Changed pane height' : 'Changed pane width', 'Workspace')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const fill = () => {
    const box = ref.current?.parentElement
    if (box) paint(box, null)
    commitRef.current(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const grow = heightOfPane ? 'ArrowDown' : 'ArrowRight'
    const shrink = heightOfPane ? 'ArrowUp' : 'ArrowLeft'
    if (e.key === 'Home') {
      e.preventDefault()
      fill()
      return
    }
    if (e.key !== grow && e.key !== shrink) return
    const now = measure()
    if (!now) return
    e.preventDefault()
    const px = Math.max(paneDragMinimumPx(), arrowPanePx(now.length, now.stage, e.key === grow ? 1 : -1, e.shiftKey))
    paint(now.box, px)
    commitRef.current(px)
  }

  const shownLength = savedLength === null ? null : Math.round(savedLength)
  return (
    <div
      ref={ref}
      role="separator"
      aria-orientation={heightOfPane ? 'horizontal' : 'vertical'}
      aria-label={heightOfPane ? "Change this pane's height" : "Change this pane's width"}
      aria-valuetext={shownLength === null
        ? `This pane fills the ${lengthName} beside it. Use the arrow keys to give it its own ${lengthName}.`
        : `This pane is ${shownLength} pixels ${heightOfPane ? 'tall' : 'wide'}. Use the arrow keys to change it; Home lets it fill again.`}
      tabIndex={0}
      data-pane-cross-edge={lengthName}
      className={cn(
        'absolute z-10 touch-none',
        heightOfPane ? 'bottom-0 left-0 right-0 h-0 cursor-row-resize' : 'right-0 top-0 bottom-0 w-0 cursor-col-resize',
      )}
      onPointerEnter={() => setIsHovered(true)}
      onPointerLeave={() => setIsHovered(false)}
      onPointerDown={begin}
      onDoubleClick={fill}
      onKeyDown={handleKeyDown}
    >
      {/* Invisible hit area along the edge, wider for a finger, kept inside the pane: on the arrangement's far edge
          anything past the pane makes the whole arrangement scroll sideways (or down). */}
      <div className={cn(
        'absolute',
        heightOfPane ? 'h-3 w-full -top-3 pointer-coarse:h-7 pointer-coarse:-top-7' : 'w-3 h-full -left-3 pointer-coarse:w-7 pointer-coarse:-left-7',
      )} />
      <motion.div
        className={cn(
          'absolute rounded',
          heightOfPane ? 'left-1/2 top-0 h-0.5 w-10 -translate-x-1/2 -translate-y-full' : 'top-1/2 left-0 w-0.5 h-10 -translate-y-1/2 -translate-x-full',
        )}
        initial={false}
        animate={{ opacity: isHovered || dragging ? 0.9 : 0, scale: isHovered || dragging ? 1 : 0.5 }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        style={{ backgroundColor: 'var(--border-focus)' }}
      />
    </div>
  )
}

/** ========== Gutter + Frame-edge Overlay ========== */
function leavesOf(n: SplitTreeNode): string[] {
  return collectLeafIds(n, [])
}

function GutterTargets({
  root,
  viewportRef,
  onDropTarget,
  splitAtFrameEdge,
  splitBetween,
  showGutters = true,
}: {
  root: SplitTreeNode
  viewportRef: React.RefObject<HTMLDivElement | null>
  onDropTarget: (t: DropTarget) => void
  splitAtFrameEdge: (edge: FrameEdge, payload: SurfacePlacementPayload, opts?: { optimistic?: boolean }) => Promise<void>
  splitBetween: (dir: 'row' | 'column', beforeId: string, afterId: string, payload: SurfacePlacementPayload) => Promise<void>
  showGutters?: boolean
}) {
  const [gutters, setGutters] = React.useState<
    Array<{ key: string; dir: 'row'|'column'; beforeId: string; afterId: string; rect: DOMRect }>
  >([])
  const [frame, setFrame] = React.useState<DOMRect | null>(null)
  const [activeKey, setActiveKey] = React.useState<string | null>(null)
  const frameSigRef = React.useRef<string>('null')
  const guttersSigRef = React.useRef<string>('')

  const drag = React.useContext(DragContext)
  const tabDrag = React.useContext(TabDragContext)
  const isTabMode = !!tabDrag?.draggingTabId && !drag?.draggingId
  // isContainerMode = !!drag?.draggingId && !tabDrag?.draggingTabId — used for container-only drag hints

  // If pointer leaves any container, drop any sticky gutter highlight.
  React.useEffect(() => {
    if (!isTabMode) return
    if (!tabDrag?.overContainerId) {
      setActiveKey(null)
    }
  }, [isTabMode, tabDrag?.overContainerId])


  // Global clear to avoid "ghost" highlights
  React.useEffect(() => {
    const clear = () => {
      setActiveKey(null)
      tabDrag?.setDraggingTabId?.(null)
      tabDrag?.setOverContainerId?.(null)
      tabDrag?.setEdgeHover?.(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') clear() }
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    window.addEventListener('keyup', onKey)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
      window.removeEventListener('keyup', onKey)
    }
  }, [tabDrag])

  const recompute = React.useCallback(() => {
    // Each recursive arrangement owns its own frame and targets. A page-wide
    // first match placed a nested arrangement's edge targets on another one.
    const container = viewportRef.current
    if (!container) return
    const cRect = container.getBoundingClientRect()

    const list: Array<{ key: string; dir: 'row'|'column'; beforeId: string; afterId: string; rect: DOMRect }> = []

    function containsId(n: SplitTreeNode, id: string | null): boolean {
      if (!id) return false
      if (isLeaf(n)) return getLeafId(n) === id
      return (n as SplitNode).children.some((c) => containsId(c, id))
    }

    function walk(n: SplitTreeNode) {
      if (isLeaf(n)) return
      const s = n as SplitNode
      for (let i = 0; i < s.children.length - 1; i++) {
        const leftChild = s.children[i]
        const rightChild = s.children[i + 1]
        // Hide gutters that involve the dragging container's own subtree (edge targets are clearer for reorder)
        if (containsId(leftChild, drag?.draggingId || null) || containsId(rightChild, drag?.draggingId || null)) {
          continue
        }
        const leftIds = leavesOf(leftChild)
        const rightIds = leavesOf(rightChild)
        const rl = subtreeRect(leftIds, container)
        const rr = subtreeRect(rightIds, container)
        if (!rl || !rr) continue

        let gx = 0, gy = 0, gw = 0, gh = 0
        if (s.dir === 'row') {
          const x = rl.right
          const overlapTop = Math.max(rl.top, rr.top)
          const overlapBot = Math.min(rl.bottom, rr.bottom)
          gx = x - 8; gy = overlapTop; gw = 16; gh = Math.max(0, overlapBot - overlapTop)
        } else {
          const y = rl.bottom
          const overlapLeft = Math.max(rl.left, rr.left)
          const overlapRight = Math.min(rl.right, rr.right)
          gx = overlapLeft; gy = y - 8; gw = Math.max(0, overlapRight - overlapLeft); gh = 16
        }
        const rect: DOMRect = { x: gx, y: gy, left: gx, top: gy, right: gx+gw, bottom: gy+gh, width: gw, height: gh, toJSON(){return this as any} } as DOMRect
        list.push({
          key: `${leftIds[0]}->${rightIds[0]}@${i}`,
          dir: s.dir,
          beforeId: leftIds[0],
          afterId: rightIds[0],
          rect
        })
      }
      s.children.forEach((c) => walk(c))
    }

    walk(root)
    const nextFrameSig = rectSignature(cRect)
    if (frameSigRef.current !== nextFrameSig) {
      frameSigRef.current = nextFrameSig
      setFrame(cRect)
    }

    const nextGuttersSig = guttersSignature(list)
    if (guttersSigRef.current !== nextGuttersSig) {
      guttersSigRef.current = nextGuttersSig
      setGutters(list)
    }
  }, [root, drag?.draggingId, viewportRef])

  React.useLayoutEffect(() => {
    recompute()
    const ro = new ResizeObserver(() => recompute())
    viewportRef.current?.querySelectorAll('[data-container-id]').forEach(el => ro.observe(el))
    window.addEventListener('scroll', recompute, true)
    window.addEventListener('resize', recompute)
    return () => {
      ro.disconnect()
      window.removeEventListener('scroll', recompute, true)
      window.removeEventListener('resize', recompute)
    }
  }, [recompute, viewportRef])


  if (!frame) return null
  const toLocal = (r: DOMRect) => ({ left: r.left - frame.left, top: r.top - frame.top, width: r.width, height: r.height })

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = hasPlaceableSurface(e.dataTransfer) ? 'copy' : 'move'
  }

  const onDropGutter = async (event: React.DragEvent, g: typeof gutters[number]) => {
    const isContainerDrag = !!drag?.draggingId
    const isTabDrag  = !!tabDrag?.draggingTabId
    const surfaceTab = readPlaceableSurfaceTab(event.dataTransfer)
    if (isContainerDrag) {
      onDropTarget({ kind: 'split-gutter', dir: g.dir, beforeId: g.beforeId, afterId: g.afterId })
      return
    }
    if (isTabDrag) {
      const tabId = tabDrag!.draggingTabId as string
      await splitBetween(g.dir, g.beforeId, g.afterId, { kind: 'tab', tabId })
      tabDrag?.setDraggingTabId(null)
      tabDrag?.setOverContainerId(null)
      tabDrag?.setEdgeHover?.(null)
      setActiveKey(null)
    }
    if (surfaceTab) {
      await splitBetween(g.dir, g.beforeId, g.afterId, { kind: 'surface', tab: surfaceTab })
      tabDrag?.setOverContainerId(null)
      tabDrag?.setEdgeHover?.(null)
      setActiveKey(null)
    }
  }


  // 8px matches the arranger's p-2 padding — zones stay in the padding gutter,
  // never overlapping container tab bars. (Was 32px which covered 24px of the tab area.)
  const FRAME_EDGE_PX = 8
  // Note: GutterTargets is already conditionally rendered by showTargets in the parent
  // (line 164: {showTargets && <GutterTargets .../>}), so this component only mounts
  // when a drag is active. No additional isDragActive guard needed.

  return (
    <div className="pointer-events-none absolute inset-0" style={{ zIndex: 60 }}>

      {/* Split-gutters: visible when showGutters is true (container drag, no edge hover) */}
      {showGutters && gutters.map((g) => {
        const r = toLocal(g.rect)
        const isTab = !!tabDrag?.draggingTabId
        return (
          <div
            key={g.key}
            className={cn(
              'pointer-events-auto',
              'absolute rounded-md border-2 border-dashed',
              'border-[var(--border-focus)] bg-[var(--glass-bg-subtle)]',
              activeKey === g.key ? 'opacity-100' : 'opacity-0'
            )}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height, zIndex: 1 }}
            onDragOver={(e) => { tabDrag?.setOverContainerId?.(g.beforeId); setActiveKey(g.key); onDragOver(e) }}
            onDragEnter={() => { tabDrag?.setOverContainerId?.(g.beforeId); setActiveKey(g.key) }}
            onDragLeave={() => { if (activeKey === g.key) tabDrag?.setOverContainerId?.(null); setActiveKey((k) => k === g.key ? null : k) }}
            onDrop={(e) => {
              e.preventDefault(); e.stopPropagation()
              onDropGutter(e, g)
            }}
            title={isTab ? 'Drop tab here (creates new container)' : 'Move container here'}
          />
        )
      })}

      {/* Frame-edge drop zones — thin strips along all 4 outer edges of the frame.
          Dropping here wraps the ENTIRE root in a new split (creates the A/B|C layout). */}
      {frame && (['left', 'right', 'top', 'bottom'] as FrameEdge[]).map((edge) => {
        const pos = edge === 'left'
          ? { left: 0, top: 0, width: FRAME_EDGE_PX, height: frame.height }
          : edge === 'right'
          ? { left: frame.width - FRAME_EDGE_PX, top: 0, width: FRAME_EDGE_PX, height: frame.height }
          : edge === 'top'
          ? { left: 0, top: 0, width: frame.width, height: FRAME_EDGE_PX }
          : { left: 0, top: frame.height - FRAME_EDGE_PX, width: frame.width, height: FRAME_EDGE_PX }

        const key = `frame-${edge}`
        return (
          <div
            key={key}
            className={cn(
              'pointer-events-auto',
              'absolute rounded-md border-2 border-dashed',
              'border-[var(--border-focus)] bg-[var(--glass-bg-subtle)]',
              activeKey === key ? 'opacity-100' : 'opacity-0'
            )}
            style={{ ...pos, zIndex: 2 }}
            onDragOver={(e) => { setActiveKey(key); onDragOver(e) }}
            onDragEnter={() => setActiveKey(key)}
            onDragLeave={() => setActiveKey((k) => k === key ? null : k)}
            onDrop={async (e) => {
              e.preventDefault()
              e.stopPropagation()

              const surfaceTab = readPlaceableSurfaceTab(e.dataTransfer)
              if (surfaceTab) {
                await splitAtFrameEdge(edge, { kind: 'surface', tab: surfaceTab })
                tabDrag?.setOverContainerId(null)
                tabDrag?.setEdgeHover?.(null)
                setActiveKey(null)
                return
              }

              // Tab drops → move tab to new container at frame edge
              if (tabDrag?.draggingTabId) {
                await splitAtFrameEdge(edge, { kind: 'tab', tabId: tabDrag.draggingTabId })
                tabDrag.setDraggingTabId(null)
                tabDrag.setOverContainerId(null)
                tabDrag.setEdgeHover?.(null)
                setActiveKey(null)
                return
              }

              // Container drops → move container to frame edge
              if (drag?.draggingId) {
                onDropTarget({ kind: 'frame-edge', edge })
                drag.setDraggingId(null)
                drag.setOverId(null)
                drag.setEdgeHover?.(null)
                setActiveKey(null)
              }
            }}
            title={`Drop to create pane at ${edge} edge`}
          />
        )
      })}
    </div>
  )
}

// Drawn inside MotionFeatures (ui/motion/lazy-motion.tsx): its motion arrives after the first paint, without remounting.
export default function SplitTreeArranger(props: React.ComponentProps<typeof SplitTreeArrangerMoving>) {
  return <MotionFeatures><SplitTreeArrangerMoving {...props} /></MotionFeatures>
}
