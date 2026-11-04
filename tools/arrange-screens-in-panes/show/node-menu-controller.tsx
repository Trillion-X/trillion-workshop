// packages/screen-arrangement/show/node-menu-controller.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The SINGLE node-context-menu controller for the whole screen-arrangement
// surface. One menu instance for every region — tabs, containers, the freeform
// canvas, the surface root. It is the SSOT: ContainerHeader, FreeformArranger,
// and the surface root all open the SAME menu, never their own copy.
//
// The menu itself is blind (ui/NodeContextMenu). This controller only owns the
// translation from a generic NodeRef (== region AddressRef) to THIS surface's
// stores (L098): a tab's name lives in tabs[id].title; a node's decoration lives
// in its region's visual layer stack. None of that vocabulary reaches the menu —
// it receives a DATA action pack (node-action-pack) and renders whatever each
// action's `accepts(nodeRef)` admits.
//
// Two ways to open the menu, both routed here:
//   1. Delegation — `nodeMenuContextHandler(openFor)` reads `data-node-ref` off
//      the nearest region ancestor of the right-clicked element. Any region that
//      stamps `data-node-ref` gets a menu for free (L063 category fix). Used by
//      container bodies and the canvas background.
//   2. Explicit — `openFor(nodeRef, point)` via NodeMenuContext, for elements
//      whose component has a closed prop set and can't carry data-* (PaneTab).
// =============================================================================

'use client'

import React, { useCallback, useMemo } from 'react'
import { useNodeContextMenu, type NodeRef } from '../../ui/show/node-actions'
import { type AddressRef, type VisualLayerDescriptor } from '../../ui/show/visual-layer-stack'
import { buildNodeActionPack } from './node-action-pack'
import { contributedNodeActions } from '../../ui/show/node-actions'
import {
  setRegionLayer,
  getRegionLayers,
  removeRegionLayer,
  reorderRegionLayers,
  patchRegionLayer,
  patchRegionLayerInput,
} from './visual-layer-runtime'
import {
  addNodeBookmark,
  listNodeBookmarks,
  removeNodeBookmark,
} from '../do-work/node-bookmark-operations'
import { REGION_FAMILY, containerRegion } from '../read-data/region-address'
import {
  toggleRegionImmersive as computeToggledRegionChrome,
  regionIsImmersive as readRegionImmersive,
} from '../read-data/region-chrome'
import type { BookmarkRowInfo } from '../../ui'
import {
  LayoutActionsContext,
  LayoutStateContext,
} from './screen-arrangement-context'
import {
  type TabPresentationMode,
  DEFAULT_TAB_PRESENTATION_MODE,
} from '../read-data/tab-presentation-modes'

/** Opens the one shared node menu for a region at a viewport point. */
export type OpenNodeMenu = (nodeRef: NodeRef, point: { x: number; y: number }) => void

/** Lets any descendant open the single shared node menu explicitly. */
export const NodeMenuContext = React.createContext<{ openFor: OpenNodeMenu } | null>(null)

export function useNodeMenu(): { openFor: OpenNodeMenu } | null {
  return React.useContext(NodeMenuContext)
}

/**
 * The minimal contextmenu-event shape the delegated handler needs. Both
 * `React.MouseEvent` and the DOM `MouseEvent` satisfy it, so the same handler
 * works whether bound in JSX or attached as a native listener.
 */
type DelegatedContextEvent = {
  target: EventTarget | null
  clientX: number
  clientY: number
  defaultPrevented?: boolean
  preventDefault(): void
  stopPropagation(): void
}

/**
 * A delegated right-click handler: walks up from the event target to the nearest
 * element carrying `data-node-ref` (a JSON-encoded region AddressRef) and opens
 * the shared menu for it. Returns a noop-safe handler — clicks with no region
 * ancestor fall through untouched (browser default menu suppressed only when a
 * region is found).
 */
