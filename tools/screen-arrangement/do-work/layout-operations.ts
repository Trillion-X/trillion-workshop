// packages/screen-arrangement/do-work/layout-operations.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Build screen-arrangement request bytes and apply slot replies. This file owns
// caller-side request construction only; `slot::screen-arrangement` owns the
// canonical split/freeform/overlay arrangement math.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. No canonical arrangement mutation is calculated in TypeScript.
// 2. Every operation sends current LayoutState plus opaque request payload.
// 3. The slot reply state is the only committed next state.
// 4. Browser-only viewport facts may be included as request input; they are not
//    arrangement policy.
//
// =============================================================================

import type { Camera, LayoutState, TabMeta } from '../read-data/layout-types'
import type { ArrangementConstraints } from '../read-data/arrangement-constraints'
import { hasArrangementConstraints } from '../read-data/arrangement-constraints'
import { askScreenArrangement } from './ask-screen-arrangement'
import { recordVisits } from './node-history-operations'
import { paneSizesNow } from '../read-data/pane-sizes'
import { normalizeLayoutState } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/read-screen-arrangement.ts'
import { type SurfaceMode, baseGeometryForSurface } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/surface-modes.ts'
import { arrangementHistoryLabel, recordArrangementChange, redoArrangement, restoreArrangementAt, undoArrangement } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/arrangement-history.ts'

export interface LayoutActionContext {
  state: LayoutState

  addTab: (containerId: string, tab: TabMeta) => void
  addSurfaceTab: (containerId: string, tab: TabMeta) => void
  /** Apply ordered slot-owned transitions in one slot round-trip. */
  applySequence: (operations: ArrangementOperation[]) => void
  /**
   * Resolves only after the canonical slot has accepted the close and its reply
   * has been committed locally. Presentation callers may hide the tab while
   * this acknowledgement is pending, then restore it if the promise rejects.
   */
  closeTab: (tabId: string) => Promise<void>
  activateTab: (tabId: string) => void
  updateTabMeta: (tabId: string, patch: Partial<TabMeta>) => void
  moveTabToContainer: (tabId: string, targetContainerId: string, index?: number) => void
  applyLayoutState: (state: LayoutState) => void
  undoArrangement: () => void
  redoArrangement: () => void
  restoreArrangementHistory: (index: number) => void

  createContainer: (containerId: string, groupId: string, tabIds?: string[]) => void
  closeContainer: (containerId: string) => void
  splitContainer: (containerId: string, dir: 'row' | 'column', initialTab?: TabMeta, position?: 'before' | 'after') => void
  focusContainer: (containerId: string) => void
  unfocusContainer: () => void

  toggleOverlay: (containerId: string) => void
  moveOverlay: (containerId: string, xy: { x: number; y: number }) => void
  resizeOverlay: (containerId: string, size: { w: number; h: number }) => void
  bringOverlayToFront: (containerId: string) => void

  /** Record every child size of the split at `path`, in layout pixels. */
  resizeSplit: (sizesPx: number[], path: number[]) => void
  /** Record one child's own length across the split at `path` (its height in a row), in layout pixels; null fills. */
  resizeCross: (path: number[], index: number, lengthPx: number | null) => void
  /**
   * Add a pane beside (`row`) or below (`column`) `containerId` at the person's added-pane length, every pane keeping
   * the size it is drawn at now; the arrangement grows and scrolls instead of shrinking anything.
   */
  addPaneBeside: (containerId: string, dir: 'row' | 'column', initialTab?: TabMeta, position?: 'before' | 'after') => void

  moveFloating: (containerId: string, xy: { x: number; y: number }) => void
  resizeFloating: (containerId: string, size: { w: number; h: number }) => void
  updateFloatingRect: (containerId: string, rect: { x: number; y: number; w: number; h: number }) => void
  bringFloatingToFront: (containerId: string) => void
  setCamera: (camera: Partial<Camera>) => void
  createFloatingContainerWithTab: (tabId: string, rect: { x: number; y: number; w: number; h: number }) => void
  createFloatingContainerWithSurface: (tab: TabMeta, rect: { x: number; y: number; w: number; h: number }) => void

