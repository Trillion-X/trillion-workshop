// packages/screen-arrangement/do-work/execute-open-intent.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Blind executor for OPEN-INTENT rows (plan A12/A13). Takes a decoded
// OpenIntentRow (read-data/read-open-intents.ts) plus the folder/selection
// member set it was invoked against, and places the resulting surface tabs
// using the SAME already-known, stable containerId the picker itself is
// showing in — never a synchronously-unknowable new container id.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Index 0 of the resolved tab list ALWAYS replaces the picker's own empty
//    tab in place (the exact idiom show/EmptyContainer.tsx already uses for a
//    single "Open" click via addSurfaceTab(containerId, tabWithId(tab, activeTabId))).
//    This is uniform across every strategy — the strategy map below only
//    handles indices 1..N-1.
// 2. Adding a new strategy id is a Physics-level composition-primitive change
//    (same closed-vocabulary shape as arrangement.strategy itself — see
//    read-data/read-open-intents.ts invariant 3). Every field a strategy
//    consumes beyond its own name (dims, spacing, dir, zoom, columns...) is
//    open `params` DATA — the strategy function never hardcodes a value that
//    should be a param.
// 3. Unknown strategy id, or zero resolved tabs, fails CLOSED — no partial
//    open, no silent no-op success. Callers get `false` back.
// 4. Preset persistence reuses the EXISTING saveArrangementAsGroup primitive
//    via LayoutActions.flush() — zero new persistence code (L100).
// 5. The whole open is ONE applySequence request: index 0 plus every strategy
//    operation fold through the slot's single-op reducer in order, so the
//    person sees the finished arrangement at once, never a pane at a time.
//
// =============================================================================

import type { ArrangementOperation, LayoutActions, LayoutState } from './layout-operations'
import type { TabMeta } from '../read-data/layout-types'
import type { OpenIntentRow } from '../read-data/read-open-intents'
import { saveArrangementAsGroup } from './save-arrangement-as-group'
import { tabForPlaceableSurface, tabWithId } from '../show/placeable-surface-tab'
import { baseGeometryForSurface } from '../read-data/surface-modes'

export interface PlaceableMember {
  id: string
  /** Whatever surface descriptor tabForPlaceableSurface(...) accepts — target/packageEntry/materialTarget. */
  surface: Parameters<typeof tabForPlaceableSurface>[0]
}

interface Rect { x: number; y: number; w: number; h: number }

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const raw = params[key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

function floatingRect(index: number, params: Record<string, unknown>): Rect {
  const w = numberParam(params, 'width', 480)
  const h = numberParam(params, 'height', 360)
  const originX = numberParam(params, 'originX', 80)
  const originY = numberParam(params, 'originY', 80)
  const cascade = numberParam(params, 'cascade', 32)
  return { x: originX + index * cascade, y: originY + index * cascade, w, h }
}

function gridRect(index: number, params: Record<string, unknown>): Rect {
  const columns = Math.max(1, numberParam(params, 'columns', 3))
  const w = numberParam(params, 'width', 420)
  const h = numberParam(params, 'height', 320)
  const spacing = numberParam(params, 'spacing', 24)
  const col = index % columns
  const row = Math.floor(index / columns)
  return { x: col * (w + spacing), y: row * (h + spacing), w, h }
}

/**
 * Closed set of composition primitives. Each fn returns the operations that
 * place `tabs` (already index-0-excluded by the caller) relative to the stable
 * `containerId`; the caller sends them with index 0 as one applySequence.
 * New strategy = new named Physics primitive here, mirrored by an
 * `arrangement.strategy` value in DATA — never a per-option code branch.
 */
const OPEN_INTENT_STRATEGIES: Record<
  string,
  (containerId: string, tabs: TabMeta[], params: Record<string, unknown>) => ArrangementOperation[]
> = {
  'tabs-one-container': (containerId, tabs) => tabs.map((tab) => ({
    operation: 'addSurfaceTab',
    payload: { containerId, tab },
  })),
  'split-each': (containerId, tabs, params) => {
    const dir = params.dir === 'column' ? 'column' : 'row'
    return tabs.map((tab) => ({
      operation: 'splitContainerWithSurface',
      payload: { targetContainerId: containerId, dir, position: 'after', tab },
    }))
  },
  grid: (containerId, tabs, params) => {
    const alternate = params.alternate !== false
    const fixedDir = params.dir === 'column' ? 'column' : 'row'
    return tabs.map((tab, i) => ({
      operation: 'splitContainerWithSurface',
      payload: { targetContainerId: containerId, dir: alternate ? (i % 2 === 0 ? 'row' : 'column') : fixedDir, position: 'after', tab },
    }))
  },
  floating: (_containerId, tabs, params) => tabs.map((tab, i) => ({
    operation: 'createFloatingContainerWithSurface',
    payload: { tab, rect: floatingRect(i + 1, params) },
  })),
  canvas: (_containerId, tabs, params) => {
    const operations: ArrangementOperation[] = [{
      operation: 'setSurface',
      payload: { surface: 'canvas', baseGeometry: baseGeometryForSurface('canvas') },
    }]
    operations.push(...tabs.map((tab, i) => ({
      operation: 'createFloatingContainerWithSurface',
      payload: { tab, rect: gridRect(i + 1, params) },
    })))
    if (params.fitCamera !== false) {
      operations.push({ operation: 'setCamera', payload: { scale: typeof params.zoom === 'number' ? params.zoom : 1 } })
    }
    return operations
  },
}

export interface ExecuteOpenIntentArgs {
  actions: LayoutActions
  /** The stable container the picker is currently showing in. */
  containerId: string
  /** The picker's own empty tab id, if known — index 0 replaces it in place. */
  emptyTabId?: string | null
  intent: OpenIntentRow
  /** All members available in the folder/context the intent was invoked from. */
  members: PlaceableMember[]
  /** Ids the user has multi-selected, if any — consulted only when intent.scope === 'selected'. */
  selectedIds: ReadonlySet<string>
}

/** Resolve which members an intent acts on, per its own `scope` field. */
function resolveMembers(args: ExecuteOpenIntentArgs): PlaceableMember[] {
  if (args.intent.scope === 'selected') {
    return args.members.filter((m) => args.selectedIds.has(m.id))
  }
  return args.members
}

async function persistAsPreset(actions: LayoutActions, presetId: string, name: string): Promise<void> {
  const settled: LayoutState = await actions.flush()
  await saveArrangementAsGroup(presetId, name, settled)
}

/**
 * Apply one open-intent row. Returns false (no-op) on an unknown strategy or
 * an empty resolved member set — never a partial open.
 */
export function executeOpenIntent(args: ExecuteOpenIntentArgs): boolean {
  const resolved = resolveMembers(args)
  if (resolved.length === 0) return false

  const strategy = OPEN_INTENT_STRATEGIES[args.intent.strategy]
  if (!strategy) return false

  const tabs = resolved.map((m) => tabForPlaceableSurface(m.surface))
  const [first, ...rest] = tabs

  // The whole arrangement is one ordered request, so the screens appear at once instead of one step at a time.
  args.actions.applySequence([
    { operation: 'addSurfaceTab', payload: { containerId: args.containerId, tab: args.emptyTabId ? tabWithId(first, args.emptyTabId) : first } },
    ...strategy(args.containerId, rest, args.intent.params),
  ])

  if (args.intent.target.kind === 'preset' && args.intent.target.presetId) {
    void persistAsPreset(args.actions, args.intent.target.presetId, args.intent.target.presetName ?? args.intent.target.presetId)
  }

  return true
}
