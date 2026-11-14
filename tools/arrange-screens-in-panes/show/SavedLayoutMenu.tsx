// packages/screen-arrangement/show/SavedLayoutMenu.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Saved layout controls for screen-arrangement chrome — a BLIND renderer over
// GROUP-backed presets (plan T3/W1). Membership SSOT is the group package:
// saving dispatches self-describing ops to `group.apply-mutation` by address,
// listing loads the ONE index group through `group.load-graph`, and applying a
// preset writes ONLY through the existing layout-state owner action. This
// component owns zero membership logic and zero layout storage.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Saved layouts are group records at group addresses — never a private
//    screen-arrangement record family (the prop:layout_preset:* family is
//    legacy; a one-shot migration rewrites and archives it).
// 2. Loading a saved layout applies an exact normalized LayoutState snapshot
//    through the screen-arrangement owner (layout-state SSOT).
// 3. Save/rename rebuild the same group atomically (one op batch).
// 4. Delete tombstones the group + deregisters the index (append-only).
//
// =============================================================================

'use client'

import React from 'react'
import { sendRequestToBitfieldTarget } from '@bitfield/runtime-kit'
import { useBitfieldData } from '@bitfield/runtime-kit/react'
import { Check, ChevronDown, LayoutGrid, Save, Star, X, Palette } from 'lucide-react'
import { ExpandableTabs } from '@/packages/ui/show/expandable-tabs'
import { Button } from '@/packages/ui/show/button';
import { cn } from '@/packages/ui/show/cn';
import { Dropdown } from '@/packages/ui/show/dropdown'
import { ColorPickerPopover } from '@/packages/ui/show/color-picker-popover'
import { readEditableScreenLookThemes } from '@/packages/screen-look/read-data/read-editable-screen-look-themes'
import { readCurrentScreenLook } from '@/packages/screen-look/read-data/read-current-screen-look'
import { chooseCurrentScreenLook } from '@/packages/screen-look/do-work/choose-current-screen-look'
import { LayoutActionsContext, LayoutStateContext } from '@/packages/screen-arrangement/show/screen-arrangement-context'
import type { LayoutState } from '@/packages/screen-arrangement/read-data/layout-types'
import { readLayoutPresets } from '@/packages/screen-arrangement/read-data/read-layout-presets'
import { readNewTabCollections } from '@/packages/screen-arrangement/read-data/read-tab-collections'
import {
  deleteArrangementGroup,
  saveArrangementAsGroup,
  LAYOUT_PRESET_INDEX_REF,
  type GroupSavedLayout,
} from '@/packages/screen-arrangement/do-work/save-arrangement-as-group'
import { migrateLayoutPresetsToGroups } from '@/packages/screen-arrangement/do-work/migrate-layout-presets-to-groups'

type SavedLayoutControlsProps = {
  onDone?: () => void
  keepOpen?: boolean
  onKeepOpenChange?: (value: boolean) => void
}

export const SAVED_LAYOUTS_CHANGED_EVENT = 'screen-arrangement:saved-layouts-changed'
const DEFAULT_LAYOUT_ACCENT = '#8b8b94'
const PREVIOUS_LAYOUT_ID = 'layout-recovery-previous-switch'
const PREVIOUS_LAYOUT_META_KEY = 'screen_arrangement_previous_layout'

function savedAccent(preset: GroupSavedLayout): string {
  const value = preset.meta.accent_color
  return typeof value === 'string' && /^#(?:[\da-f]{6}|[\da-f]{8})$/i.test(value) ? value : DEFAULT_LAYOUT_ACCENT
}

function savedScreenLook(preset: GroupSavedLayout): string | null {
  const value = preset.meta.screen_look_id
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function announceSavedLayoutsChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(SAVED_LAYOUTS_CHANGED_EVENT))
}

