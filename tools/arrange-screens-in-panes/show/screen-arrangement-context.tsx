'use client'

import React from 'react'
import { savedRecordBasis, useBitfieldData } from '#workspace-records'
import { Container } from '../../ui/show/container'
import { Notice } from '../../ui/show/notice/Notice'
import { ScreenState } from '../../ui/show/screen-state'
import arrangementWords from '../read-data/arrangement-words.json'
import { readAccountPortalSession } from '../../account-session/read-data/read-browser-session'
import { currentLogBrowserSessionBrowserId } from '../../account-session/do-work/browser-session-browser-id'
import { mergeChromeMaps } from '../read-data/chrome-visibility'
import type { LayoutState, LayoutSurface } from '../read-data/layout-types'
import { readArrangementConstraints, hasArrangementConstraints, UNRESTRICTED_ARRANGEMENT_CONSTRAINTS } from '../read-data/arrangement-constraints'
import type { PlaceableSurfaceRecord } from '../read-data/read-published-records'
import {
  decodeLayoutState,
  saveLayoutState,
  defaultLayoutState,
  normalizeLayoutState,
  readLayoutStateChangedCells,
} from '../read-data/read-screen-arrangement'
import {
  createLayoutActions,
  type LayoutActions,
  preserveClientOwnedFields,
} from '../do-work/layout-operations'
import { readDrawnPaneSizes } from './read-drawn-pane-sizes'
import { withoutPassingWindows } from '../read-data/place-tab-in-overlay'
import { keepPlacedRowsSideBySide, type ArrangementStage } from './split-tree-constraints'
import { showChanged, showOf, showReady, useShowChange } from '../../ui/show/show-rules/show-of'
import { askScreenArrangement } from '../do-work/ask-screen-arrangement'
import {
  BROWSER_LOCAL_LAYOUT_STATE_UNAVAILABLE,
  createBrowserLocalLayoutStatePersistence,
  isBrowserLocalLayoutStatePersistence,
  keyedLayoutStatePersistence,
  readBrowserLocalLayoutState,
  readKeptLayoutValue,
  subscribeBrowserLocalLayoutState,
  type BrowserLocalLayoutStatePersistence,
  type LayoutStatePersistence,
  type EngineLayoutStatePersistence,
} from '../do-work/save-layout-state'

function stableLayoutEntryIdentity(value: unknown): string {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value) ?? 'null'
}

async function readBrowserSessionAccountRef(browserContextRef: string) {
  const session = await readAccountPortalSession({ browserId: browserContextRef, nowMs: Date.now() })
  const accountRef = session?.accountIdHash ?? session?.accountId
  return typeof accountRef === 'string' && accountRef.trim() ? accountRef.trim() : null
}

export type FrameEdge = 'left' | 'right' | 'top' | 'bottom'

/** Durable placement owner identity; never a browser-local delivery address. */
export const LayoutPersistenceIdentityContext = React.createContext<string | null>(null)

/** Drag context for container swapping / edge reflow */
export const DragContext = React.createContext<{
  draggingId: string | null
  overId: string | null
  setDraggingId: (id: string | null) => void
  setOverId: (id: string | null) => void
  commitSwap: (a: string, b: string) => void
  /** hover state for container→edge reflow (A→edge of B) */
  edgeHover?: { containerId: string; edge: FrameEdge } | null
  setEdgeHover?: (hover: { containerId: string; edge: FrameEdge } | null) => void
} | null>(null)

/** Tab drag context (blue/yellow feedback while dragging tabs) */
export const TabDragContext = React.createContext<{
  draggingTabId: string | null
  overContainerId: string | null
  setDraggingTabId: (id: string | null) => void
  setOverContainerId: (id: string | null) => void
  edgeHover: { containerId: string; edge: FrameEdge } | null
  setEdgeHover: (hover: { containerId: string; edge: FrameEdge } | null) => void
} | null>(null)

/** Optimistic pending tab-moves (for instant UX) */
export const PendingMoveContext = React.createContext<{
  pending: Record<string, { targetContainerId: string; index: number; moveId: string }>
  setPending: React.Dispatch<React.SetStateAction<Record<string, { targetContainerId: string; index: number; moveId: string }>>>
  /** Which container should show an “active” hint for a given tabId */
  activeHints: Record<string, string> // containerId -> tabId
  setActiveHints: React.Dispatch<React.SetStateAction<Record<string, string>>>
  /** Operation queue to serialize tab moves by tabId */
  opQueue?: React.MutableRefObject<Record<string, Array<() => Promise<void>>>>
} | null>(null)

export const PendingCloseContext = React.createContext<{
  tabIds: ReadonlySet<string>
  stage: (tabId: string) => void
  settle: (tabId: string) => void
} | null>(null)

