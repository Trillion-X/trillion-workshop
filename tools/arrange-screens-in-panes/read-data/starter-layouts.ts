// packages/screen-arrangement/read-data/starter-layouts.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Starter layouts: arrangements every person has from their first visit, so the
// Layouts menu is never empty and shows what an arrangement can hold. Each
// starter is DATA the host app supplies (its own surface ids, names and icons);
// this module decodes that DATA and builds the LayoutState it describes from the
// surfaces the viewer is offered.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Blind: no surface, screen or app is named here. A starter names surfaces by
//    their catalog id; which ones exist is the catalog's answer.
// 2. A pane is built only from surfaces this viewer is offered. A pane with none
//    is left out, a split left with one child becomes that child, and a starter
//    with no pane left is not offered at all.
// 3. The result is an ordinary LayoutState, applied through the same owner
//    action as a saved layout; nothing here writes.
// 4. starterArrangementOf is the way back: the arrangement on screen as the
//    same starter shape, so whoever reads it (a person's AI) changes DATA it
//    can hand straight back to readStarterLayouts.
// 5. A pane may hold one thing, not only a screen: an entry { id, input, title? }
//    opens the screen `id` on that input (one list, one decision), as a tab
//    opened with its own input is held (surfaceInputBinding 'invocation'), and
//    such a tab reads back as the same entry.
// 6. A starter can be a template over one record: an input value { from: 'record', key } is the record's value
//    under `key` (starterFilledFrom). An entry whose record value is missing is left out, as an entry naming a
//    screen this viewer is not offered is, so a page declares the screens its kind of record opens and each record
//    gets the ones it has the things for.
//
// =============================================================================

import type { LayoutState, SplitTreeNode, TabMeta } from './layout-types'
import type { PlaceableSurfaceRecord } from './read-published-records'
import { normalizeLayoutState } from './read-screen-arrangement'
import { tabForPlaceableSurface } from '../show/placeable-surface-tab'
import { KEPT_KEY } from '../../ui/show/placement-kept/placement-kept'

/** One thing a pane opens: a screen on the input it is given (one list, one decision), titled `title` when given. */
export interface StarterThing {
  id: string
  input: Record<string, unknown>
  title?: string
}

/** A pane entry: a screen by its catalog id, or one thing a screen shows. */
export type StarterSurface = string | StarterThing

/** The catalog id of the screen a pane entry opens. */
export const starterSurfaceId = (entry: StarterSurface): string => (typeof entry === 'string' ? entry : entry.id)

/** One pane of a starter: the surfaces it opens as tabs, the first one showing unless `show` names another. */
export interface StarterPane {
  kind: 'pane'
  surfaces: StarterSurface[]
  show?: string
}

/**
 * Children side by side (`row`) or stacked (`column`), with optional sizes: relative by default, or each pane's own
 * length in pixels with `unit: 'px'` (`keep: true` keeps those lengths exactly and lets the arrangement scroll instead
 * of fitting them to the window). `across` gives a pane its own length across the split (its height in a row, its
 * width in a stack) in pixels; null fills.
 */
export interface StarterSplit {
  kind: 'split'
  dir: 'row' | 'column'
  sizes?: number[]
  unit?: 'px'
  keep?: true
  across?: (number | null)[]
  /** Stack the children when the split is drawn narrower than this many pixels (SplitNode.stackBelow). */
  stack?: number
  children: StarterNode[]
}

export type StarterNode = StarterPane | StarterSplit

export interface StarterLayout {
  id: string
  name: string
  icon?: string
  arrangement: StarterNode
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readSurface(value: unknown): StarterSurface | null {
  if (!isRecord(value)) return readText(value)
  const id = readText(value.id)
  if (!id || !isRecord(value.input)) return null
  const title = readText(value.title)
  return { id, input: value.input, ...(title ? { title } : {}) }
}

function readNode(value: unknown): StarterNode | null {
  if (!isRecord(value)) return null
  if (value.kind === 'pane') {
    const surfaces = Array.isArray(value.surfaces) ? value.surfaces.map(readSurface).filter((entry): entry is StarterSurface => !!entry) : []
    const show = readText(value.show)
    return surfaces.length ? { kind: 'pane', surfaces, ...(show ? { show } : {}) } : null
  }
  if (value.kind === 'split' && (value.dir === 'row' || value.dir === 'column')) {
    const children = Array.isArray(value.children) ? value.children.map(readNode).filter((node): node is StarterNode => !!node) : []
    const positive = (size: unknown): size is number => typeof size === 'number' && Number.isFinite(size) && size > 0
    // A pixel length of 0 draws that pane at its content's height (SplitNode sizes).
    const fitsOrPositive = (size: unknown): size is number => positive(size) || (value.unit === 'px' && size === 0)
    const sizes = Array.isArray(value.sizes) && value.sizes.length === children.length && value.sizes.every(fitsOrPositive)
      ? value.sizes as number[]
      : undefined
    const pixels = !!sizes && value.unit === 'px'
    const across = Array.isArray(value.across) && value.across.length === children.length
      && value.across.every((length) => length === null || positive(length)) && value.across.some(positive)
      ? value.across as (number | null)[]
      : undefined
    return children.length ? {
      kind: 'split',
      dir: value.dir,
      ...(sizes ? { sizes } : {}),
      ...(pixels ? { unit: 'px' as const } : {}),
      ...(pixels && value.keep === true ? { keep: true as const } : {}),
      ...(across ? { across } : {}),
      ...(positive(value.stack) ? { stack: value.stack } : {}),
      children,
    } : null
  }
  return null
}

/** Decodes the host's starter DATA; a row that is not a well-formed starter is skipped. */
export function readStarterLayouts(raw: unknown): StarterLayout[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row) => {
    if (!isRecord(row)) return []
    const id = readText(row.id)
    const name = readText(row.name)
    const arrangement = readNode(row.arrangement)
    if (!id || !name || !arrangement) return []
    const icon = readText(row.icon)
    return [{ id, name, ...(icon ? { icon } : {}), arrangement }]
  })
}

