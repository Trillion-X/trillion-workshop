// frontends/web/src/packages/screen-arrangement/containers/container-host.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Container shell for each screen-arrangement container. Renders the
// ContainerHeader and active content through a caller-scoped exact-id local
// content resolver, then the existing package/target/reply paths.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. ContainerHost never imports feature renderers; embedded hosts may supply a
//    scoped local-content resolver keyed by the catalog's exact surface id
// 2. One ContainerHost per container in the layout
// 3. Active tab determined by the container's TabGroup.activeTabId
// 4. Empty containers show EmptyContainer placeholder
// 5. ContainerHost preserves generic surface state/replies as its fallback
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client'

import React from 'react';
import { lazyPart } from '../../ui/show/load-later/later';
import { surfaceInputWithDestination } from './surface-placement';
import { LayoutActionsContext, LayoutStateContext, LayoutPersistenceIdentityContext, PendingCloseContext } from './screen-arrangement-context'
import ContainerHeader from './ContainerHeader'
import { ComponentMaterialSurface } from './ComponentMaterialSurface'
import { regionZoneVisible, regionIsImmersive, toggleRegionImmersive } from '../read-data/region-chrome'
import { useShowChange } from '../../ui/show/show-rules/show-of'
import { EmptyContainer } from './EmptyContainer'
import { ShowRepliesScreenCanUse } from './ShowRepliesScreenCanUse'
import { AddressedMarkOverlay } from '../../addressed-marks/show/AddressedMarkOverlay'
// A tab shown as a canvas (pannable, zoomable) is fetched the first time one is shown that way.
const TabCanvasPresentation = lazyPart(() => import('./tab-canvas-presentation'), module => module.default)
import { markTargetForTab } from './mark-targets'
import {
  readPlaceableSurfaceTabOrAdmitEntry,
} from './placeable-surface-drag'
import { PendingActivationContext } from './screen-arrangement-context'
import {
  type PlaceableSurfaceRecord,
  type PublishedRecord,
} from '../read-data/read-published-records'
import type { TabMeta } from '../read-data/layout-types'
import {
  tabShowsPlaceableSurface,
  tabWithCurrentSurfaceLabel,
} from './placeable-surface-tab'
import { RegionDropRouter } from '../../ui/show/region-drop-intent';
import { isOverSelectedRecordDropOwner } from '../../ui/show/selection';
import { VisualLayerStack, createCapabilityMap, builtinVisualLayerCapabilities } from '../../ui/show/visual-layer-stack';
import type { VisualLayerDescriptor } from '../../ui/show/visual-layer-stack';
import { containerRegion, tabRegion, regionAddressKey } from '../read-data/region-address'
import { nodeRefAttr } from './node-menu-controller'
import { useVisualLayerSubjectResolver } from './visual-layer-runtime'
import { buildRegionDropIntents, isArrangementEdgeDrop, isArrangementSurfaceDrag, isArrangementTabDrag, isExternalFileDrag, isOverExternalFileDropOwner } from './region-drop-intents'
import { activeTabIdAfterPendingClose } from './optimistic-tab-close'
import { OverlayWindowContext } from './OverlayArranger'
import { dockTargetContainerId, removeOverlayWindow } from '../read-data/place-tab-in-overlay'
import { FloatingGrab } from '../../ui/show/floating-grab/FloatingGrab'
import { cn } from '../../ui/show/cn'
import { Button } from '../../ui/show/button'
import { FilePicker } from '../../ui/show/folder-picker/FolderPicker'
import { canAdmitPlaceableSurfaceFiles } from '../../ui/show/placeable-surface-intent/placeable-surface-entry'
import type { DockPosition } from '../../ui/show/dockable-placement/dockable-placement'
import { useTabBarPlacement } from './use-tab-bar-placement'
import { SURFACE_CLOSE_EVENT } from '../../ui/show/placeable-surface-intent/open-choices'
import { hearKept, KEPT_KEY } from '../../ui/show/placement-kept/placement-kept'
import { placeableSurfaceTabForFiles } from './placeable-surface-drag'
import { LocalSurfaceContentContext, LocalSurfaceVisibilityContext } from './embedded-surface-content'
import { visibleTabIds } from '../read-data/surface-visibility'