/**
 * A display-only selection hint. The canonical layout row still belongs to the
 * slot; this only lets an existing panel paint before that operation reply
 * arrives. It never writes arrangement state and never derives geometry.
 */
export const PendingActivationContext = React.createContext<{
  hints: Record<string, string>
  stage: (containerId: string, tabId: string) => void
  settle: (containerId: string, tabId: string) => void
} | null>(null)

import { LayoutStateContext } from './layout-state-context'
export { LayoutStateContext } from './layout-state-context'

export const LayoutActionsContext = React.createContext<LayoutActions | null>(null)

/** The stage this arrangement's tiles are drawn on now, written by the tiled arranger as it measures, so a reply is
 *  settled against what the person sees (keepPlacedRowsSideBySide). */
export const ArrangementStageContext = React.createContext<React.MutableRefObject<ArrangementStage | null> | null>(null)

/** Every tiled tree of `next` (its own layouts and each layer's) kept side by side where the person placed a pane. */
function settleOnStage(prev: LayoutState, next: LayoutState, stage: ArrangementStage | null): LayoutState {
  const settleLayouts = (before: readonly LayoutSurface[] | undefined, after: LayoutSurface[]): LayoutSurface[] => {
    const prevRoot = before?.find(layout => layout.type === 'tiled')
    let changed = false
    const settled = after.map(layout => {
      if (layout.type !== 'tiled') return layout
      const root = keepPlacedRowsSideBySide(prevRoot?.type === 'tiled' ? prevRoot.root : null, layout.root, stage)
      if (root === layout.root) return layout
      changed = true
      return { ...layout, root }
    })
    return changed ? settled : after
  }
  const layouts = settleLayouts(prev.layouts, next.layouts)
  const layers = next.layers?.map(layer => {
    const settled = settleLayouts(prev.layers?.find(one => one.id === layer.id)?.layouts, layer.layouts)
    return settled === layer.layouts ? layer : { ...layer, layouts: settled }
  })
  const layersChanged = !!layers && layers.some((layer, index) => layer !== next.layers![index])
  if (layouts === next.layouts && !layersChanged) return next
  return { ...next, layouts, ...(layersChanged ? { layers } : {}) }
}

export const PlaceableSurfaceListAddressContext = React.createContext<string | null>(null)

/** The surfaces this viewer may open, as the arrangement resolved them (LayoutEngine owns the read). */
export const OfferedSurfacesContext = React.createContext<readonly PlaceableSurfaceRecord[]>([])

/**
 * What the host app says about its own arrangement, as DATA handed in at mount:
 * - `tabsOutsideCatalog`: 'close' when every screen the app can show is in its
 *   catalog, so a saved tab naming anything else is a screen it no longer
 *   offers and is closed; 'keep' (the default) for apps that also open
 *   self-describing screens outside the catalog.
 * - `starterLayouts`: the host's starter layouts DATA (read-data/starter-layouts.ts).
 */
export interface ArrangementHostData {
  tabsOutsideCatalog: 'close' | 'keep'
  starterLayouts: unknown
  /** Optional transient `{ complete: boolean, withdrawn?: unknown[] }`: known withdrawals close at once; otherwise
   *  absent saved rows wait for completeness. Withdrawn rows use the same catalog format as offered surfaces. */
  catalogStateAddressLabel?: string
  /** A row whose panes do not fit the stage at their usable width is drawn stacked (a screen's own arrangement on a
   *  phone); a row's own `stackBelow` still wins. */
  stackRowsThatDoNotFit?: boolean
}
export const ArrangementHostDataContext = React.createContext<ArrangementHostData>({ tabsOutsideCatalog: 'keep', starterLayouts: [] })

/**
 * Optional presentation-only allowlist for one shared placeable-surface
 * catalog. `undefined` is unrestricted; an explicit empty array offers none.
 */
export const VisiblePlaceableSurfaceIdsContext = React.createContext<readonly string[] | undefined>(undefined)

/**
 * The viewer's held capability access refs, used to scope the offerable surface
 * catalog (EmptyContainer picker + New-tab menu) to what this viewer may open.
 * `undefined` = NO capability context (the studio owner shell, which publishes no
 * viewer grants) → UNRESTRICTED: every surface is offered. An app that scopes its
 * catalog (e.g. a customer app) provides the account's held refs here and
 * the generic `offerableSurfaces` predicate narrows the catalog. The refs are
 * OPAQUE strings — the shell names no product/grant/audience vocabulary.
 */
// Drawing session state is owned by the addressed-marks package:
// see packages/addressed-marks/show/MarkSessionContext.tsx (MarkSessionProvider
// is mounted by LayoutEngine). Screen-arrangement only resolves WHICH addressed
// space is under the pointer — packages/screen-arrangement/show/mark-targets.ts.