/**
 * The LayoutState a starter describes, built from the surfaces this viewer is
 * offered, or null when none of its surfaces are offered.
 */
export function starterLayoutState(
  starter: StarterLayout,
  surfaces: readonly PlaceableSurfaceRecord[],
): LayoutState | null {
  const offered = new Map(surfaces.filter((surface) => !surface.disabled).map((surface) => [surface.id, surface]))
  const containers: LayoutState['containers'] = {}
  const tabGroups: LayoutState['tabGroups'] = {}
  const tabs: Record<string, TabMeta> = {}
  let firstContainerId: string | null = null

  const build = (node: StarterNode, path: string): SplitTreeNode | null => {
    if (node.kind === 'pane') {
      const paneTabs = node.surfaces.flatMap((entry) => {
        const surfaceId = starterSurfaceId(entry)
        const surface = offered.get(surfaceId)
        if (!surface) return []
        if (typeof entry === 'string') return [{ surfaceId, tab: tabForPlaceableSurface(surface) }]
        const tab = tabForPlaceableSurface({ ...surface, ...(entry.title ? { label: entry.title } : {}), surfaceInput: { ...(surface.surfaceInput ?? {}), ...entry.input } })
        return [{ surfaceId, tab: { ...tab, metadata: { ...tab.metadata, surfaceInputBinding: 'invocation' } } }]
      })
      if (!paneTabs.length) return null
      const containerId = `${starter.id}-pane${path}`
      const groupId = `${containerId}-tabs`
      for (const { tab } of paneTabs) tabs[tab.id] = tab
      const shown = paneTabs.find((entry) => entry.surfaceId === node.show) ?? paneTabs[0]
      containers[containerId] = { id: containerId, groupId }
      tabGroups[groupId] = { tabIds: paneTabs.map((entry) => entry.tab.id), activeTabId: shown.tab.id }
      firstContainerId ??= containerId
      return { kind: 'leaf', containerId }
    }
    const pixels = node.unit === 'px'
    const built = node.children
      .map((child, index) => ({ node: build(child, `${path}-${index}`), size: node.sizes?.[index] ?? 1, across: node.across?.[index] ?? null }))
      .filter((entry): entry is { node: SplitTreeNode; size: number; across: number | null } => !!entry.node)
    if (!built.length) return null
    if (built.length === 1) return built[0].node
    const total = built.reduce((sum, entry) => sum + entry.size, 0)
    const across = built.map((entry) => entry.across)
    return {
      kind: 'split',
      dir: node.dir,
      // Pixel lengths are each pane's own and stay as given; relative sizes become shares of the split.
      sizes: built.map((entry) => (pixels ? entry.size : entry.size / total)),
      ...(pixels ? { sizeUnit: 'px' as const } : {}),
      ...(pixels && node.keep ? { keepLengths: true } : {}),
      ...(across.some((length) => length !== null) ? { crossSizes: across } : {}),
      ...(node.stack ? { stackBelow: node.stack } : {}),
      children: built.map((entry) => entry.node),
    }
  }

  const root = build(starter.arrangement, '')
  if (!root) return null
  return normalizeLayoutState({
    containers,
    tabGroups,
    tabs,
    layouts: [{ type: 'tiled', root }],
    focusedContainerId: firstContainerId,
    maximizedContainerId: null,
  })
}

/**
 * The arrangement in a LayoutState as the starter shape: its tiled tree, each
 * pane's surfaces in tab order with the one showing as `show` when it is not
 * the first. Panes holding no offered surface, and splits left with one child,
 * are folded away as starterLayoutState folds them; null when nothing is tiled.
 */
