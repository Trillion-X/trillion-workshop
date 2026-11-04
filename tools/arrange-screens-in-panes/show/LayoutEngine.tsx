// frontends/web/src/packages/screen-arrangement/view/LayoutEngine.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Top-level orchestrator for the screen-arrangement system. Composes the three
// arrangers (SplitTree, Freeform, Overlay) based on active surface mode.
// Wraps everything in DragContext + TabDragContext + PendingMoveContext.
// Connects arranger callbacks to the screen-arrangement owner context.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. surface === 'grid'   → render SplitTreeArranger (tiled)
// 2. surface === 'canvas' → render FreeformArranger (floating)
// 3. OverlayArranger ALWAYS renders (PiP layer on top of any surface)
// 4. All state mutations go through the screen-arrangement owner
// 5. ContainerHost is the universal content renderer for all arrangers
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client'

import { createPortal } from 'react-dom'
import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { lazyPart } from '../../ui/show/load-later/later';
import { SCREEN_ARRANGEMENT_FOCUS_REQUEST } from './use-focus-container-while'
import { useBitfieldData, readRecordAt, subscribe } from '#workspace-records'
import {
  DragContext,
  LayoutActionsContext,
  LayoutStateContext,
  PlaceableSurfaceListAddressContext,
  TabDragContext,
  PendingMoveContext,
  OfferedSurfacesContext,
  ArrangementHostDataContext,
  type FrameEdge,
} from './screen-arrangement-context'
import { tabsToCloseForCatalog } from './placeable-surface-tab'
import { ViewerAccessRefsContext, replayPendingPlaceableSurfaceIntents } from '../../ui/show/placeable-surface-intent'
import { MarkSessionProvider, useMarkSession } from '../../addressed-marks/show/MarkSessionContext'
import { MarkInputLayer } from '../../addressed-marks/show/MarkInputLayer'
import { AddressedMarkOverlay } from '../../addressed-marks/show/AddressedMarkOverlay'
import { LAYER_ORDER } from '../../ui/show/layer-order/layer-order'
import {
  canvasWorldMarkTarget,
  resolveScreenPointerSpace,
  screenMarkTarget,
  shownOnScreenMarkTarget,
  WHOLE_SCREEN_AREA,
  createArrangementPointerSpaceResolver,
  frameMarkTarget,
} from './mark-targets'
import SplitTreeArranger, { type SurfacePlacementPayload } from './SplitTreeArranger'
import type { FreeformPlacementPayload } from './FreeformArranger'
// A canvas (floating windows on a pannable graph) is fetched the first time a layer is laid out as one.
const FreeformArranger = lazyPart(() => import('./FreeformArranger'), module => module.default)
import { ArrangementSection } from './ArrangementSection'
import OverlayArranger from './OverlayArranger'
import ContainerHost from './ContainerHost'
import { ContainerSlot, StableContainerContent } from './stable-container-content'
import { LocalSurfaceVisibilityContext } from './embedded-surface-content'
import { containerIsVisible } from '../read-data/surface-visibility'
import { PLACEABLE_SURFACE_MIME, readPlaceableSurfaceTabOrAdmitEntry } from './placeable-surface-drag'
import {
  readPlaceableSurfacesWithInputOverrides,
  readPublishedRecords,
  surfaceInputOverridesReadInput,
} from '../read-data/read-published-records'
import { offerableSurfaces } from '../../ui/show/placeable-surface-intent/placeable-surface-record'
import { createPlaceableSurfaceOpener, placeableSurfacePayloadOpens } from './open-placeable-surface'

// How long after a press or key in a pane an open still counts as asked for by that pane: long enough for a screen
// that reads its data before opening, short enough that a later open from elsewhere is not placed beside it.
const PANE_GESTURE_OPEN_WINDOW_MS = 4000
import { RegionDropRouter } from '../../ui/show/region-drop-intent/RegionDropRouter'
import { buildRegionDropIntents, isOverStage } from './region-drop-intents'
import { cn } from '../../ui/show/cn'
import { FocusOverlay } from '../../ui/show/focus-overlay/FocusOverlay'
import { Container } from '../../ui/show/container';
import { VisualLayerStack, createCapabilityMap, builtinVisualLayerCapabilities } from '../../ui/show/visual-layer-stack';
import { AddressedSurfaceIntentReader, AddressedSurfaceIntentRecipient, surfaceIntentMatchesCatalogPayload, type SurfaceIntentReaderConfig } from '../../ui/show/placeable-surface-intent'
import { surfaceRegion, regionAddressKey } from '../read-data/region-address'
import { hasImmersiveRegion, clearImmersiveRegions } from '../read-data/region-chrome'
import { useNodeMenuController, NodeMenuContext, nodeMenuContextHandler, nodeRefAttr } from './node-menu-controller'
import { removeOverlayWindow } from '../read-data/place-tab-in-overlay'
import { useVisualLayerSubjectResolver, appendRegionLayer } from './visual-layer-runtime'
import type {
  TiledLayout,
  FloatingLayout,
  OverlayLayout,
} from '../read-data/layout-types'
import { usableLayerId } from '../read-data/read-screen-arrangement'
import { OpenAskedLayout } from './open-asked-layout'
import { InsideArrangement, NestedArrangement, TakeBehindPanesAsks } from './behind-the-panes'
import { setPageBackdrop, usePageBackdrop } from '../../ui/show/page-backdrop'
import { PublishShownArrangement } from './publish-shown-arrangement'
import { type SurfaceMode, baseGeometryForSurface } from '../read-data/surface-modes'