export type LayoutOwnerProviderProps = {
  children: React.ReactNode
  initialState?: Partial<LayoutState>
  layoutEntryInput?: string | { input: string; params: Record<string, unknown> }
  placeableSurfaceListAddressLabel?: string
  visiblePlaceableSurfaceIds?: readonly string[]
  persistence?: LayoutStatePersistence
  applicationRef?: string
  acceptPersistedState?: (state: LayoutState) => boolean
  /**
   * Merge persisted user arrangement with the current fallback-derived state.
   * Generic embeddings use this when DATA owns membership while persistence owns
   * positions/order. The callback must be pure and return the persisted object
   * unchanged for a semantic no-op.
   */
  reconcilePersistedState?: (persistedState: LayoutState, fallbackState: LayoutState) => LayoutState
  /**
   * Host chrome zone visibility — layered over whatever chrome map the
   * persisted state carries, on EVERY persistence round-trip (host data wins
   * per zone). Lets an embedding surface hide chrome without that choice
   * being lost when the user's saved layout loads.
   */
  hostChrome?: Record<string, boolean>
  /** Internal resolved presentation policy, forwarded from the shared show-rule owner. */
  constraints?: ReturnType<typeof readArrangementConstraints>
}

export type LayoutOwnerProviderViewProps = Omit<LayoutOwnerProviderProps, 'layoutEntryInput'> & {
  layoutEntry: unknown
}