export function starterArrangementOf(state: LayoutState | null | undefined): StarterNode | null {
  if (!state) return null
  const tiled = (Array.isArray(state.layouts) ? state.layouts : []).find((layout) => layout?.type === 'tiled')
  const surfaceOf = (tabId: string | null | undefined): string | null =>
    readText(tabId ? state.tabs?.[tabId]?.metadata?.placeable_surface_id : null)
  // A tab opened on its own input (one list, one decision) reads back as that thing, titled as it shows.
  const entryOf = (tabId: string): StarterSurface | null => {
    const id = surfaceOf(tabId)
    const tab = state.tabs?.[tabId]
    const opened = tab?.metadata?.surfaceInputBinding === 'invocation' && isRecord(tab?.metadata?.surfaceInput) ? tab!.metadata!.surfaceInput as Record<string, unknown> : null
    // What the screen kept in this placement (its selection, grouping, view, depth) reads back with it, so an AI sees
    // and sets it (ui/show/placement-kept).
    const kept = tab?.metadata?.[KEPT_KEY]
    if (!id || (!opened && !isRecord(kept))) return id
    const input = { ...(opened ?? {}), ...(isRecord(kept) ? { [KEPT_KEY]: kept } : {}) }
    const title = readText(tab?.title)
    return { id, input, ...(opened && title ? { title } : {}) }
  }
  const walk = (node: SplitTreeNode | null | undefined): StarterNode | null => {
    if (!node) return null
    if (node.kind === 'leaf') {
      const group = state.tabGroups?.[state.containers?.[node.containerId]?.groupId ?? '']
      const surfaces = (group?.tabIds ?? []).map(entryOf).filter((entry): entry is StarterSurface => !!entry)
      if (!surfaces.length) return null
      const show = surfaceOf(group?.activeTabId)
      return { kind: 'pane', surfaces, ...(show && show !== starterSurfaceId(surfaces[0]) ? { show } : {}) }
    }
    const kept = (node.children ?? [])
      .map((child, index) => ({ child: walk(child), size: node.sizes?.[index], across: node.crossSizes?.[index] ?? null }))
      .filter((entry): entry is { child: StarterNode; size: number | undefined; across: number | null } => !!entry.child)
    if (!kept.length) return null
    if (kept.length === 1) return kept[0].child
    const sizes = kept.map((entry) => entry.size)
    const pixels = node.sizeUnit === 'px'
    const whole = sizes.every((size): size is number => typeof size === 'number' && Number.isFinite(size) && (size > 0 || (node.sizeUnit === 'px' && size === 0)))
    const across = kept.map((entry) => (typeof entry.across === 'number' && entry.across > 0 ? Math.round(entry.across) : null))
    return {
      kind: 'split',
      dir: node.dir,
      // Pixel lengths read back as whole pixels with their unit, so an AI sees and sets the sizes panes are drawn at.
      ...(whole ? { sizes: sizes.map((size) => (pixels ? Math.round(size) : Math.round(size * 100) / 100)) } : {}),
      ...(whole && pixels ? { unit: 'px' as const } : {}),
      ...(whole && pixels && node.keepLengths ? { keep: true as const } : {}),
      ...(across.some((length) => length !== null) ? { across } : {}),
      ...(node.stackBelow ? { stack: node.stackBelow } : {}),
      children: kept.map((entry) => entry.child),
    }
  }
  return walk(tiled && 'root' in tiled ? tiled.root : null)
}

/** An input value that names one of the record's values: { from: 'record', key }. */
const recordValueKey = (value: unknown): string | null =>
  isRecord(value) && value.from === 'record' && typeof value.key === 'string' && value.key ? value.key : null

/**
 * A starter template filled from one record: every `{ from: 'record', key }` in an entry's input becomes the record's
 * value under `key`; an entry naming a value the record does not have is left out, and so is a pane or split left
 * empty by that (null when nothing is left).
 */
export function starterFilledFrom(node: StarterNode, record: Record<string, unknown>): StarterNode | null {
  if (node.kind === 'split') {
    const children = node.children.map((child) => starterFilledFrom(child, record)).filter((child): child is StarterNode => !!child)
    if (!children.length) return null
    return children.length === 1 ? children[0] : { kind: 'split', dir: node.dir, children }
  }
  const surfaces = node.surfaces.flatMap((entry): StarterSurface[] => {
    if (typeof entry === 'string') return [entry]
    const input: Record<string, unknown> = {}
    for (const [field, value] of Object.entries(entry.input)) {
      const key = recordValueKey(value)
      const filled = key ? record[key] : value
      if (filled === undefined || filled === null || filled === '') return []
      input[field] = filled
    }
    return [{ ...entry, input }]
  })
  if (!surfaces.length) return null
  const show = node.show && surfaces.some((entry) => starterSurfaceId(entry) === node.show) ? node.show : undefined
  return { kind: 'pane', surfaces, ...(show ? { show } : {}) }
}

/** Whether an arrangement holds at least one tab: one with none shows only a picker, never what its host declared. */
export function holdsAnyTab(state: Partial<LayoutState> | null | undefined): boolean {
  return Object.values(state?.tabGroups ?? {}).some((group) => (group?.tabIds?.length ?? 0) > 0)
}