  splitContainerWithTab: (targetContainerId: string, dir: 'row' | 'column', tabId: string, position?: 'before' | 'after') => void
  splitContainerWithSurface: (targetContainerId: string, dir: 'row' | 'column', tab: TabMeta, position?: 'before' | 'after') => void
  swapContainers: (a: string, b: string) => void
  moveContainerToEdge: (sourceId: string, targetId: string, dir: 'row' | 'column', position?: 'before' | 'after') => void

  splitAtRoot: (dir: 'row' | 'column', position: 'before' | 'after', initialTab?: TabMeta) => void
  splitRootWithTab: (dir: 'row' | 'column', position: 'before' | 'after', tabId: string) => void
  splitRootWithSurface: (dir: 'row' | 'column', position: 'before' | 'after', tab: TabMeta) => void
  moveContainerToRoot: (containerId: string, dir: 'row' | 'column', position: 'before' | 'after') => void

  toggleMaximize: (containerId: string) => void
  setSurface: (surface: SurfaceMode) => void
  setActiveLayer: (layerId: string) => void
  moveContainerToLayer: (containerId: string, layerId: string, placement?: 'grid' | 'canvas' | 'overlay', position?: { x: number; y: number }) => void
  createLayer: (name?: string) => void
  /** Restack every layer back-to-front in the given order. */
  reorderLayers: (layerIds: string[]) => void

  /**
   * Await every queued operation, then return the settled state. Generic
   * engine primitive (not tied to any one caller) — any composer that fires
   * several arrangement ops back-to-back and then needs the RESULT (e.g. to
   * persist it) awaits this instead of re-deriving completion out-of-band.
   */
  flush: () => Promise<LayoutState>
  /**
   * Barrier over the existing operation and persistence owners. It is generic:
   * callers do not name a destination or protocol; they merely await the
   * layout state their already-issued operations made durable.
   */
  awaitDurable: () => Promise<LayoutState>
}

export type LayoutActions = Omit<LayoutActionContext, 'state'>

export interface ArrangementOperation {
  operation: string
  payload?: unknown
}

export interface LayoutActionRuntime {
  readState: () => LayoutState
  commitState: (state: LayoutState, publication?: unknown, alreadyDurable?: boolean) => void
  reportError?: (error: unknown) => void
  /** Keeps a state where it is saved now: the full arrangement or, while a limit is in force, the limited view's own
   *  keyed copy (the owner decides which). */
  persistState?: (state: LayoutState) => Promise<void>
  /** The size each tiled pane is drawn at now (layout pixels, by container id).
   * Sent with every operation so a new pane never takes room from the others. */
  readDrawnPaneSizes?: () => Record<string, { w: number; h: number }>
  /** What the host draws differently from the slot's reply (a row the person placed side by side kept side by side on
   * the stage they placed it on), applied to every reply before it is committed. */
  settleReply?: (prev: LayoutState, next: LayoutState) => LayoutState
  /** Current rule-driven presentation limits; geometry is enforced by Rust. */
  readConstraints?: () => ArrangementConstraints
}

export function arrangementViewport() {
  if (typeof window === 'undefined') return { w: 1280, h: 720 }
  return { w: window.innerWidth, h: window.innerHeight }
}

