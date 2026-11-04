import type {
  ArrangementHistoryEntry,
  ArrangementHistoryRecord,
  ArrangementHistorySnapshot,
  LayoutState,
} from './layout-types'

export const ARRANGEMENT_HISTORY_LIMIT = 40
export const ARRANGEMENT_HISTORY_BYTE_LIMIT = 256 * 1024
const RESIZE_COALESCE_MS = 600

export function arrangementSnapshot(state: LayoutState): ArrangementHistorySnapshot {
  return {
    containers: state.containers,
    tabGroups: state.tabGroups,
    tabs: state.tabs,
    layouts: state.layouts,
    surface: state.surface,
    focusedContainerId: state.focusedContainerId,
    maximizedContainerId: state.maximizedContainerId,
    ...(state.layers ? { layers: state.layers } : {}),
    ...(state.activeLayerId ? { activeLayerId: state.activeLayerId } : {}),
  }
}

function sameSnapshot(a: ArrangementHistorySnapshot, b: ArrangementHistorySnapshot): boolean {
  // Tab selection and pane focus have their own navigation semantics. They are
  // kept in snapshots for faithful restore, while only geometry, membership,
  // and the active layout mode create a new arrangement-history step.
  const signature = (snapshot: ArrangementHistorySnapshot) => ({
    containers: snapshot.containers,
    tabMembership: Object.fromEntries(Object.entries(snapshot.tabGroups).map(([id, group]) => [id, group.tabIds])),
    layouts: snapshot.layouts,
    surface: snapshot.surface,
    layers: snapshot.layers,
    activeLayerId: snapshot.activeLayerId,
    maximizedContainerId: snapshot.maximizedContainerId,
  })
  return stableJson(signature(a)) === stableJson(signature(b))
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
}

function serializedBytes(entries: ArrangementHistoryEntry[]): number {
  // UTF-16 length * 2 is a safe upper bound for the serialized UTF-8 payload.
  return JSON.stringify(entries).length * 2
}

function trimHistory(entries: ArrangementHistoryEntry[], cursor: number): ArrangementHistoryRecord | undefined {
  while (entries.length > 1 && serializedBytes(entries) > ARRANGEMENT_HISTORY_BYTE_LIMIT) {
    // Keep the selected snapshot when normalizing older or oversized saved
    // history. Recorded changes select the newest entry, so they still discard
    // the oldest entries first.
    if (cursor > 0) {
      entries.shift()
      cursor -= 1
    } else {
      entries.pop()
    }
  }
  if (entries.length === 1 && serializedBytes(entries) > ARRANGEMENT_HISTORY_BYTE_LIMIT) return undefined
  return { entries, cursor: Math.max(0, Math.min(entries.length - 1, cursor)) }
}

/**
 * Store the before and after arrangement at the common commit road. Side maps
 * such as pane navigation and decoration are deliberately outside the snapshot.
 */
export function recordArrangementChange(
  before: LayoutState,
  after: LayoutState,
  label: string,
  ts = Date.now(),
  coalesceKey?: string,
): LayoutState {
  const beforeSnapshot = arrangementSnapshot(before)
  const afterSnapshot = arrangementSnapshot(after)
  if (sameSnapshot(beforeSnapshot, afterSnapshot)) return after

  const existing = after.arrangementHistory ?? before.arrangementHistory
  let entries = existing?.entries.slice() ?? [{ snapshot: beforeSnapshot, label: 'Current arrangement', ts }]
  let cursor = existing?.cursor ?? 0
  const cursorEntry = entries[cursor]

  // A direct edit outside this history (for example an older persisted layout)
  // starts a fresh trail at the actual before state rather than mis-restoring.
  if (!cursorEntry || !sameSnapshot(cursorEntry.snapshot, beforeSnapshot)) {
    entries = [{ snapshot: beforeSnapshot, label: 'Current arrangement', ts }]
    cursor = 0
  }

  const last = entries[cursor]
  const coalesce = !!coalesceKey && cursor === entries.length - 1 && last?.coalesceKey === coalesceKey && ts - last.ts <= RESIZE_COALESCE_MS
  if (coalesce) {
    entries[cursor] = { ...last, snapshot: afterSnapshot, label, ts }
  } else {
    entries = entries.slice(0, cursor + 1)
    entries.push({ snapshot: afterSnapshot, label, ts, ...(coalesceKey ? { coalesceKey } : {}) })
    cursor = entries.length - 1
  }

  if (entries.length > ARRANGEMENT_HISTORY_LIMIT) {
    const drop = entries.length - ARRANGEMENT_HISTORY_LIMIT
    entries = entries.slice(drop)
    cursor -= drop
  }
  const history = trimHistory(entries, cursor)
  return history ? { ...after, arrangementHistory: history } : { ...after, arrangementHistory: undefined }
}

export function canUndoArrangement(record: ArrangementHistoryRecord | undefined): boolean {
  return !!record && record.cursor > 0 && record.entries.length > 0
}

export function canRedoArrangement(record: ArrangementHistoryRecord | undefined): boolean {
  return !!record && record.cursor >= 0 && record.cursor < record.entries.length - 1
}

