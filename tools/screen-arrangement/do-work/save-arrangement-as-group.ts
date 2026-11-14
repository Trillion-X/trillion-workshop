// packages/screen-arrangement/do-work/save-arrangement-as-group.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Saved layouts as GROUP RECORDS (plan T3, master §4.1/W1). A saved layout is a
// group whose members are the arrangement's tabs — each member's opaque
// `presentation` carries that tab's arrangement payload (tab meta + which
// container/group it sits in), and the group's own record carries the
// structural remainder (layouts tree, surface mode) on a designated member.
// screen-arrangement NEVER writes group records itself: it only BUILDS the
// self-describing op list and dispatches group's `group.apply-mutation` door by
// address. Applying a preset folds the group back into a LayoutState and writes
// through the EXISTING save-layout-state SSOT (never a second layout store).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Membership SSOT = group records. No prop:layout_preset:* family (L030 —
//    migrated by migrate-layout-presets-to-groups.ts, then dead).
// 2. This module dispatches ops by ADDRESS (group.apply-mutation); it holds
//    ZERO membership logic and ZERO group persistence knowledge.
// 3. Applying a preset writes ONLY through save-layout-state (layout SSOT).
// 4. Decompose(compose(state)) round-trips: the reassembled LayoutState equals
//    the normalized snapshot (tested).
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records'
import type { LayoutState } from '../read-data/layout-types'
import { normalizeLayoutState } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/read-screen-arrangement.ts'

// The group door — dispatched by address, never imported as code (the op list
// is pure DATA; the target executes in the group package).
export const GROUP_APPLY_MUTATION_TARGET = 'group.apply-mutation'

/** The address family a saved-layout group lives under. Society DATA, not code. */
export const LAYOUT_COLLECTION_FAMILY = 'group.layout-preset'

export interface AddressRefData {
  family: string
  parts: Record<string, string>
}

export const layoutPresetRef = (presetId: string): AddressRefData => ({
  family: LAYOUT_COLLECTION_FAMILY,
  parts: { id: presetId },
})

/**
 * The ONE well-known index group whose members are all saved-layout groups.
 * Identity-text records are not enumerable, so listing = load this root and
 * follow its members (the same index-group pattern as group's collection-store).
 */
export const LAYOUT_PRESET_INDEX_REF: AddressRefData = {
  family: 'group.index',
  parts: { scope: 'screen-arrangement', role: 'layout-presets' },
}

// Member id carrying the non-tab structural remainder of the arrangement.
const STRUCTURE_MEMBER = 'arrangement-structure'

export interface GroupOpData {
  kind: string
  groupRef: AddressRefData
  [key: string]: unknown
}

/**
 * Decompose a LayoutState into the atomic op list that persists it as ONE
 * group: ensure-group, then one member per tab (arrangement payload in
 * presentation), then the structure member (layouts/surface/containers/groups),
 * then a name/meta field on the group via the structure member's role.
 * Pure — no I/O, caller supplies identity.
 */
export function buildSaveArrangementOps(
  presetId: string,
  name: string,
  state: LayoutState,
  meta: Record<string, unknown> = {},
): GroupOpData[] {
  const groupRef = layoutPresetRef(presetId)
  const normalized = normalizeLayoutState(state)
  const ops: GroupOpData[] = [{ kind: 'ensure-group', groupRef }]
  // One member per tab: the tab's meta + its owning group id ride presentation.
  for (const [tabId, tab] of Object.entries(normalized.tabs)) {
    const owningGroupId = Object.entries(normalized.tabGroups)
      .find(([, group]) => group.tabIds.includes(tabId))?.[0] ?? null
    ops.push({
      kind: 'add-member',
      groupRef,
      memberId: `tab:${tabId}`,
      nodeRef: { family: 'placeable-surface', parts: { tab: tabId } },
      presentation: { arrangement: { tab, groupId: owningGroupId } },
    })
  }
  // The structural remainder (split tree, floating rects, containers, groups,
  // surface mode, name) rides ONE designated member — still opaque DATA to group.
  ops.push({
    kind: 'add-member',
    groupRef,
    memberId: STRUCTURE_MEMBER,
    nodeRef: { family: 'screen-arrangement.structure', parts: { preset: presetId } },
    role: 'arrangement-structure',
    presentation: {
      ...meta,
      name,
      arrangementStructure: {
        containers: normalized.containers,
        tabGroups: normalized.tabGroups,
        layouts: normalized.layouts,
        surface: normalized.surface,
      },
    },
  })
  // Register the preset in the ONE index group so it is listable. Duplicate
  // registration on re-save is fine: add-member throws on a duplicate memberId,
  // so the caller passes `indexed: false` when updating an existing preset.
  return ops
}