// The SSOT boundary between the screen-arrangement SLOT and the CLIENT, expressed
// STRUCTURALLY rather than as a closed list (B2 — enum dissolution):
//
//   the slot OWNS the arrangement geometry it RETURNS;
//   the client OWNS every field the slot's reply OMITS.
//
// The slot's owned fields (containers/tabGroups/tabs/layouts/surface/focused/
// maximized) are REQUIRED — always present in the reply. The client-added
// side-maps (region decoration layer stacks, node bookmarks, nav history, chrome,
// and ANY future one) are optional fields the slot does not model and therefore
// always omits — so carrying forward "present in prev, absent in reply" preserves
// exactly them, and clobbers nothing the slot owns. Adding a new client-owned
// side-map needs ZERO change here — it is preserved by the rule, not by being
// named in a list. (Replaces the old closed CLIENT_OWNED_LAYOUT_FIELDS; this is
// also why region decoration used to vanish on the next click.)
export function preserveClientOwnedFields(prev: LayoutState, next: LayoutState): LayoutState {
  const merged = { ...next } as Record<string, unknown>
  const prevRecord = prev as unknown as Record<string, unknown>
  for (const key of Object.keys(prevRecord)) {
    if (merged[key] === undefined && prevRecord[key] !== undefined) {
      merged[key] = prevRecord[key]
    }
  }
  return merged as unknown as LayoutState
}