// The drawing toolbar's code is fetched the first time it is drawn, never with the page.
const LazyMarkToolbar = lazyPart(() => import('../../addressed-marks/show/MarkToolbar'), module => module.MarkToolbar)
const MarkToolbar = () => <React.Suspense fallback={null}><LazyMarkToolbar /></React.Suspense>

// ---------------------------------------------------------------------------
// LAYOUT ENGINE
// ---------------------------------------------------------------------------

function positionForFrameEdge(edge: FrameEdge): 'before' | 'after' {
  return edge === 'right' || edge === 'bottom' ? 'after' : 'before'
}

export type LayoutEngineProps = {
  useGlobalSurfaceIntents?: boolean
  surfaceIntentReader?: SurfaceIntentReaderConfig | null
  surfaceIntentDestinationRef?: string | null
  addressedSurfaceTargetContainerId?: string | null
}

export type LayoutEngineViewProps = LayoutEngineProps & {
  publishedRecordsEntry: unknown
  placeableSurfaceListEntry: unknown
  placeableSurfaceInputOverridesEntry?: unknown
}

// ---------------------------------------------------------------------------
// ARRANGEMENT MARK LAYERS
// ---------------------------------------------------------------------------
//
// Drawing across the whole arrangement:
// - display overlay for the canvas WORLD (canvas mode): marks live in world
//   pixels; the viewBox follows the camera so ink pans/zooms with the world
// - display overlay for the arrangement FRAME (grid mode): normalized ink
//   over the whole tiled area (headers, gutters, everything)
// - ONE MarkInputLayer capturing strokes for every addressed space (PIP box,
//   floating window tab, tile tab, world, frame) via the pointer-space
//   resolver — screen-arrangement owns the geometry, addressed-marks owns ink
// - the MarkToolbar, floating bottom-center while drawing is active
// - the WHOLE SCREEN (the page's own arrangement only): ink normalized to the
//   window, drawn over the sidebar, every pane and the gaps between them; while
//   the person draws there, the input layer and toolbar cover the window too
//
export function ArrangementMarkLayers({
  rootRef,
  surface,
  camera,
  ownsScreen,
}: {
  rootRef: React.RefObject<HTMLDivElement | null>
  surface: SurfaceMode
  camera: { scale: number; tx: number; ty: number }
  ownsScreen: boolean
}) {
  const session = useMarkSession()
  const wholeScreen = ownsScreen && session?.area === WHOLE_SCREEN_AREA
  const [rootSize, setRootSize] = useState<{ width: number; height: number } | null>(null)
  const surfaceRef = useRef(surface)
  surfaceRef.current = surface
  const cameraRef = useRef(camera)
  cameraRef.current = camera

  useEffect(() => {
    const element = rootRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setRootSize({ width: rect.width || 1, height: rect.height || 1 })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [rootRef])

  const resolvePointerSpace = useMemo(() => createArrangementPointerSpaceResolver({
    rootElement: () => rootRef.current,
    surface: () => surfaceRef.current,
    camera: () => cameraRef.current,
  }), [rootRef])

  const worldTarget = useMemo(() => canvasWorldMarkTarget(), [])
  const frameTarget = useMemo(() => frameMarkTarget(), [])
  const screenTarget = useMemo(() => screenMarkTarget(), [])
  const shownTarget = useMemo(() => shownOnScreenMarkTarget(), [])
  const zoom = camera.scale || 1
  const worldViewBox = rootSize
    ? `${(0 - camera.tx) / zoom} ${(0 - camera.ty) / zoom} ${rootSize.width / zoom} ${rootSize.height / zoom}`
    : undefined

  return (
    <>
      {baseGeometryForSurface(surface) === 'floating' && worldViewBox ? (
        <AddressedMarkOverlay
          target={worldTarget}
          enabled={false}
          viewBox={worldViewBox}
          className="z-[10005]"
        />
      ) : null}
      {/* Frame ink overlays the arrangement in BOTH modes — the frame exists
          regardless of how its containers are arranged. World ink is canvas-
          mode only because only the canvas mode has the camera world. */}
      <AddressedMarkOverlay
        target={frameTarget}
        enabled={false}
        className="z-[10005]"
      />
      {wholeScreen ? null : (
        <>
          <MarkInputLayer
            resolvePointerSpace={resolvePointerSpace}
            className="z-[10010]"
          />
          {/* Self-positioning: the toolbar owns its dock/float placement through
              the generic ui dockable-placement primitive (same as the sidebar). */}
          <React.Suspense fallback={null}><MarkToolbar /></React.Suspense>
        </>
      )}
      {ownsScreen && typeof document !== 'undefined' ? createPortal(
        <Container position="fixed" inset="0" pointerEvents="none" className="coss-ui z-[10005]" data-whole-screen-marks>
          <AddressedMarkOverlay target={screenTarget} enabled={false} />
          {wholeScreen ? (
            <>
              <MarkInputLayer resolvePointerSpace={resolveScreenPointerSpace} className="z-[10010]" />
              <React.Suspense fallback={null}><MarkToolbar /></React.Suspense>
            </>
          ) : null}
        </Container>,
        document.body,
      ) : null}
      {ownsScreen && typeof document !== 'undefined' ? createPortal(
        <Container position="fixed" inset="0" pointerEvents="none" className="coss-ui" style={{ zIndex: LAYER_ORDER.walkthrough + 1 }} data-shown-on-screen-marks>
          <AddressedMarkOverlay target={shownTarget} enabled={false} />
        </Container>,
        document.body,
      ) : null}
    </>
  )
}

export function LayoutEngineView({
  publishedRecordsEntry,
  placeableSurfaceListEntry,
  placeableSurfaceInputOverridesEntry,
  useGlobalSurfaceIntents = true,
  surfaceIntentReader = null,
  surfaceIntentDestinationRef = null,
  addressedSurfaceTargetContainerId = null,
}: LayoutEngineViewProps) {
  // An arrangement drawn inside a screen of another arrangement; only the outermost one owns the page.
  const nested = React.useContext(InsideArrangement)
  const layoutState = React.useContext(LayoutStateContext)
  const hiddenSurfaces = React.useContext(LocalSurfaceVisibilityContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  if (!layoutState || !layoutActions) throw new Error('Screen-arrangement owner context missing for LayoutEngine')

  // The ONE node-context menu for the whole surface (SSOT). Tabs open it
  // explicitly via NodeMenuContext; container bodies and the canvas open it by
  // delegation — any region stamping `data-node-ref` gets a menu for free.
  const nodeMenu = useNodeMenuController()
  const nodeMenuValue = useMemo(() => ({ openFor: nodeMenu.openFor }), [nodeMenu.openFor])
  const onRegionContextMenu = useMemo(() => nodeMenuContextHandler(nodeMenu.openFor), [nodeMenu.openFor])

  const { surface, layouts, focusedContainerId, maximizedContainerId } = layoutState
  useEffect(() => {
    const handleFocusRequest = (event: Event) => {
      const pane = (event.target as Element | null)?.closest?.('[data-container-id]') as HTMLElement | null
      const containerId = pane?.dataset.containerId
      const active = (event as CustomEvent<{ active?: unknown }>).detail?.active
      if (!containerId || typeof active !== 'boolean' || !layoutState.containers[containerId]) return
      void layoutActions.flush().then(current => {
        if (!current.containers[containerId]) return
        if (active && current.maximizedContainerId === null) layoutActions.toggleMaximize(containerId)
        if (!active && current.maximizedContainerId === containerId) layoutActions.toggleMaximize(containerId)
      })
    }
    window.addEventListener(SCREEN_ARRANGEMENT_FOCUS_REQUEST, handleFocusRequest)
    return () => window.removeEventListener(SCREEN_ARRANGEMENT_FOCUS_REQUEST, handleFocusRequest)
  }, [layoutActions, layoutState.containers])
  // Render by the active mode's BASE GEOMETRY (data-registry lookup), never by a
  // `=== 'canvas'` label branch — so a new mode reusing a geometry just works.
  const baseGeometry = baseGeometryForSurface(surface)
  // `published-records` — but screen-arrangement's OWN input descriptor repoints it
  // to a scoped reply-provider sink (record_from_matching_records, kind==reply-template),
  // NOT the 34.7MB global aggregate. The aggregate shares the
  // `[current-item,published-record]` path with hot-write layout-state, so every "+"
  // (new tab) write invalidated it and re-delivered 34.7MB + re-parsed ~27781 records
  // here — the "empty tab takes dozens of seconds" symptom. A layout-state write is not
  // a reply-template, so the scoped sink emits NOOP and this subscription never re-fires
  // on tab churn. Kept the input NAME `published-records` so the 6 packages that bundle
  // this component (EmbeddedScreenArrangement embedders) still resolve their own
  // declaration and are not forced to declare a renamed input. Feeds
  // ShowRepliesScreenCanUse's target discovery.
  const publishedRecords = useMemo(
    () => readPublishedRecords(publishedRecordsEntry),
    [publishedRecordsEntry],
  )
  // Scope the offerable surface catalog to what THIS viewer may open. The held
  // refs come from context (ViewerAccessRefsProvider); `undefined` = no capability
  // context (studio owner shell) → offerableSurfaces returns the full catalog
  // unchanged. A scoping app (a customer app) supplies the account's held refs and
  // gated surfaces the viewer lacks are dropped from the picker + New-tab menu.
  const viewerAccessRefs = React.useContext(ViewerAccessRefsContext)
  // Everything this viewer may open. A pane already on screen, and a surface a
  // link asks for by name, resolve against THIS list.
  const placeableSurfaces = useMemo(
    () => offerableSurfaces(readPlaceableSurfacesWithInputOverrides(
      placeableSurfaceListEntry,
      placeableSurfaceInputOverridesEntry,
    ), viewerAccessRefs),
    [placeableSurfaceListEntry, placeableSurfaceInputOverridesEntry, viewerAccessRefs],
  )
  // ⚠️ The allowlist is applied by the two things that OFFER a surface, the
  // empty-container picker and the new-tab menu, and by nothing else.
  //
  // Narrowing the OFFER is not the same as deleting what is already open, and
  // collapsing the two broke a signed-in person's saved workspace: every pane
  // they had open stopped resolving, the scene produced nothing, and the shell
  // painted "Your workspace could not be shown". A fresh browser was fine,
  // because it had no layout to lose, so it failed only for people who had
  // actually used the product, and only after they signed in.
  //
  // The same reasoning covers a link: a URL naming a surface opens it, because
  // being sent somewhere is not the same as being offered to go there.

  // A host whose catalog holds every screen it can show (tabsOutsideCatalog: 'close') closes a saved tab that names
  // a screen it no longer offers. A paginated host distinguishes an unknown later-page row from an owner explicitly
  // withdrawn from its previous offer: unknown tabs wait, known withdrawals close even while another read failed.
  // The status is shared record data, including in nested panes.
  const hostData = React.useContext(ArrangementHostDataContext)
  const catalogState = React.useSyncExternalStore(subscribe,
    () => hostData.catalogStateAddressLabel ? readRecordAt<{ complete?: boolean; withdrawn?: unknown }>(hostData.catalogStateAddressLabel) : null,
    () => null)
  const catalogComplete = !hostData.catalogStateAddressLabel || catalogState?.complete === true
  const withdrawnSurfaces = useMemo(
    () => readPlaceableSurfacesWithInputOverrides(catalogState?.withdrawn, placeableSurfaceInputOverridesEntry),
    [catalogState?.withdrawn, placeableSurfaceInputOverridesEntry],
  )
  useEffect(() => {
    if (hostData.tabsOutsideCatalog !== 'close' || (!hostData.catalogStateAddressLabel && placeableSurfaces.length === 0)) return
    for (const tab of tabsToCloseForCatalog(Object.values(layoutState.tabs), placeableSurfaces, { complete: catalogComplete, withdrawn: withdrawnSurfaces })) {
      void layoutActions.closeTab(tab.id)
    }
  }, [hostData.tabsOutsideCatalog, hostData.catalogStateAddressLabel, catalogComplete, withdrawnSurfaces, layoutActions, layoutState.tabs, placeableSurfaces])

  // --- Drag contexts (ephemeral, not persisted) ---
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [overContainerId, setOverContainerId] = useState<string | null>(null)
  const [edgeHover, setEdgeHover] = useState<{ containerId: string; edge: FrameEdge } | null>(null)
  const [tabEdgeHover, setTabEdgeHover] = useState<{ containerId: string; edge: FrameEdge } | null>(null)
  const [pending, setPending] = useState<Record<string, { targetContainerId: string; index: number; moveId: string }>>({})
  const [activeHints, setActiveHints] = useState<Record<string, string>>({})
  const opQueue = useRef<Record<string, Array<() => Promise<void>>>>({})
  // Root of the drawable arrangement area (input layer + space resolution bounds)
  const markRootRef = useRef<HTMLDivElement | null>(null)
  // Whether this arrangement is drawn inside another one's screen. A screen mounted in its own React root does not
  // carry InsideArrangement, so the page answers too: an arranger above this one. Unknown until the first draw.
  const [insideAnother, setInsideAnother] = useState<boolean | null>(null)
  React.useLayoutEffect(() => {
    setInsideAnother(!!markRootRef.current?.parentElement?.closest('[data-arranger]'))
  }, [])
  const outermost = !nested && insideAnother === false

  // Delegated right-click: any region under the surface root that stamps
  // `data-node-ref` opens the shared node menu (container bodies, the canvas).
  // Native listener (not JSX onContextMenu) so the surface-root markup is
  // untouched; tab right-clicks call openFor explicitly and stop propagation,
  // so they never double-fire here.
  React.useEffect(() => {
    const el = markRootRef.current
    if (!el) return
    el.addEventListener('contextmenu', onRegionContextMenu)
    return () => el.removeEventListener('contextmenu', onRegionContextMenu)
  }, [onRegionContextMenu])

  const commitSwap = useCallback((a: string, b: string) => {
    layoutActions.swapContainers(a, b)
  }, [layoutActions])

  const dragCtx = useMemo(() => ({
    draggingId,
    overId,
    setDraggingId,
    setOverId,
    commitSwap,
    edgeHover,
    setEdgeHover,
  }), [draggingId, overId, commitSwap, edgeHover])

  const tabDragCtx = useMemo(() => ({
    draggingTabId,
    overContainerId,
    setDraggingTabId,
    setOverContainerId,
    edgeHover: tabEdgeHover,
    setEdgeHover: setTabEdgeHover,
  }), [draggingTabId, overContainerId, tabEdgeHover])

  const pendingCtx = useMemo(() => ({
    pending,
    setPending,
    activeHints,
    setActiveHints,
    opQueue,
  }), [pending, activeHints])

  // Safety net: native HTML5 DnD can occasionally miss component-level dragend.
  // Clear ephemeral tab-drag state globally so invisible drop overlays don't stick.
  useEffect(() => {
    const clearTabDrag = () => {
      setDraggingTabId(null)
      setOverContainerId(null)
      setTabEdgeHover(null)
    }
    window.addEventListener('dragend', clearTabDrag)
    window.addEventListener('drop', clearTabDrag)
    window.addEventListener('pointerup', clearTabDrag, true)
    return () => {
      window.removeEventListener('dragend', clearTabDrag)
      window.removeEventListener('drop', clearTabDrag)
      window.removeEventListener('pointerup', clearTabDrag, true)
    }
  }, [])

  // Every open goes through one queue that decides it against the arrangement as it stands once the opens before it
  // have landed (createPlaceableSurfaceOpener), so the same screen with the same input asked for twice in a row is
  // one tab, shown.
  const openSettled = useMemo(() => createPlaceableSurfaceOpener(layoutActions), [layoutActions])
  const placeableSurfacesRef = useRef(placeableSurfaces)
  placeableSurfacesRef.current = placeableSurfaces
  const openSurfacePayload = useCallback((raw: unknown) => openSettled({ raw, surfaces: placeableSurfacesRef.current }), [openSettled])
  const openAddressedSurfacePayload = useCallback(async (raw: unknown, _deliveryRef: string): Promise<boolean> => {
    const opened = await openSettled({
      raw,
      surfaces: placeableSurfacesRef.current,
      deduplicate: true,
      targetContainerId: addressedSurfaceTargetContainerId,
    })
    if (!opened) return false
    try {
      await layoutActions.awaitDurable()
      return true
    } catch {
      return false
    }
  }, [addressedSurfaceTargetContainerId, layoutActions, openSettled])

  const surfaceIntentCatalog = useMemo(
    () => placeableSurfaces.map((surface) => ({
      ...(surface.packageEntry ? { packageEntry: surface.packageEntry } : {}),
      materialTarget: surface.materialTarget,
      ...(surface.target ? { target: surface.target } : {}),
      ...(surface.surfaceInput ? { surfaceInput: surface.surfaceInput } : {}),
    })),
    [placeableSurfaces],
  )

  // The pane the person last pressed or typed in. An open that arrives right
  // after such a gesture was asked for by that pane (a row, a button, a link in
  // it), so it opens beside that pane instead of on top of it.
  const lastPaneGestureRef = useRef<{ containerId: string | null; at: number }>({ containerId: null, at: 0 })
  useEffect(() => {
    if (!useGlobalSurfaceIntents || typeof document === 'undefined') return undefined
    const noteGesture = (event: Event) => {
      const pane = (event.target as Element | null)?.closest?.('[data-container-id]') as HTMLElement | null
      lastPaneGestureRef.current = { containerId: pane?.dataset.containerId ?? null, at: performance.now() }
    }
    document.addEventListener('pointerdown', noteGesture, true)
    document.addEventListener('keydown', noteGesture, true)
    return () => {
      document.removeEventListener('pointerdown', noteGesture, true)
      document.removeEventListener('keydown', noteGesture, true)
    }
  }, [useGlobalSurfaceIntents])

  useEffect(() => {
    if (!useGlobalSurfaceIntents) return undefined
    const handlePlaceableSurfaceIntent = (event: Event) => {
      if (event.defaultPrevented) return
      const raw = (event as CustomEvent<unknown>).detail
      // Taken at once when it names something this arrangement shows; where it lands is decided in the queue.
      if (!placeableSurfacePayloadOpens(raw, placeableSurfacesRef.current)) return
      event.preventDefault()
      const gesture = lastPaneGestureRef.current
      const sourcePane = performance.now() - gesture.at <= PANE_GESTURE_OPEN_WINDOW_MS ? gesture.containerId : null
      // One gesture places one open; a later open is placed by its own gesture.
      if (sourcePane) lastPaneGestureRef.current = { containerId: null, at: 0 }
      void openSettled({ raw, surfaces: placeableSurfacesRef.current, sourceContainerId: sourcePane })
    }
    window.addEventListener(PLACEABLE_SURFACE_MIME, handlePlaceableSurfaceIntent)
    replayPendingPlaceableSurfaceIntents()
    return () => window.removeEventListener(PLACEABLE_SURFACE_MIME, handlePlaceableSurfaceIntent)
  }, [openSettled, useGlobalSurfaceIntents])

  // --- Surface layouts ---
  const tiled = layouts.find((l): l is TiledLayout => l.type === 'tiled')!
  const floating = layouts.find((l): l is FloatingLayout => l.type === 'floating')!
  const renderLayers = (layoutState.layers?.length
    ? layoutState.layers
    : [{ id: 'default', z: 0, layouts }])
    .slice()
    .sort((left, right) => left.z - right.z)
  const activeLayerId = layoutState.activeLayerId ?? renderLayers[0]?.id
  // The layer that takes pointer and keyboard input: the chosen one, or the topmost layer holding work when the chosen
  // one is empty or no longer drawn, so an out-of-date remembered layer never leaves every layer ignoring clicks.
  const interactiveLayerId = usableLayerId(renderLayers, activeLayerId, layouts)

  // --- Universal container renderer ---
  // Each container's content is mounted once, keyed by its id, by
  // StableContainerContent below; every arranger (and the full-screen overlay)
  // only draws a slot the content moves into. A split, swap, maximize or move
  // between arrangers changes where a pane is drawn, never its identity, so no
  // open screen reloads (stable-container-content.tsx).
  const renderContainerContent = useCallback((containerId: string) => (
    <ContainerHost
      containerId={containerId}
      placeableSurfaces={placeableSurfaces}
      publishedRecords={publishedRecords}
      surfaceIntentDestinationRef={surfaceIntentDestinationRef}
    />
  ), [placeableSurfaces, publishedRecords, surfaceIntentDestinationRef])
  const renderContainer = useCallback((containerId: string) => (
    <ContainerSlot containerId={containerId} />
  ), [])

  // --- Split tree callbacks ---
  // The arranger measures and clamps; the slot records the pane sizes it hands
  // over as that split's pixel sizes.
  const handleSplitResize = useCallback((path: number[], sizesPx: number[]) => {
    layoutActions.resizeSplit(sizesPx, path)
  }, [layoutActions])
  const handleCrossResize = useCallback((path: number[], index: number, lengthPx: number | null) => {
    layoutActions.resizeCross(path, index, lengthPx)
  }, [layoutActions])

  const handleDropTarget = useCallback((target: { kind: string; edge?: string; containerId?: string; dir?: string; beforeId?: string; afterId?: string }) => {
    if (!draggingId) return

    if (target.kind === 'container-edge' && target.containerId && target.edge) {
      const dir = (target.edge === 'left' || target.edge === 'right') ? 'row' : 'column'
      layoutActions.moveContainerToEdge(
        draggingId,
        target.containerId,
        dir as 'row' | 'column',
        positionForFrameEdge(target.edge as FrameEdge),
      )
    } else if (target.kind === 'split-gutter' && target.beforeId && target.dir) {
      layoutActions.moveContainerToEdge(draggingId, target.beforeId, target.dir as 'row' | 'column')
    } else if (target.kind === 'frame-edge' && target.edge) {
      const dir = (target.edge === 'left' || target.edge === 'right') ? 'row' : 'column'
      const position = positionForFrameEdge(target.edge as FrameEdge)
      layoutActions.moveContainerToRoot(draggingId, dir as 'row' | 'column', position)
    }
  }, [draggingId, layoutActions])

  const handleDropTabIntoContainer = useCallback(async (containerId: string, tabId: string) => {
    layoutActions.moveTabToContainer(tabId, containerId)
  }, [layoutActions])

  const handleDropTabAtContainerEdge = useCallback(async (containerId: string, edge: FrameEdge, tabId: string) => {
    // Atomic: create new container with the tab adjacent to the target in the split tree
    const dir = (edge === 'left' || edge === 'right') ? 'row' : 'column'
    layoutActions.splitContainerWithTab(containerId, dir, tabId, positionForFrameEdge(edge))
  }, [layoutActions])

  const handleDropSurfaceAtContainerEdge = useCallback(async (containerId: string, edge: FrameEdge, tab: TabMeta) => {
    const dir = (edge === 'left' || edge === 'right') ? 'row' : 'column'
    layoutActions.splitContainerWithSurface(containerId, dir, tab, positionForFrameEdge(edge))
  }, [layoutActions])

  const handleSplitAtFrameEdge = useCallback(async (
    edge: FrameEdge,
    payload: SurfacePlacementPayload,
  ) => {
    // Root-level split: wraps entire tree, placing the tab in a new pane at the frame edge
    const dir = (edge === 'left' || edge === 'right') ? 'row' : 'column'
    const position = (edge === 'right' || edge === 'bottom') ? 'after' : 'before'
    if (payload.kind === 'surface') {
      layoutActions.splitRootWithSurface(dir, position, payload.tab)
      return
    }
    layoutActions.splitRootWithTab(dir, position, payload.tabId)
  }, [layoutActions])

  const handleSplitBetween = useCallback(async (
    dir: 'row' | 'column',
    beforeId: string,
    _afterId: string,
    payload: SurfacePlacementPayload,
  ) => {
    // Split adjacent to the 'before' container
    if (payload.kind === 'surface') {
      layoutActions.splitContainerWithSurface(beforeId, dir, payload.tab)
      return
    }
    layoutActions.splitContainerWithTab(beforeId, dir, payload.tabId)
  }, [layoutActions])

  // --- Freeform callbacks ---
  const handleFreeformMove = useCallback((containerId: string, xy: { x: number; y: number }) => {
    layoutActions.moveFloating(containerId, xy)
  }, [layoutActions])

  const handleFreeformResize = useCallback((containerId: string, rect: { x: number; y: number; w: number; h: number }) => {
    layoutActions.updateFloatingRect(containerId, rect)
  }, [layoutActions])

  const handleFreeformBringToFront = useCallback((containerId: string) => {
    layoutActions.bringFloatingToFront(containerId)
  }, [layoutActions])

  const handleCameraChange = useCallback((patch: Partial<{ scale: number; tx: number; ty: number }>) => {
    layoutActions.setCamera(patch)
  }, [layoutActions])

  const handleCreateContainerAt = useCallback(async (
    xy: { x: number; y: number },
    payload: FreeformPlacementPayload,
    rect?: Partial<{ w: number; h: number }>,
  ) => {
    // Create a floating container at the drop position with the dragged tab
    const w = rect?.w ?? 400
    const h = rect?.h ?? 300
    if (payload.kind === 'surface') {
      layoutActions.createFloatingContainerWithSurface(payload.tab, { x: xy.x, y: xy.y, w, h })
      return
    }
    layoutActions.createFloatingContainerWithTab(payload.tabId, { x: xy.x, y: xy.y, w, h })
  }, [layoutActions])

  // --- Overlay callbacks ---
  const handleOverlayMove = useCallback((id: string, xy: { x: number; y: number }) => {
    layoutActions.moveOverlay(id, xy)
  }, [layoutActions])

  const handleOverlayResize = useCallback((id: string, size: { w: number; h: number }) => {
    layoutActions.resizeOverlay(id, size)
  }, [layoutActions])

  const handleOverlayBringToFront = useCallback((id: string) => {
    layoutActions.bringOverlayToFront(id)
  }, [layoutActions])

  // A press outside a window that closes that way (closeOnOutsidePress) closes it as its own close does: the
  // whole next arrangement, its looks and backdrop gone with it, after queued operations settle.
  const handleOverlayDismiss = useCallback((id: string) => {
    void layoutActions.flush()
      .then((current) => layoutActions.applyLayoutState(removeOverlayWindow(current, id)))
      .catch(() => {
        // A rejected pending operation left no settled arrangement to change.
      })
  }, [layoutActions])

  // --- Maximize/focus mode: renders the pane as a full-viewport overlay
  //     covering sidebar, top bar, everything. Escape key exits. ---
  const isFocusMode = maximizedContainerId !== null

  // Escape key exits maximize mode
  useEffect(() => {
    if (!isFocusMode) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        layoutActions.toggleMaximize(maximizedContainerId!)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isFocusMode, maximizedContainerId])

  // Escape ALSO exits immersive (any region whose chrome is hidden), so an
  // immersive container — whose own header is gone — is never a trap. Standard
  // fullscreen-escape semantics; clears every region's immersive override at once.
  const regionChromeForEscape = layoutState.regionChrome
  useEffect(() => {
    if (!hasImmersiveRegion(regionChromeForEscape)) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      layoutActions.applyLayoutState({
        ...layoutState,
        regionChrome: clearImmersiveRegions(regionChromeForEscape),
      })
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [regionChromeForEscape, layoutState, layoutActions])

  // Surface-root wallpaper: the whole workspace's background, behind every pane. Authored as a layer stack
  // (image/video/gradient/a look moving with sound/…); absent = today's look. The outermost arrangement draws it
  // behind the whole page (sidebar included), fixed to the window, and only once the page is open, so the opening
  // scene never shows it; it tells the page (page-backdrop) so the look lets it show through its surfaces at a blend
  // that keeps words readable (screen-look see-through.json). An arrangement nested inside a screen draws its own
  // background in place, as before.
  const surfaceStack = layoutState?.visualLayerStacks?.[regionAddressKey(surfaceRegion(surface))]
  const surfaceSubjectResolver = useVisualLayerSubjectResolver(surfaceStack?.layers ?? [])
  const hasSurfaceWallpaper = Boolean(surfaceStack && surfaceStack.layers.some(layer => layer.enabled !== false))
  const pageOpen = usePageBackdrop()
  useEffect(() => {
    if (nested) return undefined
    setPageBackdrop(hasSurfaceWallpaper)
    return () => setPageBackdrop(false)
  }, [nested, hasSurfaceWallpaper])
  const surfaceLayers = surfaceStack && surfaceStack.layers.length > 0 ? (
    <VisualLayerStack
      region={surfaceRegion(surface)}
      layers={surfaceStack.layers}
      map={createCapabilityMap(builtinVisualLayerCapabilities)}
      resolveSubject={surfaceSubjectResolver}
    />
  ) : null
  const surfaceWallpaper = !surfaceLayers ? null : nested ? (
    <Container position="absolute" inset="0" pointerEvents="none">{surfaceLayers}</Container>
  ) : pageOpen && typeof document !== 'undefined' ? createPortal(
    <Container position="fixed" inset="0" pointerEvents="none" style={{ zIndex: -1, filter: 'blur(var(--page-backdrop-blur, 0px))' }} data-page-backdrop="">{surfaceLayers}</Container>,
    document.body,
  ) : null

  // The surface-root's own drop intents: a surface dragged out of a screen and
  // dropped on the BARE workspace backdrop opens as a tab in the focused
  // container (open-as-tab default); a picture from the computer dropped on the
  // backdrop, off every pane, sets the whole-workspace wallpaper. The
  // generic RegionDropRouter is NEST-AWARE, so when the drag is over a container
  // or the canvas, THAT inner region owns the drop — the surface router only
  // catches drops on the truly-bare backdrop (no double overlays).
  const surfaceDropIntents = useMemo(() => buildRegionDropIntents({
    region: surfaceRegion(surface),
    openAsTab: (drop) => {
      const tab = readPlaceableSurfaceTabOrAdmitEntry(drop.dataTransfer, placeableSurfaces)
      if (!tab || !focusedContainerId) return false
      layoutActions.addSurfaceTab(focusedContainerId, tab)
      return true
    },
    setBackground: (descriptor) => {
      if (!layoutState) return
      appendRegionLayer(layoutState, layoutActions.applyLayoutState, surfaceRegion(surface), descriptor)
    },
  }), [surface, placeableSurfaces, focusedContainerId, layoutState, layoutActions])

  return (
    <InsideArrangement.Provider value>
    <NestedArrangement.Provider value={!outermost}>
    <OfferedSurfacesContext.Provider value={placeableSurfaces}>
    <DragContext.Provider value={dragCtx}>
      <TabDragContext.Provider value={tabDragCtx}>
        <PendingMoveContext.Provider value={pendingCtx}>
          <MarkSessionProvider>
           <NodeMenuContext.Provider value={nodeMenuValue}>
           <StableContainerContent render={renderContainerContent}>
            {nodeMenu.contextMenu}
            {/* The sidebar's Arrangement section (mode switch, pane map, Layouts), the same in every mode, for the
                outermost arrangement only. */}
            {outermost && <ArrangementSection />}
            {/* A layout the person's AI asked to open now opens through the one switch. */}
            <OpenAskedLayout />
            {/* The arrangement on screen is published for the person's AIs to read and change (read_layouts). */}
            <PublishShownArrangement />
            {/* Any screen can put something behind the panes, change it or take it away (Ambience's own buttons). */}
            {!nested && <TakeBehindPanesAsks region={surfaceRegion(surface)} layoutState={layoutState} applyLayoutState={layoutActions.applyLayoutState} />}
            {surfaceIntentReader && (
              <AddressedSurfaceIntentReader
                {...surfaceIntentReader}
                allowList={[]}
                permit={(payload) => surfaceIntentMatchesCatalogPayload(payload, surfaceIntentCatalog)}
                emit={openSurfacePayload}
              />
            )}
            {surfaceIntentDestinationRef && (
              <AddressedSurfaceIntentRecipient
                destinationRef={surfaceIntentDestinationRef}
                allowList={[]}
                permit={(payload) => surfaceIntentMatchesCatalogPayload(payload, surfaceIntentCatalog)}
                emit={openAddressedSurfacePayload}
              />
            )}
            {/* The whole arrangement is a region too: a right-click on bare workspace changes its look. */}
            <div ref={markRootRef} className="relative flex h-full min-h-0 min-w-0 flex-1 flex-col" data-node-ref={nodeRefAttr(surfaceRegion(surface))}>
            <div className={cn('relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden', isFocusMode && 'pointer-events-none')}>
            {/* Surface stays rendered in focus mode (so backdrop-blur has content to frost) */}
            <RegionDropRouter region={surfaceRegion(surface)} intents={surfaceDropIntents}
              suppressOverlay={(event) => !isOverStage(event.clientX, event.clientY)} grow>
            {surfaceWallpaper}
            {renderLayers.map((layer, layerIndex) => {
              const isActive = layer.id === activeLayerId
              const layerLayouts = isActive ? layouts : layer.layouts
              const layerSurface = isActive ? surface : layer.surface ?? surface
              const layerGeometry = baseGeometryForSurface(layerSurface)
              const layerTiled = layerLayouts.find((item): item is TiledLayout => item.type === 'tiled')
              const layerFloating = layerLayouts.find((item): item is FloatingLayout => item.type === 'floating')
              const layerOverlay = layerLayouts.find((item): item is OverlayLayout => item.type === 'overlay')
              const layerWindows = Object.fromEntries((layerFloating?.containers ?? []).filter(item => containerIsVisible(layoutState, item.containerId, hiddenSurfaces)).map((item) => [
                item.containerId,
                { x: item.x, y: item.y, w: item.w, h: item.h, z: item.z },
              ]))
              const layerOverlayBoxes = (layerOverlay?.containers ?? []).filter(item => containerIsVisible(layoutState, item.containerId, hiddenSurfaces)).map((item) => ({
                containerId: item.containerId,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                z: item.z,
              }))
              return (
                <div
                  key={layer.id}
                  data-arrangement-layer={layer.id}
                  data-active-layer={isActive ? 'true' : undefined}
                  aria-hidden={layer.id === interactiveLayerId ? undefined : true}
                  inert={layer.id === interactiveLayerId ? undefined : true}
                  className="absolute inset-0 isolate"
                  style={{ zIndex: layerIndex + 1, pointerEvents: layer.id === interactiveLayerId ? 'auto' : 'none' }}
                >
                  {layerGeometry === 'tiled' && layerTiled?.root && (
                    <SplitTreeArranger
                      root={layerTiled.root}
                      focusedContainerId={focusedContainerId}
                      onDropTarget={isActive ? handleDropTarget as any : () => {}}
                      onSwapContainers={isActive ? commitSwap : () => {}}
                      onResize={isActive ? handleSplitResize : () => {}}
                      onResizeCross={isActive ? handleCrossResize : () => {}}
                      onDropTabIntoContainer={isActive ? handleDropTabIntoContainer : async () => {}}
                      onDropTabAtContainerEdge={isActive ? handleDropTabAtContainerEdge : async () => {}}
                      onDropSurfaceAtContainerEdge={isActive ? handleDropSurfaceAtContainerEdge : async () => {}}
                      splitAtFrameEdge={isActive ? handleSplitAtFrameEdge : async () => {}}
                      splitBetween={isActive ? handleSplitBetween : async () => {}}
                      renderContainer={renderContainer}
                      windowSeams={isActive}
                    />
                  )}
                  {layerGeometry === 'floating' && layerFloating && (
                    <React.Suspense fallback={null}>
                    <FreeformArranger
                      windows={layerWindows}
                      camera={layerFloating.camera}
                      focusedContainerId={focusedContainerId}
                      onBringToFront={isActive ? handleFreeformBringToFront : () => {}}
                      onMove={isActive ? handleFreeformMove : () => {}}
                      onResize={isActive ? handleFreeformResize : () => {}}
                      onCameraChange={isActive ? handleCameraChange : () => {}}
                      placeableSurfaces={placeableSurfaces}
                      createContainerAt={isActive ? handleCreateContainerAt : async () => {}}
                      renderContainer={renderContainer}
                      options={{ clamp: 'none' }}
                    />
                    </React.Suspense>
                  )}
                  {layerOverlayBoxes.length > 0 && (
                    <OverlayArranger
                      boxes={layerOverlayBoxes}
                      onBringToFront={isActive ? handleOverlayBringToFront : () => {}}
                      onMove={isActive ? handleOverlayMove : () => {}}
                      onResize={isActive ? handleOverlayResize : () => {}}
                      renderContainer={renderContainer}
                      isFocusMode={isFocusMode}
                      interactive={isActive}
                      onDismiss={isActive ? handleOverlayDismiss : undefined}
                      onContextMenu={onRegionContextMenu}
                    />
                  )}
                </div>
              )
            })}
            </RegionDropRouter>
            </div>

            {/* Focus mode: FocusOverlay ui/ component with glassmorphic backdrop */}
            <FocusOverlay
              open={isFocusMode && !!maximizedContainerId && containerIsVisible(layoutState, maximizedContainerId, hiddenSurfaces)}
              onClose={() => layoutActions.toggleMaximize(maximizedContainerId!)}
            >
              {maximizedContainerId && renderContainer(maximizedContainerId)}
            </FocusOverlay>

            {/* Drawing: world/frame display overlays + the single input layer + toolbar */}
            <ArrangementMarkLayers
              rootRef={markRootRef}
              ownsScreen={useGlobalSurfaceIntents}
              surface={surface}
              camera={{
                scale: floating.camera?.scale ?? 1,
                tx: floating.camera?.tx ?? 0,
                ty: floating.camera?.ty ?? 0,
              }}
            />
            </div>
           </StableContainerContent>
           </NodeMenuContext.Provider>
          </MarkSessionProvider>
        </PendingMoveContext.Provider>
      </TabDragContext.Provider>
    </DragContext.Provider>
    </OfferedSurfacesContext.Provider>
    </NestedArrangement.Provider>
    </InsideArrangement.Provider>
  )
}

export default function LayoutEngine(props: LayoutEngineProps = {}) {
  const placeableSurfaceListAddressLabel = React.useContext(PlaceableSurfaceListAddressContext)
  const effectiveLabel = placeableSurfaceListAddressLabel ?? 'placeable-surface-list::main-workspace'
  const publishedRecordsEntry = useBitfieldData('published-records')
  const placeableSurfaceListEntry = useBitfieldData({
    input: 'placeable-surface-list-by-address-label',
    params: { addressLabel: effectiveLabel },
  })
  const placeableSurfaceInputOverridesEntry = useBitfieldData({
    input: 'selector-source-by-address',
    params: surfaceInputOverridesReadInput(effectiveLabel).params,
  })
  return (
    <LayoutEngineView
      {...props}
      publishedRecordsEntry={publishedRecordsEntry}
      placeableSurfaceListEntry={placeableSurfaceListEntry}
      placeableSurfaceInputOverridesEntry={placeableSurfaceInputOverridesEntry}
    />
  )
}
