// packages/screen-arrangement/read-data/read-layout-presets.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Decode package-owned saved layout rows projected from `layout-presets`.
// Saved layouts are named snapshots of LayoutState; the package owns their
// records and screen-arrangement owns applying the selected snapshot.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. This reader only decodes projected package data; it does not write records.
// 2. Archived rows are not active saved layouts.
// 3. Layout snapshots are normalized before the UI can apply them.
// 4. Browser storage and Sidebar state are not sources of truth.
//
// =============================================================================

import type { LayoutState } from './layout-types'
import { normalizeLayoutState } from './read-screen-arrangement'
import { readProjectedRows } from './read-projected-rows'

const PROP_NAME = 'prop:layout_preset:name'
const PROP_LAYOUT = 'prop:layout_preset:layout'
const PROP_STARRED = 'prop:layout_preset:starred'
const PROP_ORDER = 'prop:layout_preset:order'
const PROP_CREATED_AT = 'prop:layout_preset:created_at'
const PROP_UPDATED_AT = 'prop:layout_preset:updated_at'
const PROP_STATUS = 'prop:layout_preset:status'

interface LayoutPresetRow {
  subject_id?: unknown
  property_id?: unknown
  value?: unknown
  value_json?: unknown
}

export interface SavedLayout {
  id: string
  name: string
  starred: boolean
  order: number
  createdAt: string
  updatedAt: string
  layout: LayoutState
}

function readRowValue(row: LayoutPresetRow): unknown {
  return row.value_json !== undefined ? row.value_json : row.value
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function readBoolean(value: unknown): boolean {
  return value === true
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readLayout(value: unknown): LayoutState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return normalizeLayoutState(value as Partial<LayoutState>)
}

export function readLayoutPresets(raw: unknown): SavedLayout[] {
  const rows = readProjectedRows(raw) as LayoutPresetRow[]
  const grouped = new Map<string, Map<string, unknown>>()

  for (const row of rows) {
    const subjectId = readString(row.subject_id)
    const propertyId = readString(row.property_id)
    if (!subjectId || !propertyId) continue
    const properties = grouped.get(subjectId) ?? new Map<string, unknown>()
    properties.set(propertyId, readRowValue(row))
    grouped.set(subjectId, properties)
  }

  const presets: SavedLayout[] = []
  for (const [id, properties] of grouped) {
    if (readString(properties.get(PROP_STATUS)) === 'archived') continue

    const name = readString(properties.get(PROP_NAME))
    const layout = readLayout(properties.get(PROP_LAYOUT))
    if (!name || !layout) continue

    const createdAt = readString(properties.get(PROP_CREATED_AT)) ?? ''
    const updatedAt = readString(properties.get(PROP_UPDATED_AT)) ?? createdAt
    presets.push({
      id,
      name,
      starred: readBoolean(properties.get(PROP_STARRED)),
      order: readNumber(properties.get(PROP_ORDER)) ?? Number.MAX_SAFE_INTEGER,
      createdAt,
      updatedAt,
      layout,
    })
  }

  return presets.sort((a, b) => (
    Number(b.starred) - Number(a.starred)
    || a.order - b.order
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id)
  ))
}