export function LayoutOwnerProviderView({
  children,
  initialState,
  layoutEntry,
  placeableSurfaceListAddressLabel,
  visiblePlaceableSurfaceIds,
  persistence,
  applicationRef,
  acceptPersistedState,
  reconcilePersistedState,
  hostChrome,
}: LayoutOwnerProviderViewProps) {
  useShowChange()
  const arrangementChange = showChanged('arrangement', { constraints: UNRESTRICTED_ARRANGEMENT_CONSTRAINTS })
  // The rule in force that sets the limits keys the limited view's own saved copy (keyedLayoutStatePersistence).
  const limitKey = showOf('arrangement', { constraints: UNRESTRICTED_ARRANGEMENT_CONSTRAINTS }).changes
    ?.filter(change => change.path[0] === 'constraints').at(-1)?.rule ?? null
  const constraintsValue = React.useMemo(
    () => {
      try { return { value: readArrangementConstraints(arrangementChange.constraints), error: false } }
      catch { return { value: UNRESTRICTED_ARRANGEMENT_CONSTRAINTS, error: true } }
    },
    [JSON.stringify(arrangementChange.constraints)],
  )
  const constraints = constraintsValue.value
  const latestLayoutEntryRef = React.useRef(layoutEntry)
  latestLayoutEntryRef.current = layoutEntry
  const layoutEntryIdentity = React.useMemo(
    () => stableLayoutEntryIdentity(layoutEntry),
    [layoutEntry],
  )
  const [resolvedLocalPersistence, setResolvedLocalPersistence] = React.useState<BrowserLocalLayoutStatePersistence | null | undefined>(
    persistence ? null : undefined,
  )
  // A layout store the app handed in is read at once: its saved layout is the
  // first paint, never something that waits on the engine or the account. The
  // passing windows of the page it was saved from are not part of it.
  const readSuppliedLayoutEntry = (fallback: unknown) => withoutPassingWindows(
    isBrowserLocalLayoutStatePersistence(persistence)
      ? readBrowserLocalLayoutState(persistence)?.state ?? fallback
      : fallback
  )
  const [resolvedLayoutEntry, setResolvedLayoutEntry] = React.useState<unknown>(() => readSuppliedLayoutEntry(layoutEntry))
  const scopeResolutionRef = React.useRef(0)

  React.useEffect(() => {
    const currentLayoutEntry = latestLayoutEntryRef.current
    if (persistence) {
      scopeResolutionRef.current += 1
      setResolvedLocalPersistence(null)
      setResolvedLayoutEntry(readSuppliedLayoutEntry(currentLayoutEntry))
      return
    }
    let cancelled = false
    // Whose layout this is: the browser and the account signed in to it. A
    // return to the tab re-asks, because a sign-in in another tab can change the
    // account. When the answer is the same, nothing changes. Clearing the store
    // while asking painted nothing until the reply came, and a new store with the
    // same key remounted every surface: a black screen on every return to the tab.
    let resolvedScopeKey: string | null = null
    const resolveScope = async (recheck = false) => {
      const resolution = ++scopeResolutionRef.current
      if (!recheck) setResolvedLocalPersistence(undefined)
      const normalizedApplicationRef = applicationRef?.trim()
      if (!normalizedApplicationRef) {
        if (!cancelled && resolution === scopeResolutionRef.current) {
          setResolvedLocalPersistence(null)
          setResolvedLayoutEntry(currentLayoutEntry)
        }
        return
      }
      let browserContextRef: string
      let accountRef: string
      try {
        browserContextRef = currentLogBrowserSessionBrowserId()
        accountRef = await readBrowserSessionAccountRef(browserContextRef) ?? 'anonymous'
      } catch {
        // A re-ask that fails leaves the layout the person is already using.
        if (cancelled || resolution !== scopeResolutionRef.current || recheck) return
        setResolvedLocalPersistence(null)
        setResolvedLayoutEntry(currentLayoutEntry)
        return
      }
      if (cancelled || resolution !== scopeResolutionRef.current) return
      const scopeKey = JSON.stringify([normalizedApplicationRef, browserContextRef, accountRef])
      if (recheck && scopeKey === resolvedScopeKey) return
      resolvedScopeKey = scopeKey
      // The writer ref and the write clock are supplied HERE, by the surface, and
      // not inside the persistence module. That module is reachable from the
      // layout-state contribution derivation, where a clock or a generator breaks
      // replay. A surface's clock and entropy are inputs the log records, exactly
      // like a date the user typed, so this is the layer entitled to read them.
      const adapter = createBrowserLocalLayoutStatePersistence({
        applicationRef: normalizedApplicationRef,
        browserContextRef,
        accountRef,
      }, {
        writerRef: `writer:${globalThis.crypto.randomUUID()}`,
        readWriteTimeMs: () => Date.now(),
      })
      setResolvedLocalPersistence(adapter)
      setResolvedLayoutEntry(
        adapter
          ? readBrowserLocalLayoutState(adapter)?.state ?? currentLayoutEntry
          : currentLayoutEntry,
      )
    }
    void resolveScope()
    const recheck = () => { void resolveScope(true) }
    const recheckVisible = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    globalThis.addEventListener?.('focus', recheck)
    globalThis.addEventListener?.('pageshow', recheck)
    document.addEventListener?.('visibilitychange', recheckVisible)
    return () => {
      cancelled = true
      scopeResolutionRef.current += 1
      globalThis.removeEventListener?.('focus', recheck)
      globalThis.removeEventListener?.('pageshow', recheck)
      document.removeEventListener?.('visibilitychange', recheckVisible)
    }
  }, [applicationRef, layoutEntryIdentity, persistence])

  if (!persistence && resolvedLocalPersistence === undefined) return null

  const effectivePersistence = persistence
    ?? resolvedLocalPersistence
    ?? BROWSER_LOCAL_LAYOUT_STATE_UNAVAILABLE
  const persistenceIdentity = isBrowserLocalLayoutStatePersistence(effectivePersistence)
    ? effectivePersistence.storageKey
    : effectivePersistence.mode === 'browser-local-unavailable'
      ? null
      : JSON.stringify([effectivePersistence.addressMode ?? 'label_hash', effectivePersistence.valueAddressLabel])
  return (
    <LayoutPersistenceIdentityContext.Provider value={persistenceIdentity}>
    <LayoutOwnerProviderState
      key={persistenceIdentity}
      children={children}
      initialState={initialState}
      layoutEntry={persistence && !isBrowserLocalLayoutStatePersistence(persistence) ? layoutEntry : resolvedLayoutEntry}
      placeableSurfaceListAddressLabel={placeableSurfaceListAddressLabel}
      visiblePlaceableSurfaceIds={visiblePlaceableSurfaceIds}
      persistence={effectivePersistence}
      acceptPersistedState={acceptPersistedState}
      reconcilePersistedState={reconcilePersistedState}
      hostChrome={hostChrome}
      constraints={constraints}
      constraintsInvalid={constraintsValue.error}
      limitKey={limitKey}
    />
    </LayoutPersistenceIdentityContext.Provider>
  )
}