export function nodeMenuContextHandler(openFor: OpenNodeMenu) {
  return (event: DelegatedContextEvent): void => {
    // Something inside already answered this right-click with its own menu (a record, a text field).
    if (event.defaultPrevented) return
    const el = (event.target as HTMLElement | null)?.closest('[data-node-ref]')
    const raw = el?.getAttribute('data-node-ref')
    if (!raw) return
    let ref: AddressRef
    try {
      ref = JSON.parse(raw) as AddressRef
    } catch {
      return
    }
    if (!ref || typeof ref.family !== 'string') return
    event.preventDefault()
    event.stopPropagation()
    openFor(ref, { x: event.clientX, y: event.clientY })
  }
}

export { nodeRefAttr } from './node-ref-attr'

/** Family -> a glyph for a bookmark list row. Pure presentation DATA. */
const FAMILY_ICON: Record<string, string> = {
  [REGION_FAMILY.tab]: 'Square',
  [REGION_FAMILY.container]: 'Columns2',
  [REGION_FAMILY.canvas]: 'LayoutDashboard',
  [REGION_FAMILY.surface]: 'Layout',
}

/**
 * Build the one shared node menu. Reads the owner contexts directly, so it can be
 * mounted once at the surface root. Returns `openFor` (route every opener here)
 * and `contextMenu` (render once at the root).
 */