function newLayoutId(): string {
  return `layout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function cloneLayoutState(state: LayoutState): LayoutState {
  return JSON.parse(JSON.stringify(state)) as LayoutState
}

function canonicalizeLayoutValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeLayoutValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, canonicalizeLayoutValue((value as Record<string, unknown>)[key])]),
  )
}

function layoutValueSignature(value: unknown): string {
  return JSON.stringify(canonicalizeLayoutValue(value))
}

export function savedLayoutSignature(state: LayoutState): string {
  return layoutValueSignature(state)
}

function savedArrangementSignature(state: LayoutState): string {
  return layoutValueSignature({
    containers: state.containers,
    tabGroups: state.tabGroups,
    tabs: state.tabs,
    layouts: state.layouts,
    surface: state.surface,
  })
}

/**
 * Replace the active arrangement only after the current layout has been saved
 * and read back as the shared Previous layout recovery point. All entry points
 * (menu, wheel, and navigator arrows) use this operation so a preset can never
 * bypass the recovery guard.
 */
export async function switchSavedLayoutWithRecovery({
  currentLayout,
  preset,
  applyLayoutState,
  currentScreenLook,
  beforeApply,
}: {
  currentLayout: LayoutState
  preset: GroupSavedLayout
  applyLayoutState: (state: LayoutState) => void
  currentScreenLook?: string | null
  beforeApply?: () => Promise<void> | void
}): Promise<GroupSavedLayout[] | null> {
  let refreshedPresets: GroupSavedLayout[] | null = null
  if (savedLayoutSignature(currentLayout) !== savedLayoutSignature(preset.layout)) {
    const previous: GroupSavedLayout = {
      id: PREVIOUS_LAYOUT_ID,
      name: 'Previous layout',
      layout: cloneLayoutState(currentLayout),
      meta: {
        starred: false,
        created_at: new Date().toISOString(),
        screen_look_id: currentScreenLook ?? null,
        [PREVIOUS_LAYOUT_META_KEY]: true,
      },
    }
    await saveArrangementAsGroup(previous.id, previous.name, previous.layout, previous.meta)
    refreshedPresets = await loadSavedLayoutGroups()
    const verifiedPrevious = refreshedPresets.find((candidate) => candidate.id === PREVIOUS_LAYOUT_ID)
    if (!verifiedPrevious || savedArrangementSignature(verifiedPrevious.layout) !== savedArrangementSignature(currentLayout)) {
      throw new Error('The previous layout could not be confirmed in Saved layouts.')
    }
  }

  await beforeApply?.()
  applyLayoutState(preset.layout)
  return refreshedPresets
}

function isStarred(preset: GroupSavedLayout): boolean {
  return preset.meta.starred === true
}

function sortSavedLayouts(presets: GroupSavedLayout[]): GroupSavedLayout[] {
  return [...presets].sort((a, b) => (
    Number(b.meta[PREVIOUS_LAYOUT_META_KEY] === true) - Number(a.meta[PREVIOUS_LAYOUT_META_KEY] === true)
    ||
    Number(isStarred(b)) - Number(isStarred(a))
    || a.name.localeCompare(b.name)
    || a.id.localeCompare(b.id)
  ))
}

/** Load every saved-layout group registered in the ONE index group. */
export async function loadSavedLayoutGroups(): Promise<GroupSavedLayout[]> {
  const reply = await sendRequestToBitfieldTarget({
    target: 'group.load-graph',
    payload: { roots: [LAYOUT_PRESET_INDEX_REF] },
  })
  return sortSavedLayouts(readNewTabCollections(reply).presets)
}

export function SavedLayoutControls({ onDone, keepOpen = false, onKeepOpenChange }: SavedLayoutControlsProps) {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  if (!layoutState || !layoutActions) throw new Error('Screen-arrangement owner context missing for SavedLayoutControls')

  // Legacy feed — read ONLY to drive the one-shot migration; the group fold is
  // the render source. Once migration archives every legacy row this feed is
  // permanently empty and the legacy reader can be deleted with the family.
  const rawLegacy = useBitfieldData('layout-presets')
  const legacyPresets = React.useMemo(() => readLayoutPresets(rawLegacy), [rawLegacy])
  const rawThemes = useBitfieldData('editable-screen-look-themes')
  const rawCurrentLook = useBitfieldData('current-screen-look')
  const screenThemes = React.useMemo(() => readEditableScreenLookThemes(rawThemes), [rawThemes])
  const currentScreenLook = readCurrentScreenLook(rawCurrentLook)

  const [presets, setPresets] = React.useState<GroupSavedLayout[]>([])
  const migrationFired = React.useRef(false)

  const refresh = React.useCallback(async () => {
    try {
      setPresets(await loadSavedLayoutGroups())
    } catch {
      /* engine unreachable → keep last known list */
    }
  }, [])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (migrationFired.current || legacyPresets.length === 0) return
    migrationFired.current = true
    void migrateLayoutPresetsToGroups(legacyPresets).then(() => refresh())
  }, [legacyPresets, refresh])

  const currentSignature = React.useMemo(() => savedLayoutSignature(layoutState), [layoutState])
  const activePreset = React.useMemo(
    () => presets.find((preset) => savedLayoutSignature(preset.layout) === currentSignature) ?? null,
    [presets, currentSignature],
  )

  const [name, setName] = React.useState('')
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editingName, setEditingName] = React.useState('')
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [activationError, setActivationError] = React.useState<string | null>(null)
  const [accentPreset, setAccentPreset] = React.useState<GroupSavedLayout | null>(null)
  const accentAnchorRef = React.useRef<HTMLButtonElement>(null)

  const upsertPreset = React.useCallback(async (preset: GroupSavedLayout) => {
    setPresets((current) => sortSavedLayouts([...current.filter((p) => p.id !== preset.id), preset]))
    setBusyId(preset.id)
    try {
      await saveArrangementAsGroup(preset.id, preset.name, preset.layout, preset.meta)
      await refresh()
      announceSavedLayoutsChanged()
    } finally {
      setBusyId(null)
    }
  }, [refresh])

  const saveCurrent = React.useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setName('')
    await upsertPreset({
      id: newLayoutId(),
      name: trimmed,
      layout: cloneLayoutState(layoutState),
      meta: { starred: false, created_at: new Date().toISOString(), screen_look_id: currentScreenLook },
    })
  }, [currentScreenLook, layoutState, name, upsertPreset])

  const renamePreset = React.useCallback(async (preset: GroupSavedLayout) => {
    const trimmed = editingName.trim()
    if (!trimmed || trimmed === preset.name) {
      setEditingId(null)
      return
    }
    setEditingId(null)
    await upsertPreset({ ...preset, name: trimmed })
  }, [editingName, upsertPreset])

  const toggleStar = React.useCallback(async (preset: GroupSavedLayout) => {
    await upsertPreset({ ...preset, meta: { ...preset.meta, starred: !isStarred(preset) } })
  }, [upsertPreset])

  const archivePreset = React.useCallback(async (preset: GroupSavedLayout) => {
    setPresets((current) => current.filter((p) => p.id !== preset.id))
    setBusyId(preset.id)
    try {
      await deleteArrangementGroup(preset.id)
      await refresh()
      announceSavedLayoutsChanged()
    } finally {
      setBusyId(null)
    }
  }, [refresh])

  const activatePreset = React.useCallback(async (preset: GroupSavedLayout) => {
    setActivationError(null)
    setBusyId(preset.id)
    try {
      const themeId = savedScreenLook(preset)
      const refreshed = await switchSavedLayoutWithRecovery({
        currentLayout: layoutState,
        preset,
        applyLayoutState: layoutActions.applyLayoutState,
        currentScreenLook,
        beforeApply: async () => {
          if (themeId && screenThemes.some((theme) => theme.id === themeId)) {
            try { await chooseCurrentScreenLook(themeId) } catch { /* the layout remains usable if look sync is unavailable */ }
          }
        },
      })
      if (refreshed) setPresets(refreshed)
      if (!keepOpen) onDone?.()
    } catch {
      setActivationError('The current layout could not be saved, so the saved layout was not opened.')
    } finally {
      setBusyId(null)
    }
  }, [currentScreenLook, keepOpen, layoutActions, layoutState, onDone, screenThemes])

  const updatePresetMeta = React.useCallback(async (preset: GroupSavedLayout, patch: Record<string, unknown>) => {
    await upsertPreset({ ...preset, meta: { ...preset.meta, ...patch } })
  }, [upsertPreset])

  return (
    <div className="border-t border-[var(--border-primary)] px-1 py-3" aria-label="Saved layouts">
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--text-secondary)]">
        Saved layouts
      </div>
      {onKeepOpenChange ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="mt-2"
          aria-pressed={keepOpen}
          active={keepOpen}
          onClick={() => onKeepOpenChange(!keepOpen)}
        >
          Keep open while switching
        </Button>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void saveCurrent()
          }}
          placeholder="Name current layout"
          className={cn(
            'min-w-0 flex-1 rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-input)] px-3 py-2 text-sm',
            'text-[var(--text-strong)] placeholder:text-[var(--text-secondary)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]',
          )}
        />
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--border-primary)] text-[var(--text-secondary)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
          aria-label="Save current layout"
          title="Save current layout"
          onClick={() => void saveCurrent()}
        >
          <Save className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-2 max-h-48 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
        {presets.length === 0 ? (
          <div className="rounded-xl px-3 py-4 text-sm text-[var(--text-secondary)]">
            Save a layout to reuse it.
          </div>
        ) : presets.map((preset) => {
          const isActive = activePreset?.id === preset.id
          const isEditing = editingId === preset.id
          const isBusy = busyId === preset.id
          return (
            <div
              key={preset.id}
              data-layout-accent={savedAccent(preset)}
              className={cn(
                'group flex items-center gap-2 rounded-xl border-l-2 px-1 py-1.5',
                isActive ? 'bg-[var(--glass-bg-active)]' : 'hover:bg-[var(--glass-bg-hover)]',
              )}
              style={{ borderLeftColor: savedAccent(preset) }}
            >
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                aria-label={isStarred(preset) ? 'Unstar saved layout' : 'Star saved layout'}
                title={isStarred(preset) ? 'Unstar' : 'Star'}
                onClick={() => void toggleStar(preset)}
                disabled={isBusy}
              >
                <Star className={cn('h-4 w-4', isStarred(preset) && 'fill-current text-[var(--text-strong)]')} />
              </button>

              {isEditing ? (
                <input
                  value={editingName}
                  autoFocus
                  onChange={(event) => setEditingName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void renamePreset(preset)
                    if (event.key === 'Escape') setEditingId(null)
                  }}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--border-primary)] bg-[var(--glass-bg-input)] px-2 py-1.5 text-sm text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate rounded-lg px-2 py-1.5 text-left text-sm text-[var(--text-strong)] hover:bg-[var(--glass-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                  title={preset.id === PREVIOUS_LAYOUT_ID
                    ? 'Restore the previous layout and keep this one as the new previous layout.'
                    : 'Switch the whole screen to this layout. The current layout will stay available as Previous layout.'}
                  onClick={() => activatePreset(preset)}
                  disabled={isBusy}
                >
                  {preset.name}
                </button>
              )}

              {isActive ? <Check className="h-4 w-4 flex-shrink-0 text-[var(--text-secondary)]" /> : null}

              <Dropdown
                aria-label={`Screen look for ${preset.name}`}
                items={screenThemes.map((theme) => ({ value: theme.id, label: theme.name }))}
                value={savedScreenLook(preset) ?? currentScreenLook}
                onValueChange={(value) => void updatePresetMeta(preset, { screen_look_id: value })}
                placeholder="Screen look"
                header="Screen look"
                scrollable
                align="end"
                customTrigger={(
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                    aria-label={`Choose screen look for ${preset.name}`}
                    title="Screen look"
                  >
                    <Palette className="h-4 w-4" />
                  </button>
                )}
              />

              <button
                ref={accentPreset?.id === preset.id ? accentAnchorRef : undefined}
                type="button"
                className="h-5 w-5 flex-shrink-0 rounded-full border border-[var(--border-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                style={{ backgroundColor: savedAccent(preset) }}
                aria-label={`Choose accent color for ${preset.name}`}
                title="Layout color"
                onClick={() => setAccentPreset(preset)}
              />

              <ExpandableTabs
                mode="action"
                size="sm"
                ariaLabel={`${preset.name} layout`}
                items={[
                  isEditing
                    ? { id: 'finish-rename', label: 'Finish rename', icon: 'Check', pinned: true }
                    : { id: 'rename', label: 'Rename saved layout', icon: 'Pencil', disabled: isBusy },
                  { id: 'delete', label: 'Delete saved layout', icon: 'Trash2', disabled: isBusy },
                ]}
                onSelect={(id) => {
                  if (id === 'finish-rename') void renamePreset(preset)
                  else if (id === 'rename') {
                    setEditingId(preset.id)
                    setEditingName(preset.name)
                  } else if (id === 'delete') void archivePreset(preset)
                }}
              />
            </div>
          )
        })}
      </div>
      {activationError ? (
        <div className="mt-2 rounded-lg px-2 py-1.5 text-xs text-[var(--text-danger)]" role="alert">
          {activationError}
        </div>
      ) : null}
      <ColorPickerPopover
        anchorRef={accentAnchorRef}
        open={!!accentPreset}
        value={accentPreset ? savedAccent(accentPreset) : DEFAULT_LAYOUT_ACCENT}
        onChange={(color) => {
          if (accentPreset) setAccentPreset({ ...accentPreset, meta: { ...accentPreset.meta, accent_color: color } })
        }}
        onDismiss={() => setAccentPreset(null)}
        onSave={(color) => {
          if (accentPreset) void updatePresetMeta(accentPreset, { accent_color: color })
          setAccentPreset(null)
        }}
        saveLabel="Save layout color"
        title="Layout color"
        size={176}
      />
    </div>
  )
}

export default function SavedLayoutMenu({
  showLabel = false,
  openDirection = 'down',
}: {
  showLabel?: boolean
  openDirection?: 'up' | 'down'
}) {
  const [open, setOpen] = React.useState(false)
  const [keepOpen, setKeepOpen] = React.useState(false)
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const closeMenu = React.useCallback(() => {
    setOpen(false)
    setKeepOpen(false)
  }, [])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && !root.contains(event.target as Node)) closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [closeMenu, open])

  return (
    <div
      ref={rootRef}
      className="relative pointer-events-auto"
      data-no-drag="true"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={cn(
          'inline-flex h-9 items-center justify-center gap-2 rounded-full',
          showLabel ? 'px-3' : 'w-9',
          'glass-popover text-[var(--text-secondary)]',
          'transition-colors hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-primary)]',
          open && 'text-[var(--text-strong)]',
        )}
        aria-label="Saved layouts"
        aria-expanded={open}
        title="Saved layouts"
        onClick={() => {
          if (open) closeMenu()
          else setOpen(true)
        }}
      >
        <LayoutGrid className="h-4 w-4" aria-hidden="true" />
        {showLabel ? <span className="text-xs font-medium">Layouts</span> : null}
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-200 ease-out', open && 'rotate-180')} aria-hidden="true" />
      </button>

      {open ? (
        <div
          className={cn(
            'glass-popover absolute right-0 z-[10031] w-[22rem] overflow-hidden text-[var(--text-primary)]',
            openDirection === 'up' ? 'bottom-11' : 'top-11',
          )}
          role="dialog"
          aria-label="Saved layouts"
        >
          <button
            type="button"
            className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-strong)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
            aria-label="Close saved layouts"
            onClick={closeMenu}
          >
            <X className="h-4 w-4" />
          </button>
          <SavedLayoutControls
            onDone={closeMenu}
            keepOpen={keepOpen}
            onKeepOpenChange={setKeepOpen}
          />
        </div>
      ) : null}
    </div>
  )
}