function LayoutOwnerProviderState({
  children,
  initialState,
  layoutEntry,
  placeableSurfaceListAddressLabel,
  visiblePlaceableSurfaceIds,
  persistence,
  acceptPersistedState,
  reconcilePersistedState,
  hostChrome,
  constraints = UNRESTRICTED_ARRANGEMENT_CONSTRAINTS,
  constraintsInvalid = false,
  limitKey = null,
}: LayoutOwnerProviderViewProps & { constraints?: ReturnType<typeof readArrangementConstraints>; constraintsInvalid?: boolean; limitKey?: string | null }) {
  const [observedLayoutEntry, setObservedLayoutEntry] = React.useState(layoutEntry)
  const effectiveLayoutEntry = isBrowserLocalLayoutStatePersistence(persistence)
    ? observedLayoutEntry
    : layoutEntry
  const fallbackState = React.useMemo(
    () => normalizeLayoutState(initialState ?? defaultLayoutState()),
    [initialState],
  )
  const fallbackSerialized = React.useMemo(
    () => JSON.stringify(fallbackState),
    [fallbackState],
  )
  const acceptedPersistedState = React.useMemo(() => {
    const decodedState = decodeLayoutState(effectiveLayoutEntry, fallbackState)
    return acceptPersistedState?.(decodedState) === false
      ? fallbackState
      : decodedState
  }, [acceptPersistedState, effectiveLayoutEntry, fallbackState])
  const persistedState = React.useMemo(() => {
    return reconcilePersistedState
      ? reconcilePersistedState(acceptedPersistedState, fallbackState)
      : acceptedPersistedState
  }, [acceptedPersistedState, fallbackState, reconcilePersistedState])
  const acceptedPersistedSerialized = React.useMemo(
    () => JSON.stringify(acceptedPersistedState),
    [acceptedPersistedState],
  )
  const persistedSerialized = React.useMemo(() => JSON.stringify(persistedState), [persistedState])
  const policySourceKey = React.useMemo(
    () => JSON.stringify([hasArrangementConstraints(constraints) ? constraints : null,
      hasArrangementConstraints(constraints) ? persistedSerialized : null, constraintsInvalid, limitKey]),
    [constraints, persistedSerialized, constraintsInvalid, limitKey],
  )
  const previousPolicyActiveRef = React.useRef(false)
  const [policyProjectionReadyKey, setPolicyProjectionReadyKey] = React.useState<string | null>(null)
  const [policyProjectionFailed, setPolicyProjectionFailed] = React.useState(false)
  const [policyProjectionAttempt, setPolicyProjectionAttempt] = React.useState(0)
  const policySourceKeyRef = React.useRef(policySourceKey)
  policySourceKeyRef.current = policySourceKey
  const [localState, setLocalState] = React.useState<LayoutState>(persistedState)
  const constraintsRef = React.useRef(constraints)
  constraintsRef.current = constraints
  const constraintsInvalidRef = React.useRef(constraintsInvalid)
  constraintsInvalidRef.current = constraintsInvalid
  const [pendingCloseTabIds, setPendingCloseTabIds] = React.useState<Set<string>>(() => new Set())
  const [pendingActivationHints, setPendingActivationHints] = React.useState<Record<string, string>>({})
  const pendingClose = React.useMemo(() => ({
    tabIds: pendingCloseTabIds as ReadonlySet<string>,
    stage: (tabId: string) => setPendingCloseTabIds((current) => new Set(current).add(tabId)),
    settle: (tabId: string) => setPendingCloseTabIds((current) => {
      if (!current.has(tabId)) return current
      const next = new Set(current)
      next.delete(tabId)
      return next
    }),
  }), [pendingCloseTabIds])
  const pendingActivation = React.useMemo(() => ({
    hints: pendingActivationHints,
    stage: (containerId: string, tabId: string) => {
      setPendingActivationHints((current) => (
        current[containerId] === tabId ? current : { ...current, [containerId]: tabId }
      ))
    },
    settle: (containerId: string, tabId: string) => {
      setPendingActivationHints((current) => {
        if (current[containerId] !== tabId) return current
        const next = { ...current }
        delete next[containerId]
        return next
      })
    },
  }), [pendingActivationHints])
  const actionsRef = React.useRef<LayoutActions | null>(null)
  const stateCursorRef = React.useRef<LayoutState>(persistedState)
  const acceptedPersistedSerializedRef = React.useRef(persistedSerialized)
  const acceptedFallbackSerializedRef = React.useRef(fallbackSerialized)
  const pendingSerializedRef = React.useRef<string | null>(null)
  const pendingChangedCellsRef = React.useRef<Set<string> | null>(null)
  const pendingFullSaveRef = React.useRef(false)
  const saveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // All canonical writes, immediate or debounced, share one recoverable tail.
  // A failed write is surfaced to its waiter but never poisons a later save.
  const persistenceTailRef = React.useRef<Promise<void>>(Promise.resolve())
  const repairedPersistedInputRef = React.useRef<string | null>(null)
  // What this page last read of the record it saves to (the identity every save from this copy expects), so a drag made
  // from an older copy is refused by the store instead of replacing a newer arrangement. Only the person's store has
  // one; a browser-held layout has nothing to compare.
  const keptLabel = isBrowserLocalLayoutStatePersistence(persistence) || persistence.mode === 'browser-local-unavailable'
    ? null
    : (persistence as EngineLayoutStatePersistence).valueAddressLabel
  const basisRef = React.useRef<string | null | undefined>(keptLabel === null ? undefined : savedRecordBasis(keptLabel))
  const [refusedCount, setRefusedCount] = React.useState(0)
  const [refusalShown, setRefusalShown] = React.useState(false)

  const takePendingPublication = React.useCallback(() => {
    const publication = pendingFullSaveRef.current
      ? { mode: 'full' }
      : pendingChangedCellsRef.current
        ? { mode: 'delta', delta: { changedCells: [...pendingChangedCellsRef.current] } }
        : { mode: 'noop' }
    pendingChangedCellsRef.current = null
    pendingFullSaveRef.current = false
    return publication
  }, [])

  const enqueuePersistence = React.useCallback((state: LayoutState, publication: unknown): Promise<void> => {
    const write = persistenceTailRef.current.catch(() => undefined).then(async () => {
      const saved = await saveLayoutState(state, publication, persistence, basisRef.current)
      if (saved.refused) {
        // Nothing was replaced: drop the drag, show what is kept (the store already told this page), say so plainly.
        pendingSerializedRef.current = null
        pendingChangedCellsRef.current = null
        pendingFullSaveRef.current = false
        if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
        if (keptLabel !== null) basisRef.current = savedRecordBasis(keptLabel)
        setRefusalShown(true)
        setRefusedCount((count) => count + 1)
      } else if (saved.identity !== null) basisRef.current = saved.identity
      if (isBrowserLocalLayoutStatePersistence(persistence)) {
        const stored = readBrowserLocalLayoutState(persistence)
        if (stored) setObservedLayoutEntry(stored.state)
      }
    })
    persistenceTailRef.current = write.catch(() => undefined)
    return write
  }, [persistence, keptLabel])

  // While a limit is in force the page saves the limited view to its own keyed copy of the same record, through the
  // same save and the same write tail, so the full arrangement stays exactly as it was and a reload under the limit
  // comes back to the screen that was open.
  const limitedPersistence = React.useMemo(
    () => (limitKey ? keyedLayoutStatePersistence(persistence, limitKey) : null),
    [persistence, limitKey],
  )
  const limitedPersistenceRef = React.useRef(limitedPersistence)
  limitedPersistenceRef.current = limitedPersistence
  const limitedSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveLimited = React.useCallback((state: LayoutState): Promise<void> => {
    const target = limitedPersistenceRef.current
    if (!target) return Promise.resolve()
    const write = persistenceTailRef.current.catch(() => undefined).then(async () => {
      await saveLayoutState(state, { mode: 'full' }, target)
    })
    persistenceTailRef.current = write.catch(() => undefined)
    return write
  }, [])

  // A temporary presentation limit is projected by the same Rust slot that
  // owns every later transition. Keep the accepted record untouched, and do
  // not run the ordinary stale-layout read-repair while this projection is in
  // force. Removing the rule reselects the saved copy on the next render.
  React.useEffect(() => {
    const policyActive = hasArrangementConstraints(constraints) || constraintsInvalid
    const wasActive = previousPolicyActiveRef.current
    previousPolicyActiveRef.current = policyActive
    if (!policyActive && !wasActive) {
      setPolicyProjectionReadyKey(policySourceKey)
      return
    }
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    if (limitedSaveTimerRef.current) { clearTimeout(limitedSaveTimerRef.current); limitedSaveTimerRef.current = null }
    let current = true
    setPolicyProjectionReadyKey(null)
    setPolicyProjectionFailed(false)
    if (constraintsInvalid) {
      setPolicyProjectionFailed(true)
      return () => { current = false }
    }
    if (!hasArrangementConstraints(constraints)) {
      stateCursorRef.current = persistedState
      setLocalState(persistedState)
      setPolicyProjectionReadyKey(policySourceKey)
      return () => { current = false }
    }
    // The limited view starts from its own kept copy when there is one (where the person was), else from the full
    // saved arrangement; either way the slot projects it under the limits.
    const limited = limitedPersistenceRef.current
    void (limited ? readKeptLayoutValue(limited) : Promise.resolve(null)).then(async kept => {
      const source = kept === null ? persistedState : decodeLayoutState(kept, persistedState)
      return { source, reply: await askScreenArrangement({ state: source, operation: 'constrain', constraints }) }
    }).then(({ source, reply }) => {
      if (!current || policySourceKeyRef.current !== policySourceKey) return
      const projected = preserveClientOwnedFields(source, reply.state)
      stateCursorRef.current = projected
      setLocalState(projected)
      setPolicyProjectionReadyKey(policySourceKey)
    }).catch(error => {
      if (!current || policySourceKeyRef.current !== policySourceKey) return
      setPolicyProjectionFailed(true)
      // Fail closed: a limit whose projection did not run must not reveal the
      // unconstrained saved arrangement.
    })
    return () => { current = false }
  // Equivalent decoded records can be new objects on every record notification.
    // Restart only when the actual policy or saved arrangement changes.
  }, [policyProjectionAttempt, policySourceKey])

  React.useEffect(() => {
    if (!isBrowserLocalLayoutStatePersistence(persistence)) return
    return subscribeBrowserLocalLayoutState(persistence, (record) => {
      const hasUnflushedLocalWrite =
        pendingSerializedRef.current !== null
        || pendingChangedCellsRef.current !== null
        || pendingFullSaveRef.current
        || saveTimerRef.current !== null
      if (hasUnflushedLocalWrite || !record) return
      setObservedLayoutEntry(record.state)
    })
  }, [persistence])

  const persistBarrierState = React.useCallback(async (state: LayoutState): Promise<void> => {
    if (constraintsInvalidRef.current) return
    if (hasArrangementConstraints(constraintsRef.current)) {
      if (limitedSaveTimerRef.current) { clearTimeout(limitedSaveTimerRef.current); limitedSaveTimerRef.current = null }
      await saveLimited(state)
      return
    }
    const snapshot = JSON.stringify(state)
    if (JSON.stringify(stateCursorRef.current) === snapshot) {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      await enqueuePersistence(state, takePendingPublication())
      return
    }
    // A later local edit is already pending. Preserve it for its own ordered
    // write; this exact snapshot still joins the same canonical write tail.
    await enqueuePersistence(state, { mode: 'full' })
  }, [enqueuePersistence, saveLimited, takePendingPublication])

  const scheduleLimitedSave = React.useCallback(() => {
    if (limitedSaveTimerRef.current) clearTimeout(limitedSaveTimerRef.current)
    limitedSaveTimerRef.current = setTimeout(() => {
      limitedSaveTimerRef.current = null
      void saveLimited(stateCursorRef.current).catch((error) => console.error('screen-arrangement persistence failed', error))
    }, 300)
  }, [saveLimited])

  const scheduleSave = React.useCallback((nextState: LayoutState, publication?: unknown) => {
    pendingSerializedRef.current = JSON.stringify(nextState)
    const changedCells = readLayoutStateChangedCells(publication)
    if (changedCells === null) {
      pendingFullSaveRef.current = true
      pendingChangedCellsRef.current = null
    } else if (!pendingFullSaveRef.current && changedCells.length > 0) {
      const pendingChangedCells = pendingChangedCellsRef.current ?? new Set<string>()
      for (const cell of changedCells) pendingChangedCells.add(cell)
      pendingChangedCellsRef.current = pendingChangedCells
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null
      void enqueuePersistence(stateCursorRef.current, takePendingPublication())
        .catch((error) => console.error('screen-arrangement persistence failed', error))
    }, 300)
  }, [enqueuePersistence, takePendingPublication])

  // Reconciliation is a read-repair: once stale or retired tabs have been
  // removed from the restored state, persist that repaired state so the next
  // close/reopen cannot revive them from the old saved layout.
  React.useEffect(() => {
    if (constraintsInvalid || hasArrangementConstraints(constraints) || !reconcilePersistedState || acceptedPersistedSerialized === persistedSerialized) return
    if (repairedPersistedInputRef.current === acceptedPersistedSerialized) return

    repairedPersistedInputRef.current = acceptedPersistedSerialized
    void enqueuePersistence(persistedState, { mode: 'full' }).catch((error) => {
      if (repairedPersistedInputRef.current === acceptedPersistedSerialized) {
        repairedPersistedInputRef.current = null
      }
      console.error('screen-arrangement restore cleanup failed', error)
    })
  }, [acceptedPersistedSerialized, constraints, constraintsInvalid, enqueuePersistence, persistedSerialized, persistedState, reconcilePersistedState])

  React.useEffect(() => {
    if (constraintsInvalid || hasArrangementConstraints(constraints)) return
    const previousAccepted = acceptedPersistedSerializedRef.current
    if (persistedSerialized === previousAccepted) return

    const localSerialized = JSON.stringify(stateCursorRef.current)
    const hasUnflushedLocalWrite =
      pendingSerializedRef.current !== null
      || pendingChangedCellsRef.current !== null
      || pendingFullSaveRef.current
      || saveTimerRef.current !== null

    acceptedPersistedSerializedRef.current = persistedSerialized
    if (hasUnflushedLocalWrite || localSerialized !== previousAccepted) return

    stateCursorRef.current = persistedState
    setLocalState(persistedState)
  }, [constraints, constraintsInvalid, persistedSerialized, persistedState])

  const stageRef = React.useRef<ArrangementStage | null>(null)
  if (!actionsRef.current) {
    actionsRef.current = createLayoutActions({
      readState: () => stateCursorRef.current,
      commitState: (nextState, publication, alreadyDurable) => {
        if (nextState === stateCursorRef.current) return
        stateCursorRef.current = nextState
        setLocalState(nextState)
        if (alreadyDurable || constraintsInvalidRef.current) return
        if (hasArrangementConstraints(constraintsRef.current)) scheduleLimitedSave()
        else scheduleSave(nextState, publication)
      },
      reportError: (error) => {
        console.error('screen-arrangement request failed', error)
      },
      persistState: persistBarrierState,
      readDrawnPaneSizes,
      settleReply: (prev, next) => settleOnStage(prev, next, stageRef.current),
      readConstraints: () => {
        if (constraintsInvalidRef.current) throw new Error('The current viewing limits could not be read.')
        return constraintsRef.current
      },
    })
  }

  React.useEffect(() => {
    if (
      constraintsInvalid || hasArrangementConstraints(constraints)
      || !reconcilePersistedState
      || fallbackSerialized === acceptedFallbackSerializedRef.current
    ) return

    acceptedFallbackSerializedRef.current = fallbackSerialized
    const reconciledLocalState = reconcilePersistedState(
      stateCursorRef.current,
      fallbackState,
    )
    const reconciledSerialized = JSON.stringify(reconciledLocalState)
    if (reconciledSerialized === JSON.stringify(stateCursorRef.current)) return

    stateCursorRef.current = reconciledLocalState
    setLocalState(reconciledLocalState)
    if (pendingSerializedRef.current !== null) {
      pendingSerializedRef.current = reconciledSerialized
    }
  }, [constraints, constraintsInvalid, fallbackSerialized, fallbackState, reconcilePersistedState])

  React.useEffect(() => {
    if (constraintsInvalid || hasArrangementConstraints(constraints)) return
    const pendingSerialized = pendingSerializedRef.current
    if (pendingSerialized && pendingSerialized !== persistedSerialized) return
    pendingSerializedRef.current = null
    pendingChangedCellsRef.current = null
    pendingFullSaveRef.current = false
    stateCursorRef.current = persistedState
    setLocalState(persistedState)
    if (keptLabel !== null) basisRef.current = savedRecordBasis(keptLabel)
  }, [constraints, constraintsInvalid, persistedSerialized, persistedState, refusedCount, keptLabel])

  React.useEffect(() => {
    if (!refusalShown) return
    const timer = setTimeout(() => setRefusalShown(false), arrangementWords.seconds_shown * 1000)
    return () => clearTimeout(timer)
  }, [refusalShown])

  React.useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      pendingChangedCellsRef.current = null
      pendingFullSaveRef.current = false
    }
  }, [])

  // Host chrome layers over the published state at the single point where
  // state leaves the provider. Every state origin — persisted load, engine
  // operation replies, optimistic commits — flows through here, so the host's
  // chrome choice cannot be dropped by any state round-trip.
  const publishedState = React.useMemo<LayoutState>(() => {
    if (!hostChrome) return localState
    return { ...localState, chrome: mergeChromeMaps(localState.chrome, hostChrome) }
  }, [hostChrome, localState])

  const presentationReady = !policyProjectionFailed && showReady() && policyProjectionReadyKey === policySourceKey

  return (
    <LayoutStateContext.Provider value={publishedState}>
      <LayoutActionsContext.Provider value={actionsRef.current}>
        <ArrangementStageContext.Provider value={stageRef}>
        <PendingCloseContext.Provider value={pendingClose}>
          <PendingActivationContext.Provider value={pendingActivation}>
            <PlaceableSurfaceListAddressContext.Provider value={placeableSurfaceListAddressLabel ?? null}>
              <VisiblePlaceableSurfaceIdsContext.Provider value={visiblePlaceableSurfaceIds}>
                <Container hidden={!presentationReady} layout="vertical" padding="none" width="full" height="full" minHeight="0" minWidth="0">
                  {children}
                </Container>
                {policyProjectionFailed ? <ScreenState state={{ status: 'failed', title: 'Your arrangement could not be shown', description: 'The current viewing limits could not be applied. Your saved arrangement is still here.', retry: { label: 'Try again', run: () => { setPolicyProjectionAttempt(value => value + 1) } } }} /> : null}
                <Notice text={refusalShown ? arrangementWords.stale : null} tone="error" placement="top-center" />
              </VisiblePlaceableSurfaceIdsContext.Provider>
            </PlaceableSurfaceListAddressContext.Provider>
          </PendingActivationContext.Provider>
        </PendingCloseContext.Provider>
        </ArrangementStageContext.Provider>
      </LayoutActionsContext.Provider>
    </LayoutStateContext.Provider>
  )
}

export function LayoutOwnerProvider({ layoutEntryInput = 'layout-state', ...props }: LayoutOwnerProviderProps) {
  const layoutEntry = useBitfieldData(layoutEntryInput)
  return <LayoutOwnerProviderView {...props} layoutEntry={layoutEntry} />
}