// The tab bar comes first in the flow on its own edge; the body takes the rest.
const TAB_BAR_FLOW_CLASS: Record<DockPosition, string> = {
  top: 'flex-col',
  bottom: 'flex-col-reverse',
  left: 'flex-row',
  right: 'flex-row-reverse',
}

// Capability registry address for screen-arrangement-provided layer capabilities.
const SCREEN_ARRANGEMENT_CAPABILITIES = { family: 'screen-arrangement.capabilities', parts: {} }
const SURFACE_CONTENT_CAPABILITY_ID = 'surface-content'

// The region's content is itself a layer. If an authored stack omits it, inject
// it at z 0 so wallpaper (authored at z < 0) sits behind and overlays (z > 0) in
// front — background/content/overlay differ only by order.
function withContentLayer(layers: readonly VisualLayerDescriptor[]): VisualLayerDescriptor[] {
  const hasContent = layers.some((layer) => layer.paint.capability.capabilityId === SURFACE_CONTENT_CAPABILITY_ID)
  if (hasContent) return [...layers]
  return [
    ...layers,
    {
      id: '__surface-content',
      order: { z: 0 },
      pointerEvents: true,
      paint: { capability: { registry: SCREEN_ARRANGEMENT_CAPABILITIES, capabilityId: SURFACE_CONTENT_CAPABILITY_ID }, input: {} },
    },
  ]
}

type Props = {
  containerId: string
  placeableSurfaces: readonly PlaceableSurfaceRecord[]
  publishedRecords: readonly PublishedRecord[]
  surfaceIntentDestinationRef?: string | null
}

const EMPTY_TAB_IDS: string[] = []

const CONTAINER_FOCUS_INTERACTIVE_TARGET_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'summary',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[role="tab"]',
].join(',')

function elementForPointerTarget(target: EventTarget | null): Element | null {
  if (typeof Element !== 'undefined' && target instanceof Element) return target
  if (typeof Node !== 'undefined' && target instanceof Node) {
    const parentElement = target.parentElement
    return typeof Element !== 'undefined' && parentElement instanceof Element ? parentElement : null
  }
  return null
}