export function createLayoutActions(runtime: LayoutActionRuntime): LayoutActions {
  const settle = runtime.settleReply ?? ((_prev: LayoutState, next: LayoutState) => next)
  let operationChain: Promise<void> = Promise.resolve()
  // A barrier seals one epoch synchronously. Each operation joins exactly one
  // epoch; the recovered execution tail remains usable after rejection, while
  // the sealed epoch preserves every failure in its captured causal prefix.
  type OperationEpoch = { tail: Promise<void>; failure: unknown | null }
  const newEpoch = (): OperationEpoch => ({ tail: Promise.resolve(), failure: null })
  let operationEpoch = newEpoch()

  const request = (
    operation: string,
    payload?: unknown,
    includeViewport = false,
    skipWhen?: (state: LayoutState) => boolean,
    persistBeforeCommit = false,
    stateOverride?: LayoutState,
  ): Promise<void> => {
    const epoch = operationEpoch
    const operationPromise = operationChain.then(async () => {
      const prev = runtime.readState()
      const constraints = runtime.readConstraints?.()
      // Some high-frequency pointer paths request focus even when the target
      // already owns it. Check after earlier queued operations settle, so this
      // avoids a needless slot round-trip without dropping a queued focus-back.
      if (skipWhen?.(prev)) return
      const reply = await askScreenArrangement({
        state: stateOverride ?? prev,
        operation,
        payload,
        ...(includeViewport ? { viewport: arrangementViewport() } : {}),
        ...(runtime.readDrawnPaneSizes ? { paneSizes: runtime.readDrawnPaneSizes() } : {}),
        ...(constraints && hasArrangementConstraints(constraints) ? { constraints } : {}),
      })
      const policyChanged = JSON.stringify(constraints && hasArrangementConstraints(constraints) ? constraints : null)
        !== JSON.stringify((runtime.readConstraints?.() && hasArrangementConstraints(runtime.readConstraints()) ? runtime.readConstraints() : null))
      if (policyChanged) return
      // Whatever changed what a pane shows, the pane's history records it here, the one road every such change takes.
      let settled = settle(prev, preserveClientOwnedFields(prev, reply.state))
      const constrained = !!constraints && hasArrangementConstraints(constraints)
      if (constrained) {
        const enforced = await askScreenArrangement({ state: settled, operation: 'constrain', constraints })
        const latestConstraints = runtime.readConstraints?.()
        if (JSON.stringify(constraints) !== JSON.stringify(latestConstraints && hasArrangementConstraints(latestConstraints) ? latestConstraints : null)) return
        settled = preserveClientOwnedFields(settled, enforced.state)
      }
      const next = recordArrangementChange(
        prev,
        recordVisits(prev, settled, Date.now()),
        arrangementHistoryLabel(operation),
        Date.now(),
        ['resizeSplit', 'resizeCross', 'moveFloating', 'updateFloatingRect', 'moveOverlay', 'resizeOverlay'].includes(operation)
          ? operation
          : undefined,
      )
      if (persistBeforeCommit) await runtime.persistState?.(next)
      if (persistBeforeCommit && runtime.persistState) runtime.commitState(next, reply.publication, true)
      else runtime.commitState(next, reply.publication)
    })
    operationChain = operationPromise.catch((error) => {
      runtime.reportError?.(error)
    })
    epoch.tail = epoch.tail.then(() => operationPromise).catch((error) => {
      if (epoch.failure === null) epoch.failure = error
    })
    return operationPromise
  }

  const flushOperations = async (): Promise<LayoutState> => {
    const epoch = operationEpoch
    operationEpoch = newEpoch()
    await epoch.tail
    if (epoch.failure !== null) throw epoch.failure
    return runtime.readState()
  }

  return {
    addTab: (containerId, tab) => request('addTab', { containerId, tab }),
    addSurfaceTab: (containerId, tab) => request('addSurfaceTab', { containerId, tab }),
    // A sequence may switch to a floating base (canvas), which arranges against the viewport.
    applySequence: (operations) => request('applySequence', { operations }, true),
    closeTab: (tabId) => request('closeTab', { tabId }),
    activateTab: (tabId) => request('activateTab', { tabId }),
    updateTabMeta: (tabId, patch) => request('updateTabMeta', { tabId, patch }),
    moveTabToContainer: (tabId, targetContainerId, index) => {
      request('moveTabToContainer', { tabId, targetContainerId, index })
    },
    applyLayoutState: (state) => {
      const before = runtime.readState()
      const next = recordArrangementChange(before, normalizeLayoutState(state), arrangementHistoryLabel('applyLayoutState'), Date.now())
      if (runtime.readConstraints && hasArrangementConstraints(runtime.readConstraints())) {
        void request('constrain', undefined, false, undefined, false, next)
      } else runtime.commitState(next)
    },
    undoArrangement: () => {
      const state = runtime.readState()
      const next = undoArrangement(state)
      if (next !== state) {
        if (runtime.readConstraints && hasArrangementConstraints(runtime.readConstraints())) void request('constrain', undefined, false, undefined, false, normalizeLayoutState(next))
        else runtime.commitState(normalizeLayoutState(next))
      }
    },
    redoArrangement: () => {
      const state = runtime.readState()
      const next = redoArrangement(state)
      if (next !== state) {
        if (runtime.readConstraints && hasArrangementConstraints(runtime.readConstraints())) void request('constrain', undefined, false, undefined, false, normalizeLayoutState(next))
        else runtime.commitState(normalizeLayoutState(next))
      }
    },
    restoreArrangementHistory: (index) => {
      const state = runtime.readState()
      const next = restoreArrangementAt(state, index)
      if (next !== state) {
        if (runtime.readConstraints && hasArrangementConstraints(runtime.readConstraints())) void request('constrain', undefined, false, undefined, false, normalizeLayoutState(next))
        else runtime.commitState(normalizeLayoutState(next))
      }
    },

    createContainer: (containerId, groupId, tabIds = []) => {
      request('createContainer', { containerId, groupId, tabIds })
    },
    // A close must be durable before the pane disappears; otherwise a reload
    // immediately after clicking X restores the pane from the old saved tree.
    closeContainer: (containerId) => request('closeContainer', { containerId }, false, undefined, true),
    splitContainer: (containerId, dir, initialTab, position = 'after') => {
      request('splitContainer', { containerId, dir, position, initialTab })
    },
    focusContainer: (containerId) => request(
      'focusContainer',
      { containerId },
      false,
      (state) => state.focusedContainerId === containerId,
    ),
    unfocusContainer: () => request('unfocusContainer'),

    toggleOverlay: (containerId) => request('toggleOverlay', { containerId }, true),
    moveOverlay: (containerId, xy) => request('moveOverlay', { containerId, xy }),
    resizeOverlay: (containerId, size) => request('resizeOverlay', { containerId, size }),
    bringOverlayToFront: (containerId) => request('bringOverlayToFront', { containerId }),

    resizeSplit: (sizesPx, path) => request('resizeSplit', { sizes: sizesPx, path, sizeUnit: 'px' }),
    resizeCross: (path, index, lengthPx) => request('resizeCross', { path, index, length: lengthPx }),
    addPaneBeside: (containerId, dir, initialTab, position = 'after') => {
      const drawn = runtime.readDrawnPaneSizes?.()[containerId]
      const sizes = paneSizesNow()
      request('addPaneBeside', {
        containerId,
        dir,
        position,
        initialTab,
        lengthPx: dir === 'row' ? sizes.added_pane_width_px : sizes.added_pane_height_px,
        // The pane's own drawn length, so every pane keeps the size it has; one not drawn yet takes the added length.
        targetPx: drawn ? (dir === 'row' ? drawn.w : drawn.h) : (dir === 'row' ? sizes.added_pane_width_px : sizes.added_pane_height_px),
      })
    },

    moveFloating: (containerId, xy) => request('moveFloating', { containerId, xy }),
    resizeFloating: (containerId, size) => request('resizeFloating', { containerId, size }),
    updateFloatingRect: (containerId, rect) => request('updateFloatingRect', { containerId, rect }),
    bringFloatingToFront: (containerId) => request('bringFloatingToFront', { containerId }),
    setCamera: (camera) => request('setCamera', camera),
    createFloatingContainerWithTab: (tabId, rect) => {
      request('createFloatingContainerWithTab', { tabId, rect })
    },
    createFloatingContainerWithSurface: (tab, rect) => {
      request('createFloatingContainerWithSurface', { tab, rect })
    },

    splitContainerWithTab: (targetContainerId, dir, tabId, position = 'after') => {
      request('splitContainerWithTab', { targetContainerId, dir, position, tabId })
    },
    splitContainerWithSurface: (targetContainerId, dir, tab, position = 'after') => {
      request('splitContainerWithSurface', { targetContainerId, dir, position, tab })
    },
    swapContainers: (a, b) => request('swapContainers', { a, b }),
    moveContainerToEdge: (sourceId, targetId, dir, position = 'after') => {
      request('moveContainerToEdge', { sourceId, targetId, dir, position })
    },

    splitAtRoot: (dir, position, initialTab) => {
      request('splitAtRoot', { dir, position, initialTab })
    },
    splitRootWithTab: (dir, position, tabId) => {
      request('splitRootWithTab', { dir, position, tabId })
    },
    splitRootWithSurface: (dir, position, tab) => {
      request('splitRootWithSurface', { dir, position, tab })
    },
    moveContainerToRoot: (containerId, dir, position) => {
      request('moveContainerToRoot', { containerId, dir, position })
    },

    toggleMaximize: (containerId) => request('toggleMaximize', { containerId }),
    setSurface: (surface) => {
      const baseGeometry = baseGeometryForSurface(surface)
      // Self-describe the closed geometry; the slot reconciles on it, never on
      // the open label. Floating geometry needs the viewport for auto-arrange.
      request('setSurface', { surface, baseGeometry }, baseGeometry === 'floating')
    },
    setActiveLayer: (layerId) => request('setActiveLayer', { layerId }),
    moveContainerToLayer: (containerId, layerId, placement, position) => request('moveContainerToLayer', { containerId, layerId, ...(placement ? { placement } : {}), ...(position ? { position } : {}) }, true),
    createLayer: (name) => request('createLayer', { ...(name ? { name } : {}) }),
    reorderLayers: (layerIds) => request('reorderLayers', { layerIds }),

    flush: async () => {
      return flushOperations()
    },
    awaitDurable: async () => {
      const state = await flushOperations()
      await runtime.persistState?.(state)
      return state
    },
  }
}
