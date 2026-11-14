// frontends/web/src/packages/screen-arrangement/containers/container-header.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// A container's tab bar. The tab bar IS the sidebar: the sidebar part's frame
// (SidebarFrame) placed in the container's flow with the container's tab bar
// placement (LayoutState.tabBarPlacement), drawing each tab as a sidebar row in
// the pane-tab look. The frame owns which edge it sits on, popping out, collapsing
// to icons and hiding until pointed at, with its own controls; this file only
// turns the container's tabs into rows and supplies the pane's own actions (back
// and forward, split, move, layer, PiP, maximize, close, + and ⋯).
// At every width the bar draws only its tabs and ⋯, which opens when pointed at: the ⋯ popover holds back and
// forward, New tab, every pane control and the bar's own position, collapse,
// pop-out and hide (the frame draws none of its own controls), then the pane's
// mode, layouts and the person's sidebar itself, embedded, to open anything here.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. All layout operations go through the screen-arrangement owner — no direct state mutation
// 2. Tab DnD uses HTML5 drag events with application/x-tab-id MIME type
// 5. No placement code here: edges, pop out, collapse and hide are the sidebar frame's
// 3. Container DnD uses application/x-container-id MIME type
// 4. Overlay/floating windows use pointer events for drag (not HTML5 DnD)
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

'use client'

import React, { useMemo, useCallback } from 'react'
import { lazyPart } from '../../ui/show/load-later/later';
import { cn } from '../../ui/show/cn'
import { Button } from '../../ui/show/button'
import { DrillMenu, type DrillLevel, type DrillRow } from '../../ui/show/drill-menu';
import { drillSectionsOf, menuRowSource, rowIds, useMenuRows, type MenuThing } from '../../ui/show/action-menu';
import { runCommand } from '../../ui/show/action-feedback/action-feedback';
import { NavArrows } from '../../ui/show/nav-arrows/NavArrows';
import { Popover, PopoverPopup, PopoverTrigger } from '../../ui/show/coss/ui/popover';
import { RecordKindMark } from '../../ui/show/record-kind';
import { SidebarFrame } from '../../sidebar/show/DesktopSidebar';
import { AppSidebar } from '../../sidebar/show/AppSidebar';
import { CLOSE_ROW_ACTION, type NavItemData, type NavRowEvents, type NavSectionData } from '../../sidebar/show/SidebarContent';
import { FilePicker } from '../../ui/show/folder-picker/FolderPicker'
import { canAdmitPlaceableSurfaceFiles } from '../../ui/show/placeable-surface-intent/placeable-surface-entry'

// A tab showing one record says what kind of record it is, from the kind the
// opener carried with the surface. Tabs without one draw nothing extra.
function tabRecordKind(tab: { metadata?: Record<string, unknown> }): React.ReactNode {
  const value = tab.metadata?.recordKind as { kind?: unknown; detail?: unknown } | undefined
  if (!value || typeof value.kind !== 'string' || !value.kind) return undefined
  return <RecordKindMark kind={value.kind} detail={typeof value.detail === 'string' ? value.detail : undefined}/>
}
import { tabRegion, containerRegion } from '../read-data/region-address'
import { nodeRefAttr } from './node-menu-controller'
import {
  historyBack,
  historyForward,
  historyNavigateTo,
  historyListItems,
  currentHistoryRef,
  canHistoryBack,
  canHistoryForward,
  getNodeHistory,
} from '../do-work/node-history-operations'
import { MoreHorizontal } from 'lucide-react'
import { PositionCompass } from '../../ui/show/dockable-placement'
import { Container } from '../../ui/show/container'
import { CatchUpMark } from '../../ui/show/catch-up'
// The layer chooser inside a pane's menu is fetched the first time it is opened.
const LayerPlacementPanel = lazyPart(() => import('./LayerPlacementPanel'), module => module.default)
import {
  DragContext,
  LayoutActionsContext,
  LayoutStateContext,
  PendingActivationContext,
  PendingCloseContext,
  PendingMoveContext,
  PlaceableSurfaceListAddressContext,
  TabDragContext,
} from './screen-arrangement-context'
import { EmptyContainerSourcesContext } from './empty-container-sources'
import { useMarkSession } from '../../addressed-marks/show/MarkSessionContext'
import { PANE_AREA, WHOLE_SCREEN_AREA } from './mark-targets'
import { startPointing } from '../../ui/show/point-at-anything'
import { FloatingWindowContext } from './floating-window-context'
import { OverlayWindowContext } from './OverlayArranger'
import type { PlaceableSurfaceRecord } from '../read-data/read-published-records'
import { EMPTY_TAB_TITLE, newEmptyTab, type OverlayLayout, type TabMeta } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/layout-types.ts'
import { visibleTabIds } from '../read-data/surface-visibility'
import { LocalSurfaceVisibilityContext } from './embedded-surface-content'
import { regionZoneVisible, zoneControl } from '../read-data/region-chrome'
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of'
import { pictureInPictureShown } from '../read-data/placement-choices'
import ArrangementSurfaceControl from './ArrangementSurfaceControl'
import { LayoutPicker } from './LayoutPicker'
import { surfaceShownByTab, tabWithCurrentSurfaceLabel } from 'trillion-workshop/tools/arrange-screens-in-panes/show/placeable-surface-tab.ts'
import { placeableSurfaceTabForFiles } from './placeable-surface-drag'
import { TAB_BAR_PLACEMENT_DEFAULT, TAB_BAR_VIEWS, readTabBarView, writeTabBarView } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/tab-bar-placement.ts'
import { prewarmPackageEntryBytes } from '../../ui/show/placeable-surface-host'
import { selectDockIsVertical, type DockablePlacementController } from '../../ui/show/dockable-placement/dockable-placement'

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// The ⋯ popover's rows for marking and changing the screen: `area` names where strokes go (mark-targets.ts); `point`
// picks one thing on the screen to change it (parts/ui/show/point-at-anything); the rest show or hide what was drawn.
const DRAW_ROWS = [
  { id: 'draw-pane', area: PANE_AREA, point: false, icon: 'Pencil', label: 'Draw on this pane', onLabel: 'Stop drawing' },
  { id: 'draw-screen', area: WHOLE_SCREEN_AREA, point: false, icon: 'Monitor', label: 'Draw on the whole screen', onLabel: 'Stop drawing' },
  { id: 'point', area: '', point: true, icon: 'MousePointerClick', label: 'Point at something to change it', onLabel: 'Point at something to change it' },
  { id: 'marks', area: '', point: false, icon: 'EyeOff', label: 'Hide drawings', onLabel: 'Show drawings' },
] as const

