// packages/screen-arrangement/do-work/switch-saved-layout.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Opening a saved layout: the one switch every entry point uses (the Layouts
// picker in the sidebar and in an empty pane, and scrolling past the edge of
// the arrangement). The arrangement being replaced
// is first kept as "Previous layout" and read back, so switching can always be
// undone; when it matches no starter or kept layout it is also kept as a layout
// of its own, named from its screens (kept-layouts.json caps how many). Only
// then is the chosen layout applied through the layout-state owner.
//
// Also the one order of layouts (layoutChoices: starters, then kept layouts
// pinned first and newest first, then Previous layout) that the picker draws
// and scrolling past an edge walks, and saving the arrangement on screen under
// a name the person gives it (saveCurrentLayoutAs).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Two arrangements are the same layout when the parts a saved layout keeps
//    (containers, tab groups, tabs, layouts, surface) are equal, whatever order
//    their fields were written in. A saved layout comes back from its group with
//    its fields in the group's order, so an order-sensitive comparison can never
//    confirm a save (the defect that refused every switch, 2026-09-29).
// 2. A layout is applied only after the one it replaces has been read back.
// 3. Listing reads the ONE index group through `group.load-graph`.
// 4. Keeping is by signature: an arrangement already kept (or a starter) is
//    never kept twice, and self-kept duplicates of one signature are merged.
//    Only self-kept layouts are let go past the cap; pinned or renamed ones stay.
// 5. Naming the arrangement on screen never makes a second copy of it: when
//    the switch already kept it (or it is Previous layout), that copy becomes
//    the person's own under the new name.
// 6. Every layout lives in the person's account through the group owner
//    (save-arrangement-as-group.ts); nothing is kept only in the browser.
//
// =============================================================================

import { sendRequestToBitfieldTarget } from '#workspace-records'
import type { LayoutState } from '../read-data/layout-types'
import { normalizeLayoutState } from '../read-data/read-screen-arrangement'
import { readNewTabCollections } from '../read-data/read-tab-collections'
import { layoutNameFromScreens } from '../read-data/layout-picture'
import keptLayouts from '../kept-layouts.json'
import { LAYOUT_PRESET_INDEX_REF, deleteArrangementGroup, saveArrangementAsGroup, type GroupSavedLayout } from './save-arrangement-as-group'

export const SAVED_LAYOUTS_CHANGED_EVENT = 'screen-arrangement:saved-layouts-changed'
export const PREVIOUS_LAYOUT_ID = 'layout-recovery-previous-switch'
export const PREVIOUS_LAYOUT_META_KEY = 'screen_arrangement_previous_layout'
/** Meta on a layout the switch kept by itself; renaming or pinning it makes it the person's own. */
export const SELF_KEPT_META_KEY = 'kept_by_switch'

// The parts of an arrangement a saved layout keeps (save-arrangement-as-group stores exactly these).
const SAVED_ARRANGEMENT_KEYS = ['containers', 'tabGroups', 'tabs', 'layouts', 'surface'] as const

function inStableOrder(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inStableOrder)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, inStableOrder(record[key])]))
}

/** The identity of an arrangement as a saved layout: equal for the same layout, whatever its field order. */
export function savedLayoutSignature(state: LayoutState): string {
  const normalized = normalizeLayoutState(state)
  return JSON.stringify(inStableOrder(Object.fromEntries(SAVED_ARRANGEMENT_KEYS.map((key) => [key, normalized[key]]))))
}

export function cloneLayoutState(state: LayoutState): LayoutState {
  return JSON.parse(JSON.stringify(state)) as LayoutState
}

export function isStarred(preset: GroupSavedLayout): boolean {
  return preset.meta.starred === true
}

export function sortSavedLayouts(presets: GroupSavedLayout[]): GroupSavedLayout[] {
  return [...presets].sort((a, b) => (
    Number(b.meta[PREVIOUS_LAYOUT_META_KEY] === true) - Number(a.meta[PREVIOUS_LAYOUT_META_KEY] === true)
    || Number(isStarred(b)) - Number(isStarred(a))
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id)
  ))
}

function isSelfKept(preset: GroupSavedLayout): boolean {
  return preset.meta[SELF_KEPT_META_KEY] === true && !isStarred(preset)
}

/**
 * The kept layouts to let go: self-kept duplicates of a signature another kept
 * layout already holds, then the oldest self-kept layouts beyond `keepAtMost`.
 */
