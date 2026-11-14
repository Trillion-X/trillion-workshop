// packages/sidebar/show/useSidebarPlacement.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Sidebar placement hook backed by package-owned descriptor state.
// Manages position, dock state, mode, width, and floating rectangle while
// preserving the existing selector helper API for sidebar consumers.
//
// The placement MECHANICS (optimistic store, persist-reconcile, controller,
// selectors) live in the generic ui dockable-placement primitive — the
// sidebar supplies only its Society: the `sidebar-placement` feed decode and
// the `action:update-sidebar-placement` persistence. Any other dockable
// chrome (e.g. the drawing toolbar) shares the same primitive.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Durable state reads from the package descriptor through useBitfieldData
// 2. Durable writes go through action:update-sidebar-placement
// 3. Optimistic React state is render-only and reconciles to descriptor data
//    (createDockablePlacementStore semantics — see packages/ui)
// 4. No browser-owned persistence authority exists in this hook
// 5. Derived selectors remain pure functions
// 6. The persisted wire shape stays {position, dockState, mode, width,
//    floatRect} — existing records keep decoding unchanged
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import * as React from 'react'
import { useBitfieldData } from '#workspace-records'
import {
  createDockablePlacementStore,
  selectDockIsFloating,
  selectDockIsVertical,
  selectDockOrientation,
  useDockablePlacement,
  type DockablePlacementState,
} from '../../ui/show/dockable-placement'
import { updateSidebarPlacement } from '../do-work/update-sidebar-placement'
import {
  decodeSidebarPlacementFeed,
  DEFAULT_SIDEBAR_PLACEMENT_STATE,
  type FloatRect,
  type SidebarDockState,
  type SidebarMode,
  type SidebarPlacementState,
  type SidebarPosition,
  type SidebarSeam,
  type SidebarPoint,
  type SidebarFit,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/read-sidebar-placement.ts'

export type {
  SidebarSeam,
  SidebarPoint,
  SidebarFit,
  FloatRect,
  SidebarDockState,
  SidebarMode,
  SidebarPlacementState,
  SidebarPosition,
} from 'trillion-workshop/tools/organize-the-sidebar/read-data/read-sidebar-placement.ts'

export interface SidebarPlacementController extends SidebarPlacementState {
  setPosition: (position: SidebarPosition) => void
  setDockState: (dockState: SidebarDockState) => void
  setMode: (mode: SidebarMode) => void
  setWidth: (width: number) => void
  setFloatRect: (rect: Partial<FloatRect>) => void
  /** Puts the sidebar on a window edge or a seam between two panes, unfolded; a seam keeps `position` as where it goes when the seam is gone. */
  placeAt: (at: { position: SidebarPosition } | { seam: SidebarSeam }) => void
  /** Folds it to its handle, at a point of the window (shares of its width and height) when given. */
  foldAt: (point?: SidebarPoint) => void
  /** How many icons the thin bar shows. */
  setFit: (fit: SidebarFit | undefined) => void
}

// ---------------------------------------------------------------------------
// WIRE SHAPE MAPPING — sidebar records say `width`; the primitive says `size`
// ---------------------------------------------------------------------------

function toDockable(state: SidebarPlacementState): DockablePlacementState {
  return {
    position: state.position,
    dockState: state.dockState,
    mode: state.mode,
    size: state.width,
    floatRect: state.floatRect,
    ...(state.seam ? { seam: state.seam } : {}),
    ...(state.foldedAt ? { foldedAt: state.foldedAt } : {}),
    ...(state.fit ? { fit: state.fit } : {}),
  }
}

function toSidebar(state: DockablePlacementState): SidebarPlacementState {
  return {
    position: state.position,
    dockState: state.dockState,
    mode: state.mode,
    width: state.size,
    floatRect: state.floatRect,
    ...(state.seam ? { seam: state.seam } : {}),
    ...(state.foldedAt ? { foldedAt: state.foldedAt } : {}),
    ...(state.fit ? { fit: state.fit } : {}),
  }
}


// The sidebar is a singleton surface: one shared store instance keeps every
// sidebar consumer (desktop/mobile/control items) on the same live state.
const sidebarPlacementStore = createDockablePlacementStore(toDockable(DEFAULT_SIDEBAR_PLACEMENT_STATE))

// ---------------------------------------------------------------------------
// HOOK
// ---------------------------------------------------------------------------

export function useSidebarPlacement(): SidebarPlacementController
export function useSidebarPlacement<T>(selector: (state: SidebarPlacementState) => T): T
export function useSidebarPlacement<T>(selector?: (state: SidebarPlacementState) => T): SidebarPlacementController | T {
  const placementEntry = useBitfieldData('sidebar-placement')
  const ownerState = React.useMemo(
    () => toDockable(decodeSidebarPlacementFeed(placementEntry)),
    [placementEntry],
  )

  const persist = React.useCallback((next: DockablePlacementState) => {
    void updateSidebarPlacement(toSidebar(next))
  }, [])

  const dockable = useDockablePlacement(sidebarPlacementStore, ownerState, persist)

  const controller = React.useMemo<SidebarPlacementController>(() => ({
    ...toSidebar(dockable),
    setPosition: dockable.setPosition,
    setDockState: dockable.setDockState,
    setMode: dockable.setMode,
    setWidth: dockable.setSize,
    setFloatRect: dockable.setFloatRect,
    placeAt: dockable.placeAt,
    foldAt: dockable.foldAt,
    setFit: dockable.setFit,
  }), [dockable])

  return selector ? selector(controller) : controller
}

// ---------------------------------------------------------------------------
// DERIVED SELECTORS — sidebar-named wrappers over the generic ui selectors
// ---------------------------------------------------------------------------

/**
 * Returns true for left/right positions (sidebar is a vertical strip).
 * Returns false for top/bottom (sidebar is a horizontal strip).
 */
export function selectIsVertical(state: SidebarPlacementState): boolean {
  return selectDockIsVertical(state)
}

/**
 * Returns true when the sidebar is in floating (undocked) mode.
 */
export function selectIsFloating(state: SidebarPlacementState): boolean {
  return selectDockIsFloating(state)
}

/**
 * Returns 'vertical' for left/right positions, 'horizontal' for top/bottom.
 */
export function selectOrientation(state: SidebarPlacementState): 'vertical' | 'horizontal' {
  return selectDockOrientation(state)
}

/**
 * Returns true when labels should be visible (expanded mode).
 * Used by sidebar-owned components that decide whether sidebar labels are visible.
 */
export function selectShowLabels(state: SidebarPlacementState): boolean {
  return state.mode === 'expanded'
}