type Props = {
  containerId: string
  className?: string
  groupId?: string
  placeableSurfaces: readonly PlaceableSurfaceRecord[]
  /** Where this tab bar sits and how much of it shows (the shared dockable placement). */
  placement: DockablePlacementController
  /** The container's own box: the tab bar pops out and hides within it. */
  containerRef: React.RefObject<HTMLElement | null>
}

// Everything the sidebar frame lets its tab bar do: any edge, pop out, collapse to icons, hide until pointed at, and
// a width when it sits on the left or right. The ⋯ popover draws those controls; the frame draws none.
const TAB_BAR_CAPABILITIES = { position: true, collapse: true, undock: true, hide: true, resize: true }

const EMPTY_TAB_IDS: string[] = []

type NewTabEdge = 'left' | 'right' | 'top' | 'bottom'

const NEW_TAB_EDGE_OPTIONS: Array<{ edge: NewTabEdge; label: string }> = [
  { edge: 'right', label: 'Add tab to the right' },
  { edge: 'left', label: 'Add tab to the left' },
  { edge: 'top', label: 'Add tab above' },
  { edge: 'bottom', label: 'Add tab below' },
]

export default function ContainerHeader({ containerId, className, groupId: passedGroupId, placeableSurfaces, placement, containerRef }: Props) {
  const layoutState = React.useContext(LayoutStateContext)
  const hiddenSurfaces = React.useContext(LocalSurfaceVisibilityContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  if (!layoutState || !layoutActions) throw new Error('Screen-arrangement owner context missing for ContainerHeader')
  const c = layoutState.containers[containerId]
  const gId = passedGroupId ?? c?.groupId ?? null
  const shownTabIds = useMemo(() => visibleTabIds(layoutState, gId ? layoutState.tabGroups[gId]?.tabIds ?? EMPTY_TAB_IDS : EMPTY_TAB_IDS, hiddenSurfaces), [layoutState, gId, hiddenSurfaces])
  const savedActiveId = gId ? layoutState.tabGroups[gId]?.activeTabId : null
  const overlayLayout = layoutState.layouts.find((l): l is OverlayLayout => l?.type === 'overlay')
  const headerData = {
    groupId: gId,
    tabIds: shownTabIds,
    tabsById: layoutState.tabs,
    activeTabId: savedActiveId && shownTabIds.includes(savedActiveId) ? savedActiveId : shownTabIds[0] ?? null,
    isMaximized: layoutState.maximizedContainerId === containerId,
    isInOverlay: overlayLayout?.containers?.some((entry) => entry.containerId === containerId) ?? false,
    containerCount: Object.keys(layoutState.containers).length,
  }
  const {
    closeTab,
    activateTab,
    toggleOverlay,
    splitContainer,
    addPaneBeside,
    closeContainer,
    toggleMaximize,
    addTab,
    applyLayoutState,
    moveTabToContainer,
  } = layoutActions

  const pending = React.useContext(PendingMoveContext)
  const pendingClose = React.useContext(PendingCloseContext)
  const pendingActivation = React.useContext(PendingActivationContext)
  const tabDrag = React.useContext(TabDragContext)
  const markInteraction = useMarkSession()
  const overlayCtx = React.useContext(OverlayWindowContext)
  const floatingCtx = React.useContext(FloatingWindowContext)
  const [closeFailure, setCloseFailure] = React.useState<{
    tabId: string
    title: string
    message: string
  } | null>(null)

  // A tab bar docked left or right lists its tabs top to bottom.
  const vertical = selectDockIsVertical(placement)

  // true when this header lives in an overlay/floating window
  const isDraggableContext = !!(overlayCtx?.onStartDrag || floatingCtx?.onStartDrag)

  // Chrome zone visibility — every zone this header renders asks the layout
  // state's chrome map (longest-prefix match; absent = visible). New chrome
  // = a new zone name; the resolver never changes.
  const chrome = layoutState.chrome
  const regionChrome = layoutState.regionChrome
  // Per-region effective chrome: this container's region override (e.g. immersive
  // {'':false}, or the adversarial "re-show header but keep close hidden") composes
  // over the arrangement-wide base, so EVERY nested header zone resolves per-region,
  // independent of sibling containers (note #33). Absent override = the base map
  // (zero regression). The resolver is blind — a new zone is a new name, never code.
  const headerRegion = containerRegion(containerId)
  // Every zone is also a control the person's show rules decide (region-chrome zoneControl); their change redraws it.
  useShowChange()
  const zone = (name: string) => regionZoneVisible(chrome, regionChrome, headerRegion, name)

  // Derived tab metadata is memoized from the owner-fed layout context snapshot.
  const tabs = useMemo(
    () => (headerData.tabIds
      .map(id => headerData.tabsById[id])
      .filter(Boolean) as TabMeta[])
      .map((tab) => tabWithCurrentSurfaceLabel(tab, placeableSurfaces)),
    [headerData.tabIds, headerData.tabsById, placeableSurfaces]
  )

  // Use headerData from selector
  const { groupId, isMaximized, isInOverlay } = headerData
  const dragRow = useDragHandleRow(containerId)
  const canonicalActiveTabId = headerData.activeTabId
  const hintedTabId = pendingActivation?.hints[containerId]
  const activeTabId = hintedTabId && shownTabIds.includes(hintedTabId) ? hintedTabId : canonicalActiveTabId

  const onClose = useCallback((tabId: string, ev?: React.MouseEvent) => {
    ev?.stopPropagation()
    const title = tabs.find(t => t.id === tabId)?.title ?? EMPTY_TAB_TITLE
    setCloseFailure(null)
    pendingClose?.stage(tabId)
    void closeTab(tabId)
      .then(() => {
        pendingClose?.settle(tabId)
      })
      .catch((error) => {
        pendingClose?.settle(tabId)
        setCloseFailure({
          tabId,
          title,
          message: errorWords(error),
        })
      })
  }, [closeTab, tabs, pendingClose])

  // Activating a tab is recorded in this pane's history where every change of what a pane shows is recorded, the
  // layout request road (layout-operations recordVisits), so a tab click, an open from the sidebar, an AI or a tour
  // all land in the same trail.
  const onActivate = (tabId: string) => {
    pendingActivation?.stage(containerId, tabId)
    void Promise.resolve(activateTab(tabId)).then(
      () => pendingActivation?.settle(containerId, tabId),
      () => pendingActivation?.settle(containerId, tabId),
    )
  }

  // Pointed at or focused, a tab's screen starts loading before the click.
  const onTabWarm = (tabId: string) => {
    const tab = layoutState.tabs[tabId]
    if (!tab?.packageEntry) return
    prewarmPackageEntryBytes(tab.packageEntry.packageName, tab.packageEntry.entryName)
  }

  // Back/forward and a pick from the history list move this pane's history
  // cursor and re-activate that tab. They do NOT go through onActivate, so the
  // cursor move is not recorded as a new navigation (standard browser
  // back/forward semantics).
  const historyRegion = containerRegion(containerId)
  const showHistoryRef = (ref: string | null) => {
    if (!ref) return
    pendingActivation?.stage(containerId, ref)
    void Promise.resolve(activateTab(ref)).then(
      () => pendingActivation?.settle(containerId, ref),
      () => pendingActivation?.settle(containerId, ref),
    )
  }
  const onHistoryBack = () => showHistoryRef(historyBack(layoutState, applyLayoutState, historyRegion))
  const onHistoryForward = () => showHistoryRef(historyForward(layoutState, applyLayoutState, historyRegion))
  // A closed tab stays in the list as disabled context; only a live tab can be shown again.
  const onHistorySelect = (ref: string) => {
    if (!layoutState.tabs[ref]) return
    showHistoryRef(historyNavigateTo(layoutState, applyLayoutState, historyRegion, ref))
  }

  // Tab DnD
  const onDragStart = (tabId: string, ev: React.DragEvent) => {
    try { ev.dataTransfer.setData('application/x-tab-id', tabId) } catch {}
    try { ev.dataTransfer.setData('text/tab-id', tabId) } catch {}
    try { ev.dataTransfer.setData('text/plain', tabId) } catch {}
    if (groupId) ev.dataTransfer.setData('application/x-tab-group', groupId)
    ev.dataTransfer.effectAllowed = 'move'
    tabDrag?.setDraggingTabId(tabId)
  }

  // Drop a tab onto another tab in this strip → reposition it at that visual
  // slot (left half = before, right half = after). Commits through the slot
  // (moveTabToContainer with an index); the slot reorders within the group and
  // AnimatedReorder glides the tabs to their new places. stopPropagation keeps
  // the container-body drop (which would append) from also firing.
  const onTabDrop = (ev: React.DragEvent, targetTabId: string) => {
    ev.preventDefault()
    ev.stopPropagation()
    const dt = ev.dataTransfer
    const draggedId =
      dt.getData('application/x-tab-id') || dt.getData('text/tab-id') || dt.getData('text/plain')
    if (!draggedId || draggedId === targetTabId) return
    // Past the middle of the tab along the bar (across it, down it when the bar is on a side) lands after it.
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect()
    const after = vertical ? ev.clientY > rect.top + rect.height / 2 : ev.clientX > rect.left + rect.width / 2
    const tabIndex = tabs.findIndex((t) => t.id === targetTabId)

    // Same strip → reorder the group's tabIds and commit via applyLayoutState
    // (the same direct engine-log commit path the decoration layer-stacks use).
    // This is order data, owned by LayoutState — it does not need the slot's
    // move command, so a within-strip drag repositions without a cross-group move.
    const group = groupId ? layoutState.tabGroups[groupId] : undefined
    if (group && group.tabIds.includes(draggedId)) {
      const ids = [...group.tabIds]
      const fromPos = ids.indexOf(draggedId)
      const targetPos = ids.indexOf(targetTabId)
      ids.splice(fromPos, 1)
      let insert = targetPos
      if (fromPos < targetPos) insert -= 1
      if (after) insert += 1
      insert = Math.max(0, Math.min(insert, ids.length))
      ids.splice(insert, 0, draggedId)
      applyLayoutState({
        ...layoutState,
        tabGroups: {
          ...layoutState.tabGroups,
          [groupId!]: { ...group, tabIds: ids, activeTabId: draggedId },
        },
      })
    } else {
      // Cross-container → the slot owns the group move; pass the positional index.
      moveTabToContainer(draggedId, containerId, after ? tabIndex + 1 : tabIndex)
    }
    tabDrag?.setDraggingTabId(null)
    tabDrag?.setOverContainerId(null)
  }

  // Optimistic "+" throttle — opens an empty tab
  const newTabCooldownRef = React.useRef(0)
  const [chevronOpen, setChevronOpen] = React.useState(false)
  // Which view the tab bar draws its tabs in (DATA rows in TAB_BAR_VIEWS), chosen in the chevron's Arrange menu.
  const tabBarView = readTabBarView(layoutState, containerId)
  // The chevron's sidebar reads the same lists, catalog and screens the app hands its own sidebar.
  const listSource = React.useContext(EmptyContainerSourcesContext).collections
  const surfaceListAddress = React.useContext(PlaceableSurfaceListAddressContext)

  const onNewTab = useCallback((ev?: React.MouseEvent<HTMLButtonElement>) => {
    ev?.stopPropagation()
    const now = Date.now()
    if (now - newTabCooldownRef.current < 350) return
    newTabCooldownRef.current = now
    // Adds an unresolved generic tab. Producer-owned records provide real
    // addresses; this chrome cannot name feature packages.
    addTab(containerId, newEmptyTab())
  }, [addTab, containerId])

  // A new tab at an edge (a split) or the tab bar's view, chosen in the ⋯ menu's Tabs level.
  const onArrange = useCallback((value: string) => {
    if (value.startsWith('edge:')) {
      const edge = value.slice('edge:'.length) as NewTabEdge
      splitContainer(containerId, edge === 'left' || edge === 'right' ? 'row' : 'column', newEmptyTab(), edge === 'right' || edge === 'bottom' ? 'after' : 'before')
    }
    else if (value.startsWith('view:')) {
      const viewId = value.slice('view:'.length)
      void layoutActions.flush().then((current) => layoutActions.applyLayoutState(writeTabBarView(current, containerId, viewId))).catch(() => {})
    }
    setChevronOpen(false)
  }, [containerId, layoutActions, splitContainer])

  // The chevron shows the sidebar itself: the person's lists, folders and things, with Add a list, and none of its
  // own placement controls. What is chosen there opens in this pane, so the pane is focused as it opens.
  const onChevronOpenChange = useCallback((open: boolean) => {
    if (open) layoutActions.focusContainer(containerId)
    setChevronOpen(open)
  }, [containerId, layoutActions])

  // Simple PiP toggle using unified function
  const handlePiPToggle = useCallback(() => {
    toggleOverlay(containerId)
  }, [toggleOverlay, containerId])

  // Right-click a tab → the ONE shared node menu (owned by the surface root,
  // node-menu-controller). The tab stamps its region as `data-node-ref`; the
  // surface root's delegated contextmenu router reads it and opens the menu.
  // No per-header menu instance — container bodies, the canvas, and tabs all
  // route through the same single menu (SSOT). Right-click also activates the
  // tab so the menu acts on the tab the user clicked.

  // The tabs as sidebar rows: ghosts of tabs moving in hold their place, tabs moving out or closing leave at once.
  const tabRows = useMemo<NavItemData[]>(() => {
    const pend = pending?.pending ?? {}
    const movingOutIds = new Set(
      Object.entries(pend)
        .filter(([tid, mv]) => mv.targetContainerId !== containerId && tabs.some(t => t.id === tid))
        .map(([tid]) => tid)
    )
    const realTabs = tabs.filter(t => !movingOutIds.has(t.id) && !pendingClose?.tabIds.has(t.id))
    const realTabIds = new Set(realTabs.map(t => t.id))
    const finalTabs = [...realTabs]
    for (const [tid, mv] of Object.entries(pend).filter(([, mv]) => mv.targetContainerId === containerId)) {
      const ghost = tabs.find(t => t.id === tid)
      if (ghost && !realTabIds.has(tid)) finalTabs.splice(Math.min(Math.max(0, mv.index), finalTabs.length), 0, ghost)
    }
    return finalTabs.map((t) => {
      // The screen a tab shows carries the same hover card DATA its sidebar row does; the tab's own input fills it.
      const surface = surfaceShownByTab(t, placeableSurfaces)
      const input = t.metadata?.surfaceInput
      return {
      id: t.id,
      label: t.title,
      icon: t.icon ?? 'Square',
      ...(surface?.glance ? { glance: surface.glance } : {}),
      ...(surface?.surfaceActions?.length ? { surfaceActions: surface.surfaceActions } : {}),
      ...(surface?.description ? { description: surface.description } : {}),
      ...(input && typeof input === 'object' && !Array.isArray(input) ? { surfaceInput: input as Record<string, unknown> } : {}),
      look: tabBarView.look,
      // Every tab can be closed: a saved layout's flag never leaves a tab without its close.
      closable: true,
      pinned: t.pinned,
      leading: tabRecordKind(t),
      nodeRef: nodeRefAttr(tabRegion(t.id)),
      }
    })
  }, [tabs, pending?.pending, containerId, pendingClose, tabBarView.look, placeableSurfaces])
  const selectedTabId = pending?.activeHints?.[containerId] ?? activeTabId ?? ''
  // What the pane shows, as every ⋯ menu names the thing it is about: its ⋯ offers every row the page has for that
  // screen (action-menu/menu-rows.ts), read only while the menu is open.
  const shownTab = tabs.find((t) => t.id === selectedTabId)
  const shownSurface = shownTab ? surfaceShownByTab(shownTab, placeableSurfaces) : undefined
  const paneAbout = useMemo<MenuThing | undefined>(() => shownTab && shownTab.title !== EMPTY_TAB_TITLE ? {
    kind: 'screen', id: shownSurface?.id ?? shownTab.id, title: shownTab.title,
    ...(shownTab.metadata?.surfaceInput && typeof shownTab.metadata.surfaceInput === 'object' ? { input: shownTab.metadata.surfaceInput } : {}),
  } : undefined, [shownTab, shownSurface?.id])
  const paneOffered = useMenuRows(paneAbout, chevronOpen)
  const paneOfferedIds = useMemo(() => rowIds(paneOffered), [paneOffered])

  const rowEvents: NavRowEvents = {
    onDragStart: (item, ev) => onDragStart(item.id, ev),
    onDragEnd: () => { tabDrag?.setDraggingTabId(null); tabDrag?.setOverContainerId(null) },
    onDrop: (item, ev) => onTabDrop(ev, item.id),
    onWarm: (item) => onTabWarm(item.id),
  }

  const onTabAction = useCallback((item: NavItemData, actionId: string) => {
    if (actionId === CLOSE_ROW_ACTION) onClose(item.id)
  }, [onClose])

  // Allow dragging the whole header bar in overlay/floating contexts.
  // data-no-drag on buttons/tabs prevents them from initiating header-level drag.
  const handleHeaderPointerDown = isDraggableContext ? (e: React.PointerEvent) => {
    // Don't initiate drag from buttons, tabs, or other interactive elements
    const target = e.target as HTMLElement
    if (target.closest('[data-no-drag]') || target.closest('[data-tab-draggable]') || target.closest('button')) return
    e.preventDefault()
    if (overlayCtx?.onStartDrag) overlayCtx.onStartDrag(containerId, e)
    else if (floatingCtx?.onStartDrag) floatingCtx.onStartDrag(containerId, e)
  } : undefined

  const history = getNodeHistory(layoutState, historyRegion)
  // Back and forward sit on the strip itself, always visible (chrome zone header.nav): one history of everything this
  // pane showed, in order, tab switches included. Pointing at an arrow, or a long press on one, lists that history.
  const navArrows = zone('header.nav') ? (
    <NavArrows
      canBack={canHistoryBack(layoutState, historyRegion)}
      canForward={canHistoryForward(layoutState, historyRegion)}
      onBack={onHistoryBack}
      onForward={onHistoryForward}
      historyItems={history ? historyListItems(history, layoutState.tabs) : undefined}
      currentHistoryRef={currentHistoryRef(layoutState, historyRegion)}
      onSelectHistory={onHistorySelect}
      orientation={vertical ? 'vertical' : 'horizontal'}
    />
  ) : null

  // The ⋯ popover is one calm menu (shared DrillMenu): the pane's own actions as one row of icons, the ways to make
  // room as a second (halve this pane, or add a pane at its own size while every pane keeps its size and the
  // arrangement scrolls), then a short list whose secondary groups open beside it as their own popovers (in place with
  // Back on a phone). Every row is DATA.
  const floatingBar = placement.dockState === 'floating'
  const hiddenBar = placement.mode === 'auto'
  const drawing = markInteraction?.enabled ?? false
  const marksVisible = markInteraction?.marksVisible ?? true
  const drawRows: DrillRow[] = markInteraction ? DRAW_ROWS.filter((row) => !row.point).map((row) => {
    const on = row.area ? drawing && markInteraction.area === row.area : !marksVisible
    return { id: `draw:${row.id}`, label: on ? row.onLabel : row.label, icon: on ? 'Check' : row.icon, active: on, attrs: { 'data-draw-row': row.id } }
  }) : []
  const pointRow = DRAW_ROWS.find((row) => row.point)!
  const roomRows: DrillRow[] = [
    ...(zone('header.actions.split-horizontal') ? [
      { id: 'split-horizontal', label: 'Split in half, side by side', icon: 'SplitSquareHorizontal' },
      { id: 'add-beside', label: 'Add a pane beside', icon: 'PanelRight' },
    ] : []),
    ...(zone('header.actions.split-vertical') ? [
      { id: 'split-vertical', label: 'Split in half, stacked', icon: 'SplitSquareVertical' },
      { id: 'add-below', label: 'Add a pane below', icon: 'PanelBottom' },
    ] : []),
  ]
  const paneRows: DrillRow[] = [
    ...(zone('header.new-tab') ? [{ id: 'new-tab', label: 'New tab', icon: 'Plus' }] : []),
    ...(zone('header.actions.maximize') && controlShown('arrangement.focus') ? [{ id: 'maximize', label: isMaximized ? 'Restore size' : 'Maximize', icon: isMaximized ? 'Minimize2' : 'Maximize2', active: isMaximized }] : []),
    ...(zone('header.actions.overlay') && (isInOverlay || pictureInPictureShown()) ? [{ id: 'overlay', label: isInOverlay ? 'Back into the layout' : 'Float over the screen', icon: 'PictureInPicture', active: isInOverlay }] : []),
    ...(zone('header.actions.move') ? [dragRow] : []),
    ...(zone('header.actions.close') ? [{ id: 'close', label: 'Close pane', icon: 'X' }] : []),
  ]
  const tabsLevel: DrillLevel = {
    id: 'tabs',
    title: 'Tabs',
    sections: [
      ...(zone('header.tabs.position') ? [{ id: 'where', label: 'Where the tabs sit', panel: <PositionCompass current={placement.position} onSelect={placement.setPosition} />, attrs: { 'data-pane-bar-menu': '' } }] : []),
      { id: 'look', rows: [
        ...(zone('header.tabs.collapse') ? [{ id: 'bar-collapse', label: placement.mode === 'collapsed' ? 'Show tab names' : 'Tabs as icons', icon: placement.mode === 'collapsed' ? 'ChevronRight' : 'ChevronLeft' }] : []),
        ...(zone('header.tabs.undock') ? [{ id: 'bar-undock', label: floatingBar ? 'Dock the tabs' : 'Pop out the tabs', icon: floatingBar ? 'Pin' : 'PinOff' }] : []),
        ...TAB_BAR_VIEWS.filter((view) => zone(`header.tabs.view.${view.id}`)).map((view) => ({ id: `view:${view.id}`, label: `Show as ${view.label.toLowerCase()}`, icon: view.icon, checked: tabBarView.id === view.id })),
      ] },
      ...(zone('header.new-tab') ? [{ id: 'add', label: 'New tab', rows: NEW_TAB_EDGE_OPTIONS.map((o) => ({ id: `edge:${o.edge}`, label: o.label, icon: 'Plus' })) }] : []),
    ],
  }
  const paneMenuLevel: DrillLevel = {
    id: 'pane',
    title: 'This pane',
    sections: [
      ...(zone('header.actions') || zone('header.new-tab') ? [{ id: 'pane', look: 'icons' as const, rows: paneRows, attrs: { 'data-pane-menu': '' } }] : []),
      ...(zone('header.actions.present-files') && canAdmitPlaceableSurfaceFiles(placeableSurfaces) ? [{ id: 'present-files', panel: (
        <FilePicker label="Present files…" onFiles={(files) => {
          const tab = placeableSurfaceTabForFiles(files, placeableSurfaces)
          if (tab) layoutActions.addSurfaceTab(containerId, tab)
          setChevronOpen(false)
        }} />
      ), attrs: { 'data-pane-present-files': '' } }] : []),
      ...(roomRows.length ? [{ id: 'room', look: 'icons' as const, rows: roomRows, attrs: { 'data-pane-room-menu': '' } }] : []),
      { id: 'work', rows: [
        ...(markInteraction && zone('header.actions.draw') ? [
          { id: 'point', label: pointRow.label, icon: pointRow.icon, attrs: { 'data-draw-row': pointRow.id } },
          { id: 'draw', label: 'Draw', icon: 'Pencil', hint: drawing ? 'On' : undefined, next: { id: 'draw', title: 'Draw', sections: [{ id: 'draw', rows: drawRows, attrs: { 'data-pane-draw-menu': '' } }] } },
        ] : []),
        ...(floatingBar || !controlShown('sidebar.hide') ? [] : [{ id: 'bar-hide', label: hiddenBar ? 'Show sidebar' : 'Hide sidebar', icon: hiddenBar ? 'PanelLeftOpen' : 'PanelLeftClose', active: hiddenBar }]),
        ...(paneOffered.length && zone('header.actions.with-this') ? [{ id: 'with-this', label: `With ${paneAbout!.title}`, icon: 'Sparkles', attrs: { 'data-pane-with-this': '' }, next: { id: 'with-this', title: paneAbout!.title, sections: drillSectionsOf(paneOffered, () => setChevronOpen(false)) } }] : []),
        ...(zone('header.tabs') ? [{ id: 'tabs', label: 'Tabs', icon: 'PanelTop', hint: tabBarView.id === TAB_BAR_VIEWS[0].id ? undefined : tabBarView.label, next: tabsLevel }] : []),
        ...(zone('header.actions.layer') ? [{ id: 'layer', label: 'Move to layer', icon: 'Layers3', next: { id: 'layer', title: 'Move to layer', width: 'panel' as const, sections: [{ id: 'layer', panel: <React.Suspense fallback={null}><LayerPlacementPanel containerId={containerId} onDone={() => setChevronOpen(false)} /></React.Suspense> }] } }] : []),
        ...(zone('header.actions.mode') ? [{ id: 'mode', label: 'Pane mode', icon: 'LayoutDashboard', next: { id: 'mode', title: 'Pane mode', width: 'panel' as const, sections: [{ id: 'mode', panel: <ArrangementSurfaceControl embedded targetContainerId={containerId} />, attrs: { 'data-chevron-arrangement': '' } }] } }] : []),
        ...(zone('header.actions.layouts') ? [{ id: 'layouts', label: 'Layouts', icon: 'LayoutTemplate', next: { id: 'layouts', title: 'Layouts', width: 'panel' as const, sections: [{ id: 'layouts', panel: <LayoutPicker />, attrs: { 'data-chevron-layouts': '' } }] } }] : []),
        ...(zone('header.actions.open') ? [{ id: 'open', label: 'Open something here', icon: 'Search', next: { id: 'open', title: 'Open something here', width: 'panel' as const, sections: [{ id: 'open', attrs: { 'data-chevron-sidebar': '' }, panel: (
          <AppSidebar
            presentation="embedded"
            scope={listSource.scope}
            partitionLabel={listSource.partitionLabel}
            surfaceCollectionsGraph={listSource.graph}
            persistCollectionEdits={listSource.persistEdits}
            placeableSurfaceListAddressLabel={surfaceListAddress ?? undefined}
            knownPlaceableSurfaces={placeableSurfaces}
          />
        ) }] } }] : []),
      ] },
    ],
  }
  const onPaneRow = (row: DrillRow) => {
    const id = row.id
    const source = menuRowSource()
    if (paneAbout && source && paneOfferedIds.has(id)) {
      void runCommand(row.label, async () => source.act(paneAbout, id)).catch(() => undefined)
      setChevronOpen(false)
      return
    }
    if (id === 'new-tab') onNewTab()
    else if (id === 'split-horizontal') splitContainer(containerId, 'row')
    else if (id === 'split-vertical') splitContainer(containerId, 'column')
    else if (id === 'add-beside') addPaneBeside(containerId, 'row')
    else if (id === 'add-below') addPaneBeside(containerId, 'column')
    else if (id === 'overlay') handlePiPToggle()
    else if (id === 'maximize') toggleMaximize(containerId)
    else if (id === 'close') closeContainer(containerId)
    else if (id === 'bar-collapse') placement.setMode(placement.mode === 'collapsed' ? 'expanded' : 'collapsed')
    else if (id === 'bar-undock') placement.setDockState(floatingBar ? 'docked' : 'floating')
    else if (id === 'bar-hide') placement.setMode(hiddenBar ? 'expanded' : 'auto')
    else if (id.startsWith('edge:') || id.startsWith('view:')) onArrange(id)
    else if (id === 'point') { markInteraction?.setEnabled(false); startPointing() }
    else if (id.startsWith('draw:') && markInteraction) {
      const draw = DRAW_ROWS.find((row) => `draw:${row.id}` === id)!
      if (draw.area) markInteraction.drawIn(draw.area, !(drawing && markInteraction.area === draw.area))
      else markInteraction.setMarksVisible(!markInteraction.marksVisible)
    }
    if (!row.keepOpen) setChevronOpen(false)
  }

  // ⋯ is the bar's one control, after the tabs and outside the scrolling rows, so no number of tabs scrolls it away.
  // A host hiding both chrome zones header.new-tab and header.actions hides it.
  const moreControl = !zone('header.new-tab') && !zone('header.actions') ? null : (
    <Container layout="horizontal" alignItems="center" className={cn('flex-shrink-0', vertical && 'mt-1')} data-no-drag="true" data-pane-more-control>
      <Popover open={chevronOpen} onOpenChange={onChevronOpenChange}>
        {/* Pointing at ⋯ opens it after a short rest and it stays open while the pointer travels into it; a press after
            pointing pins it open (coss Popover), and a tap or the keyboard opens it too. */}
        <PopoverTrigger
          openOnHover
          delay={120}
          closeDelay={250}
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onMouseDown={(e) => e.stopPropagation()}
              className={cn('text-[var(--text-secondary)] hover:text-[var(--text-strong)]', chevronOpen && 'text-[var(--text-strong)]')}
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label="More for this pane"
              title="More for this pane"
            />
          }
        >
          <MoreHorizontal className="h-4 w-4" />
        </PopoverTrigger>
        <PopoverPopup className="sidebar-list-popover w-64 max-h-[80vh] overflow-hidden p-0" side="bottom" align="end" portalProps={{ className: 'coss-ui' }}>
          <Container layout="vertical" gap="none" className="max-h-[80vh] overflow-y-auto" data-pane-more-menu onClick={(event: React.MouseEvent) => {
            // A chosen screen or layout has opened; the menu closes with it.
            if ((event.target as Element).closest('[data-sidebar-activate]')) setChevronOpen(false)
          }}>
            {/* Whether every copy is in step, at the top of every pane's menu while something is not (the page's words,
                catch-up.tsx); nothing when all is caught up. */}
            <CatchUpMark className="mx-2 mt-2 self-start" />
            <DrillMenu level={paneMenuLevel} onSelect={onPaneRow} />
          </Container>
        </PopoverPopup>
      </Popover>
    </Container>
  )

  return (
    <div className="contents" onPointerDown={handleHeaderPointerDown}>
      {zone('header.tabs') || navArrows || moreControl ? <SidebarFrame
        placement={{ ...placement, width: placement.size, setWidth: placement.setSize }}
        containerRef={containerRef}
        inFlow
        hostControls
        capabilities={TAB_BAR_CAPABILITIES}
        controls={zoneControl('header.tabs')}
        homePosition={TAB_BAR_PLACEMENT_DEFAULT.position}
        ariaLabel="Tabs"
        // Zone header.tabs: the tabs themselves. Hidden, the strip keeps back and forward (header.nav) and ⋯ (header.actions).
        sections={zone('header.tabs') ? [{ id: `tabs:${containerId}`, items: tabRows }] : NO_SECTIONS}
        footerItems={NO_ROWS}
        currentSelectionId={selectedTabId}
        onNavigate={onActivate}
        onItemAction={onTabAction}
        rowEvents={rowEvents}
        leadingContent={navArrows}
        trailingContent={moreControl}
      /> : null}
      {closeFailure ? (
        <div
          role="alert"
          className={cn('mx-2 mb-1 flex items-center gap-2 rounded-md border border-status-error/30 bg-status-error/10 px-2 py-1 text-xs text-status-error', className)}
        >
          <span className="min-w-0 flex-1 truncate">
            {`${closeFailure.title} could not close. ${closeFailure.message}`}
          </span>
          <Button variant="ghost" size="xs" className="shrink-0" onClick={() => onClose(closeFailure.tabId)}>
            Retry
          </Button>
        </div>
      ) : null}
    </div>
  )
}

