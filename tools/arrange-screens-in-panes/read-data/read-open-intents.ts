// packages/screen-arrangement/read-data/read-open-intents.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Blind decoder for OPEN-INTENT rows (plan A12/A13) — the DATA-driven "how do
// I want these things opened" catalog rendered inside a folder's
// AnchoredOverlay. Read through the SAME `group.load-graph` door as folders
// and presets (read-tab-collections.ts); which rows are open-intents is
// decided purely by group family + per-member field presence, never a kind
// enum.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Open-intent rows are CATALOG-WIDE data (one group, many members) — every
//    folder's overlay renders the SAME option list; which surfaces a row acts
//    on is resolved at APPLY time from the row's own `scope` field, not from
//    which folder it was opened from.
// 2. New options are added/removed/reordered by editing group members through
//    group.apply-mutation — zero code change per option (L069/L124).
// 3. `arrangement.strategy` is the ONLY closed vocabulary here (a small,
//    Physics-level composition-primitive name, mirrored 1:1 by
//    do-work/execute-open-intent.ts's strategy map — the same closed-set-on-
//    top-of-open-data shape as read-data/surface-modes.ts's
//    BaseSurfaceGeometry/SurfaceMode split). Everything else on a row — label,
//    icon, order, scope, target, and every strategy param — is open DATA.
//
// =============================================================================

import type { AddressRefData } from '../do-work/save-arrangement-as-group'
import { decodeGraphReply } from './read-tab-collections'

/** Address family the open-intent catalog group lives under. Society DATA, not code. */
export const OPEN_INTENT_CATALOG_FAMILY = 'group.open-intent-catalog'
const OPEN_INTENT_CATALOG_ID = 'default'

/** The ONE catalog group — open intents are global, not per-folder. */
export const openIntentCatalogRef = (): AddressRefData => ({
  family: OPEN_INTENT_CATALOG_FAMILY,
  parts: { id: OPEN_INTENT_CATALOG_ID },
})

export interface OpenIntentTarget {
  kind: 'live' | 'preset'
  /** Present only when kind === 'preset' — id/name of the saved layout to write. */
  presetId?: string
  presetName?: string
}

export interface OpenIntentRow {
  id: string
  label: string
  order: number
  icon?: string
  /** Closed composition-primitive name — see do-work/execute-open-intent.ts's strategy map. */
  strategy: string
  /** Every other `arrangement.*` field — open DATA, strategy-specific. */
  params: Record<string, unknown>
  scope: 'all' | 'selected'
  target: OpenIntentTarget
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function decodeTarget(value: unknown): OpenIntentTarget {
  if (isRecord(value) && value.kind === 'preset' && typeof value.presetId === 'string' && value.presetId.trim()) {
    return {
      kind: 'preset',
      presetId: value.presetId,
      presetName: typeof value.presetName === 'string' && value.presetName.trim() ? value.presetName : value.presetId,
    }
  }
  return { kind: 'live' }
}

function decodeOpenIntentRow(memberId: string, member: Record<string, unknown>): OpenIntentRow | null {
  if (member.role !== 'open-intent') return null // field-presence gate, never a kind switch
  const presentation = isRecord(member.presentation) ? member.presentation : {}
  const { label, order, icon, arrangement, scope, target } = presentation
  if (typeof label !== 'string' || !label.trim()) return null
  if (!isRecord(arrangement) || typeof arrangement.strategy !== 'string' || !arrangement.strategy.trim()) return null
  const { strategy, ...params } = arrangement
  return {
    id: memberId,
    label: label.trim(),
    order: typeof order === 'number' ? order : 0,
    icon: typeof icon === 'string' ? icon : undefined,
    strategy,
    params,
    scope: scope === 'selected' ? 'selected' : 'all',
    target: decodeTarget(target),
  }
}

/** Decode one folded open-intent catalog group into its ordered row list. */
export function decodeOpenIntentRows(groupValue: unknown): OpenIntentRow[] {
  if (!isRecord(groupValue)) return []
  const groupRef = groupValue.groupRef as { family?: string } | undefined
  if (groupRef?.family !== OPEN_INTENT_CATALOG_FAMILY) return []
  const members = isRecord(groupValue.members) ? groupValue.members as Record<string, Record<string, unknown>> : {}
  const rows: OpenIntentRow[] = []
  for (const [memberId, member] of Object.entries(members)) {
    if (!isRecord(member)) continue
    const row = decodeOpenIntentRow(memberId, member)
    if (row) rows.push(row)
  }
  rows.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
  return rows
}

/** Fold a group.load-graph reply (rooted at openIntentCatalogRef()) into rows. */
export function readOpenIntentRows(rawReply: unknown): OpenIntentRow[] {
  const reply = decodeGraphReply(rawReply)
  if (!isRecord(reply)) return []
  const graph = reply.graph
  if (!isRecord(graph) || !isRecord(graph.groups)) return []
  for (const value of Object.values(graph.groups)) {
    const rows = decodeOpenIntentRows(value)
    if (rows.length > 0) return rows
  }
  return []
}