export function shouldFocusContainerFromPointerTarget(target: EventTarget | null): boolean {
  const element = elementForPointerTarget(target)
  if (!element) return true
  return !element.closest(CONTAINER_FOCUS_INTERACTIVE_TARGET_SELECTOR)
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function mountedTabIdsFor(
  previousMountedTabIds: readonly string[],
  groupTabIds: readonly string[],
  tabsById: Record<string, TabMeta>,
  activeTabId: string | null,
): string[] {
  const groupTabIdSet = new Set(groupTabIds)
  const nextMountedTabIds = previousMountedTabIds.filter((tabId) => groupTabIdSet.has(tabId) && !!tabsById[tabId])

  if (activeTabId && groupTabIdSet.has(activeTabId) && tabsById[activeTabId] && !nextMountedTabIds.includes(activeTabId)) {
    nextMountedTabIds.push(activeTabId)
  }

  return nextMountedTabIds
}

function readSurfaceInput(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function surfaceInputForTab(
  tab: TabMeta,
  placeableSurfaces: readonly PlaceableSurfaceRecord[],
): Record<string, unknown> | undefined {
  const input = readSurfaceInput(tab.metadata?.surfaceInput)
    ?? readSurfaceInput(placeableSurfaces.find((surface) => tabShowsPlaceableSurface(tab, surface))?.surfaceInput)
  // What the screen kept in this placement (ui/show/placement-kept) rides on the input it opens with.
  const kept = readSurfaceInput(tab.metadata?.[KEPT_KEY])
  return kept ? { ...(input ?? {}), [KEPT_KEY]: kept } : input
}

function tabPanelStyle(active: boolean): React.CSSProperties {
  return active
    ? {
        display: 'flex',
        flex: '1 1 0%',
        minHeight: 0,
        width: '100%',
        position: 'relative',
      }
    : {
        display: 'none',
      }
}

// Tab-presentation renderer capability map (B3 completion). The mode is OPEN DATA
// (`tab-presentation-modes.ts` registry); the renderer dispatch is a blind table
// lookup keyed by that id — NEVER a `=== 'canvas'` branch. A mode with no entry
// (e.g. 'tile') renders its body directly. Adding a presentation mode = one
// registry row + its wrapper here, zero edit to the dispatch site below (L090).
const TAB_PRESENTATION_RENDERERS: Record<string, (body: React.ReactNode) => React.ReactNode> = {
  canvas: (body) => <React.Suspense fallback={null}><TabCanvasPresentation>{body}</TabCanvasPresentation></React.Suspense>,
}

function ContainerTabBody({
  active,
  containerFocused,
  containerId,
  containerMaximized,
  placeableSurfaces,
  publishedRecords,
  surfaceIntentDestinationRef,
  tab,
}: {
  containerFocused: boolean
  containerId: string
  containerMaximized: boolean
  placeableSurfaces: readonly PlaceableSurfaceRecord[]
  publishedRecords: readonly PublishedRecord[]
  surfaceIntentDestinationRef?: string | null
  tab: TabMeta
  /** Whether this tab is the one shown in its container. */
  active: boolean
}) {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutIdentity = React.useContext(LayoutPersistenceIdentityContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const resolveLocalSurfaceContent = React.useContext(LocalSurfaceContentContext)
  // What the screen in this tab keeps about itself (ui/show/placement-kept) is kept with the tab, so the arrangement
  // saves it with this placement.
  const keptHost = React.useRef<HTMLDivElement | null>(null)
  const tabRef = React.useRef(tab)
  tabRef.current = tab
  React.useEffect(() => {
    const host = keptHost.current
    if (!host || !layoutActions) return undefined
    return hearKept(host, (kept) => {
      const current = tabRef.current
      layoutActions.updateTabMeta(current.id, { metadata: { ...(current.metadata ?? {}), [KEPT_KEY]: kept } })
    })
  }, [layoutActions])
  const displayTab = React.useMemo(
    () => tabWithCurrentSurfaceLabel(tab, placeableSurfaces),
    [placeableSurfaces, tab],
  )
  const surfaceInput = React.useMemo(
    () => surfaceInputWithDestination(surfaceInputForTab(displayTab, placeableSurfaces), surfaceIntentDestinationRef, displayTab.id, layoutIdentity),
    [displayTab, placeableSurfaces, surfaceIntentDestinationRef, layoutIdentity],
  )
  const requestPayload = React.useMemo(() => ({
    surface: 'screen',
    tab: {
      id: displayTab.id,
      title: displayTab.title,
      metadata: displayTab.metadata ?? {},
    },
    container: {
      id: containerId,
      focused: containerFocused,
      maximized: containerMaximized,
    },
  }), [
    containerFocused,
    containerId,
    containerMaximized,
    displayTab.id,
    displayTab.metadata,
    displayTab.title,
  ])
  const markTarget = React.useMemo(() => markTargetForTab(displayTab.id), [displayTab.id])

  const placeableSurfaceId = displayTab.metadata?.placeable_surface_id
  const localSurfaceContent = typeof placeableSurfaceId === 'string'
    ? resolveLocalSurfaceContent?.(placeableSurfaceId, displayTab, surfaceInput)
    : undefined

  let body: React.ReactNode

  if (localSurfaceContent !== undefined) {
    body = localSurfaceContent
  } else if (displayTab.packageEntry) {
    body = (
      <ComponentMaterialSurface
        packageEntry={displayTab.packageEntry}
        target={displayTab.target ?? null}
        materialTarget={displayTab.materialTarget ?? null}
        surfaceInput={surfaceInput}
      />
    )
  } else if (displayTab.target) {
    body = (
      <ShowRepliesScreenCanUse
        target={displayTab.target}
        requestPayload={requestPayload}
        publishedRecords={publishedRecords}
        className="h-full w-full min-h-0 overflow-y-auto overscroll-contain"
        missing={
          <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-[var(--text-secondary)]">
            No usable screen reply for {displayTab.title}
          </div>
        }
      />
    )
  } else {
    body = <EmptyContainer containerId={containerId} tabId={displayTab.id} shown={active} placeableSurfaces={placeableSurfaces} />
  }

  const presentMode = displayTab.metadata?.presentationMode
  const presentRenderer = presentMode ? TAB_PRESENTATION_RENDERERS[presentMode] : undefined
  if (presentRenderer) {
    body = presentRenderer(body)
  }

  // The container region's visual is an ordered layer stack; this tab's content
  // is the `surface-content` layer. When the region has no wallpaper layer the
  // stack is just content → render it directly (identical to before; zero
  // regression). When wallpaper exists, content composites on top of it.
  // Decoration composites TWO region stacks behind/over this tab's content: the
  // CONTAINER region (shared — set by drops or container right-click) and the
  // ACTIVE TAB's region (per-tab — each tab can carry its own background/grain,
  // swapping as you switch tabs). The renderer orders every layer by z, so
  // backgrounds (z<0) sit behind content (z=0) and grain/effects (z>0) over it,
  // regardless of which region contributed them.
  const containerStack = layoutState?.visualLayerStacks?.[regionAddressKey(containerRegion(containerId))]
  const tabStack = layoutState?.visualLayerStacks?.[regionAddressKey(tabRegion(displayTab.id))]
  const decorationLayers = [
    ...(containerStack?.layers ?? []),
    ...(tabStack?.layers ?? []),
  ].filter((layer) => layer.paint.capability.capabilityId !== SURFACE_CONTENT_CAPABILITY_ID)
  const decorationSubjectResolver = useVisualLayerSubjectResolver(decorationLayers)
  const hasWallpaper = decorationLayers.length > 0
  const content = hasWallpaper ? (
    <VisualLayerStack
      region={containerRegion(containerId)}
      layers={withContentLayer(decorationLayers)}
      map={createCapabilityMap({
        ...builtinVisualLayerCapabilities,
        [SURFACE_CONTENT_CAPABILITY_ID]: { render: () => body },
      })}
      resolveSubject={decorationSubjectResolver}
    />
  ) : (
    body
  )

  return (
    <div ref={keptHost} className="relative flex flex-col flex-1 min-h-0 w-full overflow-hidden">
      {content}
      {/* Display-only: pointer input is owned by the single MarkInputLayer
          mounted in LayoutEngine (one stroke = one addressed space). */}
      <AddressedMarkOverlay
        target={markTarget}
        enabled={false}
        className="z-[30]"
      />
    </div>
  )
}

/** Dispatched (bubbling) by a surface that asks to close its own tab (ui closeOwnScreen sends it). */
export { SURFACE_CLOSE_EVENT }

export default function ContainerHost({ containerId, placeableSurfaces, publishedRecords, surfaceIntentDestinationRef }: Props) {
  const layoutState = React.useContext(LayoutStateContext)
  const hiddenSurfaces = React.useContext(LocalSurfaceVisibilityContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const pendingClose = React.useContext(PendingCloseContext)
  const pendingActivation = React.useContext(PendingActivationContext)
  // Chrome zones are also controls the person's show rules decide (region-chrome); their change redraws this pane.
  useShowChange()
  if (!layoutState || !layoutActions) throw new Error('Screen-arrangement owner context missing for ContainerHost')
  const container = layoutState.containers[containerId]
  const group = container ? layoutState.tabGroups[container.groupId] : null
  const groupTabIds = React.useMemo(() => visibleTabIds(layoutState, group?.tabIds ?? EMPTY_TAB_IDS, hiddenSurfaces), [layoutState, group?.tabIds, hiddenSurfaces])
  const canonicalActiveTabId = group?.activeTabId && groupTabIds.includes(group.activeTabId) ? group.activeTabId : groupTabIds[0] ?? null
  const hintedTabId = pendingActivation?.hints[containerId]
  const activeTabId = activeTabIdAfterPendingClose(
    hintedTabId && groupTabIds.includes(hintedTabId) && !!layoutState.tabs[hintedTabId]
      ? hintedTabId
      : canonicalActiveTabId,
    canonicalActiveTabId,
    groupTabIds,
    pendingClose?.tabIds ?? new Set<string>(),
  )
  const [mountedTabIds, setMountedTabIds] = React.useState<string[]>(() => (
    activeTabId && groupTabIds.includes(activeTabId) && layoutState.tabs[activeTabId] ? [activeTabId] : []
  ))
  const renderedTabIds = mountedTabIdsFor(mountedTabIds, groupTabIds, layoutState.tabs, activeTabId)
  const activeTabIsMounted = !!activeTabId && renderedTabIds.includes(activeTabId)
  const containerFocused = layoutState.focusedContainerId === containerId
  const containerMaximized = layoutState.maximizedContainerId === containerId
  const overlayWindow = React.useContext(OverlayWindowContext)

  // A surface can close its own tab without knowing the arrangement: it
  // dispatches SURFACE_CLOSE_EVENT (bubbling) from anywhere inside its panel,
  // and the container closes exactly that tab, the same as its header's close.
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  // The box the tab bar sits in: it pops out and hides within it.
  const tabBarBoxRef = React.useRef<HTMLDivElement | null>(null)
  const tabBarPlacement = useTabBarPlacement(containerId)
  const closeTabRef = React.useRef(layoutActions.closeTab)
  closeTabRef.current = layoutActions.closeTab
  // A floating window holding only the closing screen goes with it, the same as the window's own close.
  const closeWindowRef = React.useRef<(() => void) | null>(null)
  const hasContainer = !!container
  React.useEffect(() => {
    const node = hostRef.current
    if (!node) return undefined
    const onCloseRequest = (event: Event) => {
      const panel = (event.target as HTMLElement | null)?.closest?.('[data-screen-arrangement-tab-panel]') as HTMLElement | null
      const tabId = panel?.dataset.tabId
      if (!tabId || panel?.closest('[data-container-id]') !== node) return
      event.stopPropagation()
      if (closeWindowRef.current) closeWindowRef.current()
      else void closeTabRef.current(tabId)
    }
    node.addEventListener(SURFACE_CLOSE_EVENT, onCloseRequest)
    return () => node.removeEventListener(SURFACE_CLOSE_EVENT, onCloseRequest)
  }, [hasContainer])

  React.useEffect(() => {
    setMountedTabIds((previousMountedTabIds) => {
      const nextMountedTabIds = mountedTabIdsFor(previousMountedTabIds, groupTabIds, layoutState.tabs, activeTabId)
      return sameStringArray(previousMountedTabIds, nextMountedTabIds) ? previousMountedTabIds : nextMountedTabIds
    })
  }, [activeTabId, groupTabIds, layoutState.tabs])

  if (!container) return null

  const windowLabel = (activeTabId ? layoutState.tabs[activeTabId]?.title : null) || 'window'
  const dockTarget = overlayWindow ? dockTargetContainerId(layoutState, containerId) : null
  // Closing or docking the window composes the whole next arrangement after
  // queued operations settle, the same way the window was placed.
  const settleWindow = (dockInto: string | null) => {
    void layoutActions.flush()
      .then((current) => layoutActions.applyLayoutState(removeOverlayWindow(current, containerId, dockInto)))
      .catch(() => {
        // A rejected pending operation left no settled arrangement to change.
      })
  }
  closeWindowRef.current = overlayWindow && groupTabIds.length <= 1 ? () => settleWindow(null) : null

  // A surface dragged out of a screen or tab dragged from another pane routes to
  // this region's shared drop intents. A computer file stays with a child screen
  // that owns file drops; elsewhere it opens as a file-presentation tab here.
  const dropIntents = buildRegionDropIntents({
    region: containerRegion(containerId),
    openAsTab: (drop) => {
      const tab = readPlaceableSurfaceTabOrAdmitEntry(drop.dataTransfer, placeableSurfaces)
      if (!tab) return false
      layoutActions.addSurfaceTab(containerId, tab)
      return true
    },
    setImmersive: () => {
      if (!layoutState) return
      const region = containerRegion(containerId)
      if (regionIsImmersive(layoutState.regionChrome, region)) return // already immersive — idempotent
      layoutActions.applyLayoutState({
        ...layoutState,
        regionChrome: toggleRegionImmersive(layoutState.regionChrome, region),
      })
    },
    moveTab: (tabId) => layoutActions.moveTabToContainer(tabId, containerId),
  })

  return (
    <div
      ref={hostRef}
      className="relative flex flex-col h-full w-full"
      data-container-id={containerId}
      data-node-ref={nodeRefAttr(containerRegion(containerId))}
      onMouseDown={(event) => {
        if (!shouldFocusContainerFromPointerTarget(event.target)) return
        layoutActions.focusContainer(containerId)
      }}
      onDragOverCapture={(event) => {
        if (isOverSelectedRecordDropOwner(event.dataTransfer, event.clientX, event.clientY)) return
        const isSurface = isArrangementSurfaceDrag(event.dataTransfer)
        const isTab = isArrangementTabDrag(event.dataTransfer)
        const isFile = isExternalFileDrag(event.dataTransfer)
          && !isOverExternalFileDropOwner(event.clientX, event.clientY)
        if (!isSurface && !isTab && !isFile) return
        event.preventDefault()
        event.dataTransfer.dropEffect = isTab ? 'move' : 'copy'
      }}
    >
      {regionIsImmersive(layoutState.regionChrome, containerRegion(containerId)) ? (
        <div className="absolute right-3 top-3 z-[70] flex items-center gap-2">
          {canAdmitPlaceableSurfaceFiles(placeableSurfaces) ? (
            <FilePicker label="Present files…" variant="secondary" size="sm" onFiles={(files) => {
              const tab = placeableSurfaceTabForFiles(files, placeableSurfaces)
              if (tab) layoutActions.addSurfaceTab(containerId, tab)
            }} />
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => layoutActions.applyLayoutState({
              ...layoutState,
              regionChrome: toggleRegionImmersive(layoutState.regionChrome, containerRegion(containerId)),
            })}
          >
            Show tabs
          </Button>
        </div>
      ) : null}
      <RegionDropRouter
        region={containerRegion(containerId)}
        intents={dropIntents}
        suppressOverlay={(event) => isArrangementEdgeDrop(event.dataTransfer, event.target, event.clientX, event.clientY)
          || isOverSelectedRecordDropOwner(event.dataTransfer, event.clientX, event.clientY)}
      >
      {/* The tab bar docks on whichever edge its placement names; the body fills the rest. */}
      <div ref={tabBarBoxRef} className={cn('relative flex h-full w-full min-h-0 min-w-0', TAB_BAR_FLOW_CLASS[tabBarPlacement.position])}>
      {regionZoneVisible(layoutState.chrome, layoutState.regionChrome, containerRegion(containerId), 'header') ? (
        <ContainerHeader
          containerId={containerId}
          groupId={container.groupId}
          placeableSurfaces={placeableSurfaces}
          placement={tabBarPlacement}
          containerRef={tabBarBoxRef}
        />
      ) : overlayWindow?.onStartDrag && regionZoneVisible(layoutState.chrome, layoutState.regionChrome, containerRegion(containerId), 'grab') ? (
        // A floating window whose DATA hides its tab bar still has to be moved,
        // closed and turned back into a tab: the shared floating grab strip, unless
        // its DATA hides that too (`grab: false`, a palette closed by Escape or a press outside).
        <FloatingGrab
          scoped
          label={windowLabel}
          onGrab={(event) => overlayWindow.onStartDrag?.(containerId, event)}
          onClose={() => settleWindow(null)}
          actions={dockTarget ? [{
            id: 'show-as-tab',
            label: `Show ${windowLabel} as a tab`,
            icon: 'PanelTop',
            onAction: () => settleWindow(dockTarget),
          }] : []}
        />
      ) : null}
      <div className="relative flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden">
        {renderedTabIds.map((tabId) => {
          const tab = layoutState.tabs[tabId]
          if (!tab) return null
          const active = tabId === activeTabId
          return (
            <div
              key={tabId}
              aria-hidden={active ? undefined : true}
              className={active ? 'relative flex flex-1 min-h-0 w-full' : 'hidden'}
              style={tabPanelStyle(active)}
              data-active={active ? 'true' : 'false'}
              data-screen-arrangement-tab-panel
              data-tab-id={tabId}
            >
              <ContainerTabBody
                active={active}
                containerFocused={containerFocused}
                containerId={containerId}
                containerMaximized={containerMaximized}
                placeableSurfaces={placeableSurfaces}
                publishedRecords={publishedRecords}
                surfaceIntentDestinationRef={surfaceIntentDestinationRef}
                tab={tab}
              />
            </div>
          )
        })}
        {activeTabIsMounted ? null : (
          <EmptyContainer containerId={containerId} tabId={null} shown placeableSurfaces={placeableSurfaces} />
        )}
      </div>
      </div>
      </RegionDropRouter>
    </div>
  )
}