export function keptLayoutsToLetGo(kept: readonly GroupSavedLayout[], keepAtMost: number): GroupSavedLayout[] {
  const bySignature = new Map<string, GroupSavedLayout[]>()
  for (const preset of kept) {
    const signature = savedLayoutSignature(preset.layout)
    bySignature.set(signature, [...(bySignature.get(signature) ?? []), preset])
  }
  const letGo: GroupSavedLayout[] = []
  for (const same of bySignature.values()) {
    // The person's own copy wins over a self-kept one; among self-kept copies the newest stays.
    const ranked = [...same].sort((a, b) => Number(isSelfKept(a)) - Number(isSelfKept(b)) || keptAt(b) - keptAt(a))
    letGo.push(...ranked.slice(1).filter(isSelfKept))
  }
  const remaining = kept.filter((preset) => isSelfKept(preset) && !letGo.includes(preset)).sort((a, b) => keptAt(b) - keptAt(a))
  return [...letGo, ...remaining.slice(Math.max(0, keepAtMost))]
}

function keptAt(preset: GroupSavedLayout): number {
  const at = Date.parse(String(preset.meta.created_at ?? ''))
  return Number.isFinite(at) ? at : 0
}

export function newLayoutId(): string {
  return `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Tell every Layouts picker and edge switch on the page to read the saved layouts again. */
export function announceSavedLayoutsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SAVED_LAYOUTS_CHANGED_EVENT))
}

/** The person's own copy of a kept layout: no longer kept by the switch, and never the recovery point. */
export function asOwnLayout(preset: GroupSavedLayout, patch: { name?: string; starred?: boolean }): GroupSavedLayout {
  const { [SELF_KEPT_META_KEY]: _kept, [PREVIOUS_LAYOUT_META_KEY]: _previous, ...meta } = preset.meta
  return {
    id: preset.id === PREVIOUS_LAYOUT_ID ? newLayoutId() : preset.id,
    name: patch.name ?? preset.name,
    layout: preset.layout,
    meta: { ...meta, ...(patch.starred === undefined ? {} : { starred: patch.starred }) },
  }
}

/** A layout a person can open, in the one order the picker draws and an edge switch walks. */
export type LayoutChoice = {
  preset: GroupSavedLayout
  signature: string
  /** A kept layout: it can be renamed, pinned and removed. Starters cannot. */
  kept: boolean
}

/**
 * Starters first, then kept layouts (pinned first, newest first), then
 * Previous layout. One entry per arrangement: a layout equal to one already
 * listed is not listed again.
 */
export function layoutChoices(starters: readonly GroupSavedLayout[], saved: readonly GroupSavedLayout[]): LayoutChoice[] {
  const listed = new Set<string>()
  const out: LayoutChoice[] = []
  const add = (preset: GroupSavedLayout, kept: boolean) => {
    const signature = savedLayoutSignature(preset.layout)
    if (listed.has(signature)) return
    listed.add(signature)
    out.push({ preset, signature, kept })
  }
  for (const starter of starters) add(starter, false)
  const kept = saved.filter((preset) => preset.id !== PREVIOUS_LAYOUT_ID)
    .sort((a, b) => Number(isStarred(b)) - Number(isStarred(a)) || keptAt(b) - keptAt(a))
  for (const preset of kept) add(preset, true)
  const previous = saved.find((preset) => preset.id === PREVIOUS_LAYOUT_ID)
  if (previous) add(previous, true)
  return out
}

/**
 * Whether the arrangement on screen still needs a name to be one of the
 * person's layouts: it is not a starter and not a layout they named. One the
 * switch kept by itself, or Previous layout, still takes a name.
 */
export function currentLayoutNeedsName(choices: readonly LayoutChoice[], currentSignature: string): boolean {
  const match = choices.find((choice) => choice.signature === currentSignature)
  if (!match) return true
  return match.kept && (match.preset.id === PREVIOUS_LAYOUT_ID || match.preset.meta[SELF_KEPT_META_KEY] === true)
}

/**
 * Keep the arrangement on screen as a layout named by the person. A copy the
 * switch already kept (or Previous layout) becomes theirs under this name, so
 * the same arrangement is never saved twice. Returns the saved layouts as read
 * back from the account.
 */
export async function saveCurrentLayoutAs({
  name,
  currentLayout,
  saved,
  currentScreenLook,
}: {
  name: string
  currentLayout: LayoutState
  saved: readonly GroupSavedLayout[]
  currentScreenLook?: string | null
}): Promise<GroupSavedLayout[]> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('A layout needs a name to be saved.')
  const signature = savedLayoutSignature(currentLayout)
  const same = saved.filter((preset) => savedLayoutSignature(preset.layout) === signature)
  const keptBySwitch = same.find((preset) => preset.id !== PREVIOUS_LAYOUT_ID && preset.meta[SELF_KEPT_META_KEY] === true)
    ?? same.find((preset) => preset.id === PREVIOUS_LAYOUT_ID)
  const preset: GroupSavedLayout = keptBySwitch
    ? asOwnLayout(keptBySwitch, { name: trimmed })
    : {
        id: newLayoutId(),
        name: trimmed,
        layout: cloneLayoutState(currentLayout),
        meta: { starred: false, created_at: new Date().toISOString(), screen_look_id: currentScreenLook ?? null },
      }
  await saveArrangementAsGroup(preset.id, preset.name, preset.layout, preset.meta)
  const readBack = await loadSavedLayoutGroups()
  if (!readBack.some((candidate) => candidate.id === preset.id && candidate.name === trimmed && savedLayoutSignature(candidate.layout) === signature)) {
    throw new Error('The saved layout could not be confirmed.')
  }
  return readBack
}

/** Load every saved-layout group registered in the ONE index group. */
export async function loadSavedLayoutGroups(): Promise<GroupSavedLayout[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'group.load-graph',
    payload: { roots: [LAYOUT_PRESET_INDEX_REF] },
  })
  return sortSavedLayouts(readNewTabCollections(reply).presets)
}

/** Keep an arrangement no starter or kept layout matches as its own layout, then let go of what the cap allows. */
async function keepUnsavedArrangement(
  currentLayout: LayoutState,
  currentSignature: string,
  presets: GroupSavedLayout[],
  starterLayouts: readonly LayoutState[],
  currentScreenLook?: string | null,
): Promise<GroupSavedLayout[]> {
  const kept = presets.filter((preset) => preset.id !== PREVIOUS_LAYOUT_ID)
  const known = new Set([...kept.map((preset) => savedLayoutSignature(preset.layout)), ...starterLayouts.map(savedLayoutSignature)])
  const name = layoutNameFromScreens(currentLayout)
  let changed = false
  if (name && !known.has(currentSignature)) {
    const preset: GroupSavedLayout = {
      id: newLayoutId(),
      name,
      layout: cloneLayoutState(currentLayout),
      meta: { starred: false, created_at: new Date().toISOString(), screen_look_id: currentScreenLook ?? null, [SELF_KEPT_META_KEY]: true },
    }
    await saveArrangementAsGroup(preset.id, preset.name, preset.layout, preset.meta)
    kept.push(preset)
    changed = true
  }
  for (const preset of keptLayoutsToLetGo(kept, keptLayouts.keep_at_most)) {
    await deleteArrangementGroup(preset.id)
    changed = true
  }
  return changed ? loadSavedLayoutGroups() : presets
}

/**
 * Replace the active arrangement only after the current layout has been saved
 * and read back as the shared Previous layout recovery point.
 */
export async function switchSavedLayoutWithRecovery({
  currentLayout,
  preset,
  applyLayoutState,
  starterLayouts = [],
  currentScreenLook,
  beforeApply,
}: {
  currentLayout: LayoutState
  preset: GroupSavedLayout
  applyLayoutState: (state: LayoutState) => void
  /** The starters this person is offered; an arrangement equal to one is never kept again. */
  starterLayouts?: readonly LayoutState[]
  currentScreenLook?: string | null
  beforeApply?: () => Promise<void> | void
}): Promise<GroupSavedLayout[] | null> {
  let refreshedPresets: GroupSavedLayout[] | null = null
  const currentSignature = savedLayoutSignature(currentLayout)
  if (currentSignature !== savedLayoutSignature(preset.layout)) {
    await saveArrangementAsGroup(PREVIOUS_LAYOUT_ID, 'Previous layout', cloneLayoutState(currentLayout), {
      starred: false,
      created_at: new Date().toISOString(),
      screen_look_id: currentScreenLook ?? null,
      [PREVIOUS_LAYOUT_META_KEY]: true,
    })
    refreshedPresets = await loadSavedLayoutGroups()
    const verifiedPrevious = refreshedPresets.find((candidate) => candidate.id === PREVIOUS_LAYOUT_ID)
    if (!verifiedPrevious || savedLayoutSignature(verifiedPrevious.layout) !== currentSignature) {
      throw new Error('The previous layout could not be confirmed in Saved layouts.')
    }
    refreshedPresets = await keepUnsavedArrangement(currentLayout, currentSignature, refreshedPresets, starterLayouts, currentScreenLook)
  }

  await beforeApply?.()
  applyLayoutState(preset.layout)
  return refreshedPresets
}