export function useNodeMenuController(): { openFor: OpenNodeMenu; contextMenu: React.ReactNode } {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  if (!layoutState || !layoutActions) {
    throw new Error('Screen-arrangement owner context missing for useNodeMenuController')
  }
  const { applyLayoutState, updateTabMeta, activateTab, focusContainer, setSurface } = layoutActions

  // Family -> how to "open" (focus/activate) a node of that family. This is the
  // owner's translation layer (L098): the generic menu/panel never names a
  // family; the surface — which owns the families — maps each to a navigation
  // action. A DATA map keyed by family string, not a switch(kind) (L090).
  const openNode = useCallback(
    (nodeRef: NodeRef): void => {
      const navigate: Record<string, (parts: Record<string, string>) => void> = {
        [REGION_FAMILY.tab]: (parts) => parts.tabId && activateTab(parts.tabId),
        [REGION_FAMILY.container]: (parts) => parts.containerId && focusContainer(parts.containerId),
        [REGION_FAMILY.canvas]: () => setSurface('canvas'),
        [REGION_FAMILY.surface]: (parts) => parts.surface && setSurface(parts.surface),
      }
      navigate[nodeRef.family]?.(nodeRef.parts as Record<string, string>)
    },
    [activateTab, focusContainer, setSurface],
  )

  const setTabPresentationMode = useCallback(
    (tabId: string, presentationMode: TabPresentationMode) => {
      const tab = layoutState.tabs[tabId]
      if (!tab) return
      const metadata =
        tab.metadata && typeof tab.metadata === 'object' && !Array.isArray(tab.metadata)
          ? tab.metadata
          : {}
      updateTabMeta(tabId, { metadata: { ...metadata, presentationMode } })
    },
    [layoutState.tabs, updateTabMeta],
  )

  // A tab has no chrome of its own — chrome lives at the container/surface level —
  // so "make this tab immersive" means make its CONTAINER (the pane showing it)
  // immersive. Resolve a tab nodeRef to its container region; container/canvas/
  // surface regions are already chrome-bearing and used as-is.
  const immersiveRegionOf = useCallback(
    (nodeRef: NodeRef): AddressRef => {
      if (nodeRef.family === REGION_FAMILY.tab) {
        const tabId = nodeRef.parts.tabId
        const container = Object.values(layoutState.containers).find(
          (c) => layoutState.tabGroups[c.groupId]?.tabIds.includes(tabId as string),
        )
        if (container) return containerRegion(container.id)
      }
      return nodeRef
    },
    [layoutState.containers, layoutState.tabGroups],
  )

  const services = useMemo(
    () => ({
      setTabPresentationMode,
      getTabPresentationMode: (tabId: string): TabPresentationMode => {
        const stored = layoutState.tabs[tabId]?.metadata?.presentationMode
        // Open string — return whatever mode the tab declares, or the default
        // when none is set (the renderer falls back for any mode it can't paint).
        return typeof stored === 'string' && stored.length > 0 ? stored : DEFAULT_TAB_PRESENTATION_MODE
      },
      nodeName: (nodeRef: NodeRef): string => {
        const tabId = nodeRef.parts.tabId
        return (tabId && layoutState.tabs[tabId]?.title) || nodeRef.parts.containerId || 'Untitled'
      },
      renameNode: (nodeRef: NodeRef, name: string): void => {
        const tabId = nodeRef.parts.tabId
        if (tabId && layoutState.tabs[tabId]) updateTabMeta(tabId, { title: name })
      },
      getNodeLayers: (nodeRef: NodeRef): readonly VisualLayerDescriptor[] =>
        getRegionLayers(layoutState, nodeRef),
      addNodeLayer: (nodeRef: NodeRef, descriptor: VisualLayerDescriptor): void =>
        setRegionLayer(layoutState, applyLayoutState, nodeRef, descriptor),
      reorderNodeLayers: (nodeRef: NodeRef, orderedIds: string[]): void =>
        reorderRegionLayers(layoutState, applyLayoutState, nodeRef, orderedIds),
      patchNodeLayer: (nodeRef: NodeRef, layerId: string, patch: Record<string, unknown>): void =>
        patchRegionLayer(layoutState, applyLayoutState, nodeRef, layerId, patch),
      patchNodeLayerInput: (
        nodeRef: NodeRef,
        layerId: string,
        inputPatch: Record<string, unknown>,
      ): void => patchRegionLayerInput(layoutState, applyLayoutState, nodeRef, layerId, inputPatch),
      removeNodeLayer: (nodeRef: NodeRef, layerId: string): void =>
        removeRegionLayer(layoutState, applyLayoutState, nodeRef, layerId),
      bookmarkNode: (nodeRef: NodeRef): void => {
        const tabId = nodeRef.parts.tabId
        const label =
          (tabId && layoutState.tabs[tabId]?.title) || nodeRef.parts.containerId || 'Untitled'
        addNodeBookmark(layoutState, applyLayoutState, nodeRef, label, Date.now())
      },
      listBookmarks: (): BookmarkRowInfo[] =>
        listNodeBookmarks(layoutState).map((bookmark) => ({
          id: bookmark.id,
          label: bookmark.label,
          ...(bookmark.folder ? { folder: bookmark.folder } : {}),
          icon: FAMILY_ICON[bookmark.nodeRef.family] ?? 'Square',
        })),
      removeBookmark: (bookmarkId: string): void =>
        removeNodeBookmark(layoutState, applyLayoutState, bookmarkId),
      openBookmark: (bookmarkId: string): void => {
        const bookmark = layoutState.nodeBookmarks?.[bookmarkId]
        if (bookmark) openNode(bookmark.nodeRef)
      },
      toggleRegionImmersive: (nodeRef: NodeRef): void => {
        applyLayoutState({
          ...layoutState,
          regionChrome: computeToggledRegionChrome(layoutState.regionChrome, immersiveRegionOf(nodeRef)),
        })
      },
      regionIsImmersive: (nodeRef: NodeRef): boolean =>
        readRegionImmersive(layoutState.regionChrome, immersiveRegionOf(nodeRef)),
    }),
    [setTabPresentationMode, immersiveRegionOf, layoutState, updateTabMeta, applyLayoutState, openNode],
  )

  // The surface's own actions, then whatever the page contributed (ui contributed-node-actions: a tray's "Add to
  // tray"), read on every render so an action contributed after this mounted still shows. One menu either way.
  const own = useMemo(() => buildNodeActionPack(services), [services])
  const menu = useNodeContextMenu([...own, ...contributedNodeActions()])
  return { openFor: menu.openFor, contextMenu: menu.contextMenu }
}