function restoreAt(state: LayoutState, cursor: number): LayoutState {
  const history = state.arrangementHistory
  const entry = history?.entries[cursor]
  if (!history || !entry) return state
  return {
    ...state,
    ...entry.snapshot,
    // An omitted optional snapshot field means it was absent at that point in
    // time. Spreading over the current state alone would retain a later layer
    // stack, whose layouts take precedence over the restored top-level layouts.
    layers: entry.snapshot.layers,
    activeLayerId: entry.snapshot.activeLayerId,
    arrangementHistory: { ...history, cursor },
  }
}

export function undoArrangement(state: LayoutState): LayoutState {
  return canUndoArrangement(state.arrangementHistory)
    ? restoreAt(state, state.arrangementHistory!.cursor - 1)
    : state
}

export function redoArrangement(state: LayoutState): LayoutState {
  return canRedoArrangement(state.arrangementHistory)
    ? restoreAt(state, state.arrangementHistory!.cursor + 1)
    : state
}

export function canRestoreArrangement(record: ArrangementHistoryRecord | undefined, index: number): boolean {
  return !!record && Number.isInteger(index) && index >= 0 && index < record.entries.length && index !== record.cursor
}

export function restoreArrangementAt(state: LayoutState, index: number): LayoutState {
  return canRestoreArrangement(state.arrangementHistory, index) ? restoreAt(state, index) : state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSnapshot(value: unknown): value is ArrangementHistorySnapshot {
  if (!isRecord(value)
    || !isRecord(value.containers)
    || !isRecord(value.tabGroups)
    || !isRecord(value.tabs)
    || !Array.isArray(value.layouts)
    || typeof value.surface !== 'string'
    || !(value.focusedContainerId === null || typeof value.focusedContainerId === 'string')
    || !(value.maximizedContainerId === null || typeof value.maximizedContainerId === 'string')) return false

  const containersValid = Object.entries(value.containers).every(([id, raw]) => isRecord(raw)
    && raw.id === id && typeof raw.groupId === 'string')
  const groupsValid = Object.values(value.tabGroups).every(raw => isRecord(raw)
    && Array.isArray(raw.tabIds) && raw.tabIds.every(tabId => typeof tabId === 'string'))
  const tabsValid = Object.entries(value.tabs).every(([id, raw]) => isRecord(raw)
    && raw.id === id && typeof raw.title === 'string')
  const layoutsValid = value.layouts.length > 0 && value.layouts.every(raw => isRecord(raw)
    && ['tiled', 'floating', 'overlay'].includes(String(raw.type)))
  const layersValid = value.layers === undefined || (Array.isArray(value.layers) && value.layers.every(raw => isRecord(raw)
    && typeof raw.id === 'string' && Array.isArray(raw.layouts)))
  return containersValid && groupsValid && tabsValid && layoutsValid && layersValid
}

/** Keep persisted history bounded and discard malformed snapshots safely. */
export function normalizeArrangementHistory(value: unknown): ArrangementHistoryRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.entries) || typeof record.cursor !== 'number' || !Number.isInteger(record.cursor)) return undefined
  const validEntries: { index: number; entry: ArrangementHistoryEntry }[] = record.entries.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const entry = raw as Record<string, unknown>
    const snapshot = entry.snapshot
    if (!isSnapshot(snapshot)) return []
    if (typeof entry.label !== 'string' || typeof entry.ts !== 'number' || !Number.isFinite(entry.ts)) return []
    return [{ index, entry: {
      snapshot,
      label: entry.label.slice(0, 100),
      ts: entry.ts,
      ...(typeof entry.coalesceKey === 'string' ? { coalesceKey: entry.coalesceKey.slice(0, 80) } : {}),
    } }]
  }).slice(-ARRANGEMENT_HISTORY_LIMIT)
  if (!validEntries.length) return undefined
  const entries = validEntries.map(({ entry }) => entry)
  // Filtering malformed rows can remove entries on either side of the cursor.
  // Map by original position so the selected valid snapshot stays selected.
  let cursor = validEntries.findIndex(({ index }) => index === record.cursor)
  if (cursor < 0) {
    cursor = validEntries.findLastIndex(({ index }) => index < record.cursor)
    if (cursor < 0) cursor = 0
  }
  return trimHistory(entries, cursor)
}

export function arrangementHistoryLabel(operation: string): string {
  const labels: Record<string, string> = {
    resizeSplit: 'Resize panes',
    resizeCross: 'Resize a pane',
    moveFloating: 'Move a pane',
    resizeFloating: 'Resize a pane',
    updateFloatingRect: 'Move or resize a pane',
    moveOverlay: 'Move a pane',
    resizeOverlay: 'Resize a pane',
    addPaneBeside: 'Add a pane',
    closeContainer: 'Close a pane',
    splitContainer: 'Split a pane',
    splitContainerWithTab: 'Split a pane',
    splitContainerWithSurface: 'Split a pane',
    moveContainerToEdge: 'Move a pane',
    moveContainerToRoot: 'Move a pane',
    moveContainerToLayer: 'Move a pane',
    swapContainers: 'Swap panes',
    setSurface: 'Change screen layout',
    applyLayoutState: 'Change screen layout',
  }
  return labels[operation] ?? 'Change screen layout'
}