/** The op that registers a preset in the index (first save only). */
export function buildIndexRegistrationOp(presetId: string): GroupOpData {
  return {
    kind: 'add-member',
    groupRef: LAYOUT_PRESET_INDEX_REF,
    memberId: `preset:${presetId}`,
    nodeRef: layoutPresetRef(presetId),
  }
}

/** The op that removes a preset from the index (delete path). */
export function buildIndexRemovalOp(presetId: string): GroupOpData {
  return {
    kind: 'remove-member',
    groupRef: LAYOUT_PRESET_INDEX_REF,
    memberId: `preset:${presetId}`,
  }
}

/** A decoded saved-layout group as the menu renders it. */
export interface GroupSavedLayout {
  id: string
  name: string
  layout: LayoutState
  /** Opaque preset meta (starred, order, timestamps…) — Society DATA, renderer-read only. */
  meta: Record<string, unknown>
}

/**
 * Reassemble a LayoutState from a persisted saved-layout group record (the leaf
 * `Group` JSON at `package::group::group::<key>`). Blind-tolerant: unresolvable
 * members are skipped; a group without a structure member is not a preset
 * (renderers key off field PRESENCE — no collection_kind enum).
 */
export function foldGroupToLayoutState(groupValue: unknown): GroupSavedLayout | null {
  if (!groupValue || typeof groupValue !== 'object') return null
  const group = groupValue as {
    groupRef?: AddressRefData
    memberOrder?: string[]
    members?: Record<string, { memberId?: string; role?: string; presentation?: Record<string, unknown> }>
  }
  const members = group.members ?? {}
  const structure = Object.values(members).find((m) => m?.role === 'arrangement-structure')
  const structurePresentation = structure?.presentation as
    | { name?: unknown; arrangementStructure?: Partial<LayoutState> }
    | undefined
  if (!structurePresentation?.arrangementStructure) return null
  const base = structurePresentation.arrangementStructure
  const tabs: Record<string, unknown> = {}
  for (const member of Object.values(members)) {
    const arrangement = (member?.presentation as { arrangement?: { tab?: { id?: string } } } | undefined)?.arrangement
    if (arrangement?.tab?.id) tabs[arrangement.tab.id] = arrangement.tab
  }
  const layout = normalizeLayoutState({ ...base, tabs } as Partial<LayoutState>)
  const { arrangementStructure: _structure, name: rawName, ...meta } = structurePresentation as Record<string, unknown>
  return {
    id: group.groupRef?.parts?.id ?? '',
    name: typeof rawName === 'string' ? rawName : 'Saved layout',
    layout,
    meta,
  }
}

/**
 * Dispatch the atomic save through the group door (ONE batch — all ops fold
 * over one loaded graph). Save is idempotent for create AND update: the preset
 * group is rebuilt from scratch (delete-group on an absent group is a no-op)
 * and the index registration is re-asserted (remove-member absent = no-op).
 */
export function buildSaveArrangementBatch(
  presetId: string,
  name: string,
  state: LayoutState,
  meta: Record<string, unknown> = {},
): GroupOpData[] {
  return [
    { kind: 'delete-group', groupRef: layoutPresetRef(presetId) },
    ...buildSaveArrangementOps(presetId, name, state, meta),
    buildIndexRemovalOp(presetId),
    buildIndexRegistrationOp(presetId),
  ]
}

export async function saveArrangementAsGroup(
  presetId: string,
  name: string,
  state: LayoutState,
  meta: Record<string, unknown> = {},
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: GROUP_APPLY_MUTATION_TARGET,
    payload: { ops: buildSaveArrangementBatch(presetId, name, state, meta) },
  })
}

/** Delete a preset = tombstone its group + deregister from the index (one batch). */
export async function deleteArrangementGroup(presetId: string): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: GROUP_APPLY_MUTATION_TARGET,
    payload: {
      ops: [
        { kind: 'delete-group', groupRef: layoutPresetRef(presetId) },
        buildIndexRemovalOp(presetId),
      ],
    },
  })
}

/** Rename a preset = update the structure member's presentation.name field. */
export async function renameArrangementGroup(
  presetId: string,
  name: string,
  currentStructure: Record<string, unknown>,
): Promise<unknown> {
  return sendRequestToBitfieldTarget({
    target: GROUP_APPLY_MUTATION_TARGET,
    payload: {
      op: {
        kind: 'set-member-fields',
        groupRef: layoutPresetRef(presetId),
        memberId: STRUCTURE_MEMBER,
        presentation: { ...currentStructure, name },
      },
    },
  })
}
