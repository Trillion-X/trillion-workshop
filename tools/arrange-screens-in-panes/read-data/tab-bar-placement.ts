// packages/screen-arrangement/read-data/tab-bar-placement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Where each container's tab bar sits and how much of it shows. A tab bar is a
// dockable edge bar exactly like the sidebar, so its state IS the shared ui
// dockable-placement state (position = which edge, mode = shown / minimized /
// hidden until pointed at). This file only reads and writes that state inside
// the arrangement's LayoutState; the mechanics (store, reconcile, controller)
// stay in packages/ui/show/dockable-placement.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. One map, keyed by container id: `LayoutState.tabBarPlacement`. A container
//    with no entry uses TAB_BAR_PLACEMENT_DEFAULT (top, shown), so every saved
//    arrangement from before this field keeps looking exactly as it did.
// 2. Values decode through the primitive's own decoder, never a second parser.
// 3. Pure: state in, state out. No React, no I/O.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import {
  DEFAULT_DOCKABLE_PLACEMENT_STATE,
  decodeDockablePlacementValue,
  type DockablePlacementState,
} from '../../ui/show/dockable-placement/dockable-placement'
import type { LayoutState } from './layout-types'

/** A tab bar starts on top and fully shown; `size` is its width when docked left or right. */
export const TAB_BAR_PLACEMENT_DEFAULT: DockablePlacementState = {
  ...DEFAULT_DOCKABLE_PLACEMENT_STATE,
  position: 'top',
  mode: 'expanded',
  size: 184,
}

/** This container's tab bar placement (the default when none is saved). */
export function readTabBarPlacement(
  state: Pick<LayoutState, 'tabBarPlacement'>,
  containerId: string,
): DockablePlacementState {
  return decodeDockablePlacementValue(state.tabBarPlacement?.[containerId], TAB_BAR_PLACEMENT_DEFAULT)
}

/** The same LayoutState with this container's tab bar placement replaced. */
export function writeTabBarPlacement(
  state: LayoutState,
  containerId: string,
  placement: DockablePlacementState,
): LayoutState {
  return { ...state, tabBarPlacement: { ...(state.tabBarPlacement ?? {}), [containerId]: placement } }
}

/**
 * Keep well-formed entries for containers that still exist. Used by
 * normalizeLayoutState so a layout write never silently drops the choice.
 */
export function normalizeTabBarPlacement(
  raw: unknown,
  containerIds: ReadonlySet<string>,
): Record<string, DockablePlacementState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, DockablePlacementState> = {}
  for (const [containerId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!containerIds.has(containerId) || !value || typeof value !== 'object') continue
    out[containerId] = decodeDockablePlacementValue(value, TAB_BAR_PLACEMENT_DEFAULT)
  }
  return out
}

/**
 * The views a tab bar can draw its tabs in. Each is a sidebar row look (`look`,
 * a key of the sidebar's row looks) or the sidebar's plain list rows (no look),
 * so a new view is one row here.
 */
export const TAB_BAR_VIEWS: ReadonlyArray<{ id: string; label: string; icon: string; look?: string }> = [
  { id: 'tabs', label: 'Tabs', icon: 'PanelTop', look: 'tab' },
  { id: 'list', label: 'List', icon: 'List' },
]

/** This container's tab bar view (the first view when none is saved or the saved one is gone). */
export function readTabBarView(state: Pick<LayoutState, 'tabBarView'>, containerId: string): (typeof TAB_BAR_VIEWS)[number] {
  const id = state.tabBarView?.[containerId]
  return TAB_BAR_VIEWS.find((view) => view.id === id) ?? TAB_BAR_VIEWS[0]
}

/** The same LayoutState with this container's tab bar view replaced. */
export function writeTabBarView(state: LayoutState, containerId: string, viewId: string): LayoutState {
  return { ...state, tabBarView: { ...(state.tabBarView ?? {}), [containerId]: viewId } }
}

/** Keep the views of containers that still exist, so a layout write never drops the choice. */
export function normalizeTabBarView(raw: unknown, containerIds: ReadonlySet<string>): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>)
    .filter((entry): entry is [string, string] => containerIds.has(entry[0]) && typeof entry[1] === 'string'))
}
