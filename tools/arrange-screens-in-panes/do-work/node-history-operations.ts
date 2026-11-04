// packages/screen-arrangement/do-work/node-history-operations.ts
//
// Per-node navigation-history mutations over LayoutState, persisted via the
// generic applyLayoutState commit (the normalizer preserves `nodeHistory`, and
// the structural slot-reply preserve in layout-operations carries any field the
// slot omits across slot ops). The cursor math itself
// lives in the shared, storage-blind `node-history-model` in ui — screen-
// arrangement is just ONE consumer (web-frame is another); neither re-implements
// the browser-history semantics. This file only owns the screen-arrangement
// persistence: keying by region and writing `{nodeRef, entries, cursor}`.

import { recordVisit, stepBack, stepForward, canStepBack, canStepForward, currentRef } from '../../ui/show/nav-arrows/node-history-model'
import type { AddressRef } from '../../ui/show/visual-layer-stack'
import type { LayoutState } from '../read-data/layout-types'
import type { NodeHistoryRecord } from '../read-data/node-history-types'
import { containerRegion, regionAddressKey } from '../read-data/region-address'

export function nodeHistoryKey(nodeRef: AddressRef): string {
  return regionAddressKey(nodeRef)
}

export function getNodeHistory(state: LayoutState, nodeRef: AddressRef): NodeHistoryRecord | null {
  return state.nodeHistory?.[nodeHistoryKey(nodeRef)] ?? null
}

export function canHistoryBack(state: LayoutState, nodeRef: AddressRef): boolean {
  return canStepBack(getNodeHistory(state, nodeRef))
}

export function canHistoryForward(state: LayoutState, nodeRef: AddressRef): boolean {
  return canStepForward(getNodeHistory(state, nodeRef))
}

/** The ref currently shown by the cursor, or null when empty. */
export function currentHistoryRef(state: LayoutState, nodeRef: AddressRef): string | null {
  return currentRef(getNodeHistory(state, nodeRef))
}

function commitHistory(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  key: string,
  record: NodeHistoryRecord,
): void {
  applyLayoutState({
    ...state,
    nodeHistory: { ...(state.nodeHistory ?? {}), [key]: record },
  })
}

/**
 * Record a navigation to `ref` (browser semantics — see node-history-model).
 * No-op when `ref` already sits at the cursor.
 */
export function recordNavigation(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  nodeRef: AddressRef,
  ref: string,
  label: string,
  ts: number,
): void {
  const prior = getNodeHistory(state, nodeRef)
  const next = recordVisit(prior, { ref, label, ts })
  if (!next) return
  commitHistory(state, applyLayoutState, nodeHistoryKey(nodeRef), { nodeRef, ...next })
}

/** Move the cursor back one and return the ref to re-project, or null. */
export function historyBack(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  nodeRef: AddressRef,
): string | null {
  const stepped = stepBack(getNodeHistory(state, nodeRef))
  if (!stepped) return null
  commitHistory(state, applyLayoutState, nodeHistoryKey(nodeRef), { nodeRef, ...stepped.trail })
  return stepped.ref
}

/** Move the cursor forward one and return the ref to re-project, or null. */
export function historyForward(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  nodeRef: AddressRef,
): string | null {
  const stepped = stepForward(getNodeHistory(state, nodeRef))
  if (!stepped) return null
  commitHistory(state, applyLayoutState, nodeHistoryKey(nodeRef), { nodeRef, ...stepped.trail })
  return stepped.ref
}

/** Move directly to a visited ref and return it for the caller to re-open. */
export function historyNavigateTo(
  state: LayoutState,
  applyLayoutState: (next: LayoutState) => void,
  nodeRef: AddressRef,
  ref: string,
): string | null {
  const key = nodeHistoryKey(nodeRef)
  const record = state.nodeHistory?.[key]
  if (!record) return null
  const cursor = record.entries.findIndex((entry) => entry.ref === ref)
  if (cursor < 0 || cursor === record.cursor) return null
  commitHistory(state, applyLayoutState, key, { ...record, cursor })
  return ref
}

/**
 * The pane's history as the rows its back/forward list shows: each visit's
 * label with the time it was opened, and a closed tab kept as disabled context.
 */
export function historyListItems(
  record: NodeHistoryRecord,
  liveTabs: Readonly<Record<string, unknown>>,
): { ref: string; label: string; description: string; disabled: boolean }[] {
  return record.entries.map((entry) => ({
    ref: entry.ref,
    label: entry.label,
    description: new Date(entry.ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    disabled: !liveTabs[entry.ref],
  }))
}

const HISTORY_KEPT = 100

/**
 * Every pane whose shown tab changed between two layout states gets that tab recorded as a visit, so a pane's one
 * history holds everything it showed, however it came to show it: a tab pressed, an open from the sidebar, an AI or a
 * tour, a tab dragged in. A pane with no history yet first records what it showed before, so Back has somewhere to go.
 * Stepping back or forward moves the cursor first, so the tab it then shows already sits at the cursor and records
 * nothing. One comparison per pane; only panes whose shown tab changed are written, and unchanged state is returned as is.
 */
export function recordVisits(prev: LayoutState, next: LayoutState, ts: number): LayoutState {
  let history = next.nodeHistory
  for (const [containerId, container] of Object.entries(next.containers)) {
    const shown = next.tabGroups[container.groupId]?.activeTabId ?? null
    const before = prev.containers[containerId]
    const shownBefore = before ? prev.tabGroups[before.groupId]?.activeTabId ?? null : null
    if (!shown || shown === shownBefore || !next.tabs[shown]) continue
    const nodeRef = containerRegion(containerId)
    const key = nodeHistoryKey(nodeRef)
    let trail: NodeHistoryRecord | null = history?.[key] ?? null
    if (!trail && shownBefore && next.tabs[shownBefore]) {
      const seeded = recordVisit(null, { ref: shownBefore, label: next.tabs[shownBefore].title, ts })
      if (seeded) trail = { nodeRef, ...seeded }
    }
    const visited = recordVisit(trail, { ref: shown, label: next.tabs[shown].title, ts })
    if (!visited) continue
    // A pane keeps its latest HISTORY_KEPT visits; the oldest fall off as new ones arrive.
    const drop = Math.max(0, visited.entries.length - HISTORY_KEPT)
    history = { ...(history ?? {}), [key]: { nodeRef, entries: visited.entries.slice(drop), cursor: visited.cursor - drop } }
  }
  return history === next.nodeHistory ? next : { ...next, nodeHistory: history }
}