const NO_ROWS: NavItemData[] = []
const NO_SECTIONS: NavSectionData[] = []

/** The move control as a menu row. The row's button sits in a span that
 *  owns the drag: pointer drag in overlay and floating windows, HTML5
 *  drag-and-drop between panes. */
function useDragHandleRow(containerId: string): DrillRow {
  const drag = React.useContext(DragContext)
  const floatingWindow = React.useContext(FloatingWindowContext)
  const overlayWindow = React.useContext(OverlayWindowContext)
  const pointerDrag = overlayWindow?.onStartDrag ?? floatingWindow?.onStartDrag
  const label = overlayWindow?.onStartDrag ? 'Drag to move this window' : floatingWindow?.onStartDrag ? 'Drag to move this window' : 'Drag to move this pane'
  return {
    id: 'move',
    label,
    icon: 'Move',
    active: drag?.draggingId === containerId,
    wrap: (button) => pointerDrag ? (
      <span
        className="inline-flex cursor-grab active:cursor-grabbing"
        onPointerDown={(e) => { e.preventDefault(); pointerDrag(containerId, e) }}
      >{button}</span>
    ) : (
      <span
        className="inline-flex cursor-grab active:cursor-grabbing"
        draggable
        onDragStart={(e) => {
          const el = e.currentTarget.closest('[data-container-id]') as HTMLElement
          if (el) e.dataTransfer.setDragImage(el, 0, 0)
          drag?.setDraggingId(containerId)
          try { e.dataTransfer.setData('application/x-container-id', containerId) } catch {}
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragEnd={() => {
          drag?.setDraggingId(null)
          drag?.setOverId(null)
          drag?.setEdgeHover?.(null)
        }}
      >{button}</span>
    ),
  }
}
