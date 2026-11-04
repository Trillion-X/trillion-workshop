// packages/screen-arrangement/show/use-tab-bar-placement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Bind one container's tab bar to the shared ui dockable-placement primitive,
// the same primitive the sidebar and the drawing toolbar use. The owner state
// is the container's entry in LayoutState.tabBarPlacement; a change is staged
// optimistically and written back through the arrangement's own layout write,
// so it persists and restores with the rest of the arrangement.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. One store per container (createDockablePlacementStore), never shared.
// 2. Writes apply to the SETTLED layout (after queued operations flush), so a
//    placement change never overwrites a split, move or close still in flight.
// 3. When a show rule hides the control `arrangement.header.tabs.position`, the
//    tab bar has one place only: it sits at the default edge, whatever was saved.
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react'
import {
  createDockablePlacementStore,
  useDockablePlacement,
  type DockablePlacementController,
  type DockablePlacementState,
} from '../../ui/show/dockable-placement/dockable-placement'
import { LayoutActionsContext, LayoutStateContext } from './screen-arrangement-context'
import { readTabBarPlacement, TAB_BAR_PLACEMENT_DEFAULT, writeTabBarPlacement } from '../read-data/tab-bar-placement'
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of'

export function useTabBarPlacement(containerId: string): DockablePlacementController {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const saved = layoutState?.tabBarPlacement?.[containerId]
  const ownerState = React.useMemo(
    () => readTabBarPlacement({ tabBarPlacement: saved ? { [containerId]: saved } : undefined }, containerId),
    [saved, containerId],
  )
  const store = React.useMemo(() => createDockablePlacementStore(ownerState), [containerId])
  const persist = React.useCallback((next: DockablePlacementState) => {
    if (!layoutActions) return
    void layoutActions.flush()
      .then((current) => layoutActions.applyLayoutState(writeTabBarPlacement(current, containerId, next)))
      .catch(() => {
        // A rejected queued operation left no settled arrangement; the staged
        // value stays on screen and the next successful write carries it.
      })
  }, [layoutActions, containerId])
  const controller = useDockablePlacement(store, ownerState, persist)
  useShowChange()
  const positionFixed = !controlShown('arrangement.header.tabs.position')
  return React.useMemo(
    () => (positionFixed ? { ...controller, position: TAB_BAR_PLACEMENT_DEFAULT.position } : controller),
    [controller, positionFixed],
  )
}
