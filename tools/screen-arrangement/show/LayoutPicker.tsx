// parts/screen-arrangement/show/LayoutPicker.tsx
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// The Layouts picker: every layout a person can open, drawn as a small picture
// of its own panes with its name under it. Starters (the host's DATA) come
// first, then the layouts kept for this person. One click opens a layout
// through the one switch (do-work/switch-saved-layout.ts), which keeps the
// arrangement it replaces. The switch keeps an arrangement no layout matches,
// named from its screens; a person can also give the arrangement on screen a
// name of their own ("Name this layout", Save layout). Rename, pin and remove
// are in the shared action menu, on right-click or the "…" a thumbnail shows on
// hover or focus. The same picker is the sidebar's Layouts and an empty pane's.
// Every layout also carries the bell of the person's show rules (Hide this layout
// for an hour, until tomorrow, always, on this device); a hidden layout is not
// offered until its rule ends (use-layout-choices.ts).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Every opening goes through switchSavedLayoutWithRecovery.
// 2. The picture of a layout is read from the layout itself
//    (read-data/layout-picture.ts), never a stored image or a name.
// 3. The layout on screen is the one whose signature equals the current
//    arrangement's; it is marked `aria-current`, its look is screen-look's.
// 4. One thumbnail per arrangement: a kept layout equal to a starter or another
//    shown layout is not drawn twice (Previous layout shows only when nothing
//    else holds it).
// 5. Starters are the host's; they open but are never renamed or removed.
// 6. The name field shows only while the arrangement on screen is not yet a
//    starter or a layout the person named; saving goes through
//    saveCurrentLayoutAs and is confirmed by reading the account back.
// 7. A layout an AI filed in a category (save_layout category, the kept library
//    read-data/layout-library.ts) shows under that category's name, in the
//    library's order; every other layout shows first, with no heading. With no
//    categories the picker is one grid, as before.
//
// =============================================================================

'use client'

import * as React from 'react'
import { sendRequestToBitfieldTarget, useBitfieldData } from '#workspace-records'
import { ActionMenu, type ActionMenuItem } from '../../ui/show/action-menu'
import { controlShown, useShowChange } from '../../ui/show/show-rules/show-of'
import { ShowRuleMenu } from '../../ui/show/show-rules/ShowRuleMenu'
import { ArrangementThumbnail } from '../../ui/show/arrangement-thumbnail'
import { Button } from '../../ui/show/button'
import { NamedIcon } from '../../ui/show/icon'
import { InlineEditText } from '../../ui/show/inline-edit-text/InlineEditText'
import { NameAndCreate } from '../../ui/show/name-and-create'
import { Text } from '../../ui/show/text'
import type { LayoutState } from '../read-data/layout-types'
import { canRedoArrangement, canRestoreArrangement, canUndoArrangement } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/arrangement-history.ts'
import { layoutPicture } from '../read-data/layout-picture'
import { readLayoutPresets } from '../read-data/read-layout-presets'
import { migrateLayoutPresetsToGroups } from '../do-work/migrate-layout-presets-to-groups'
import { deleteArrangementGroup, saveArrangementAsGroup, type GroupSavedLayout } from '../do-work/save-arrangement-as-group'
import {
  announceSavedLayoutsChanged,
  asOwnLayout,
  currentLayoutNeedsName,
  isStarred,
  saveCurrentLayoutAs,
  type LayoutChoice,
} from '../do-work/switch-saved-layout'
import { LayoutActionsContext, LayoutStateContext } from './screen-arrangement-context'
import { OWN_LAYOUTS_INPUT, useLayoutChoices } from './use-layout-choices'
import { LAYOUT_LIBRARY } from 'trillion-workshop/tools/arrange-screens-in-panes/read-data/layout-library.ts'
import { libraryCategories, type LibraryCategory } from '../../group/read-data/kept-library'
import type { GroupGraph } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts'

const boxesOf = (layout: LayoutState) => layoutPicture(layout).map((pane) => ({
  id: pane.id, x: pane.x, y: pane.y, w: pane.w, h: pane.h, icon: pane.icon, label: pane.title,
}))

// The layouts' categories, read through the group part's own door, again whenever the AI's layouts change.
function useLayoutCategories(): LibraryCategory[] {
  const ownLayouts = useBitfieldData(OWN_LAYOUTS_INPUT)
  const [categories, setCategories] = React.useState<LibraryCategory[]>([])
  React.useEffect(() => {
    let current = true
    void sendRequestToBitfieldTarget({ target: 'group.load-graph', payload: { roots: [LAYOUT_LIBRARY.index_ref] } })
      .then((reply) => {
        const answer = JSON.parse(new TextDecoder().decode(reply.payload)) as { graph?: GroupGraph | null }
        if (current) setCategories(answer.graph ? libraryCategories(answer.graph, LAYOUT_LIBRARY) : [])
      })
      .catch(() => { if (current) setCategories([]) })
    return () => { current = false }
  }, [ownLayouts])
  return categories
}

export function LayoutPicker() {
  useShowChange()
  return controlShown('arrangement.layouts') ? <VisibleLayoutPicker /> : null
}

function VisibleLayoutPicker() {
  const layoutState = React.useContext(LayoutStateContext)
  const layoutActions = React.useContext(LayoutActionsContext)
  const { choices, currentSignature, saved, loaded, refresh, takeSaved, open: openChoice } = useLayoutChoices()
  const categories = useLayoutCategories()
  const [openingId, setOpeningId] = React.useState<string | null>(null)
  const [openFailed, setOpenFailed] = React.useState(false)
  const [changeFailed, setChangeFailed] = React.useState(false)
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [menuAt, setMenuAt] = React.useState<{ id: string; point: { x: number; y: number } } | null>(null)
  const [newName, setNewName] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [historyOpen, setHistoryOpen] = React.useState(false)
  const renameField = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // Layouts kept in the old record family move into groups once; the group fold is what this picker draws.
  const legacyPresets = readLayoutPresets(useBitfieldData('layout-presets'))
  const migrationFired = React.useRef(false)
  React.useEffect(() => {
    if (migrationFired.current || legacyPresets.length === 0) return
    migrationFired.current = true
    void migrateLayoutPresetsToGroups(legacyPresets).then(() => refresh())
  }, [legacyPresets, refresh])

  React.useEffect(() => {
    if (renamingId) renameField.current?.focus()
  }, [renamingId])

  if (!layoutState || !layoutActions) return null

  const open = async (entry: LayoutChoice) => {
    if (openingId) return
    setOpenFailed(false)
    setOpeningId(entry.preset.id)
    try {
      await openChoice(entry)
    } catch (error) {
      console.error('Opening the layout failed', error)
      setOpenFailed(true)
    } finally {
      setOpeningId(null)
    }
  }

  const saveCurrent = async () => {
    if (saving || !newName.trim()) return
    setChangeFailed(false)
    setSaving(true)
    try {
      takeSaved(await saveCurrentLayoutAs({ name: newName, currentLayout: layoutState, saved }))
      setNewName('')
    } catch (error) {
      console.error('Saving the layout failed', error)
      setChangeFailed(true)
    } finally {
      setSaving(false)
    }
  }

  const keep = async (preset: GroupSavedLayout) => {
    setChangeFailed(false)
    try {
      await saveArrangementAsGroup(preset.id, preset.name, preset.layout, preset.meta)
      // Every reader on the page, this picker included, reads the layouts again.
      announceSavedLayoutsChanged()
    } catch (error) {
      console.error('Changing the saved layout failed', error)
      setChangeFailed(true)
    }
  }

  const remove = async (preset: GroupSavedLayout) => {
    setChangeFailed(false)
    try {
      await deleteArrangementGroup(preset.id)
      // Every reader on the page, this picker included, reads the layouts again.
      announceSavedLayoutsChanged()
    } catch (error) {
      console.error('Removing the saved layout failed', error)
      setChangeFailed(true)
    }
  }

  const rename = (preset: GroupSavedLayout, name: string) => {
    setRenamingId(null)
    if (name && name !== preset.name) void keep(asOwnLayout(preset, { name }))
  }

  const menuItems = (preset: GroupSavedLayout): ActionMenuItem[] => [
    { id: 'rename', label: 'Rename', icon: 'Pencil' },
    isStarred(preset)
      ? { id: 'unpin', label: 'Unpin', icon: 'PinOff' }
      : { id: 'pin', label: 'Pin to the top', icon: 'Pin' },
    { id: 'remove', label: 'Remove', icon: 'Trash2', tone: 'destructive', group: 'remove' },
  ]

  const runAction = (preset: GroupSavedLayout, action: string) => {
    setMenuAt(null)
    if (action === 'rename') setRenamingId(preset.id)
    else if (action === 'pin' || action === 'unpin') void keep(asOwnLayout(preset, { starred: action === 'pin' }))
    else if (action === 'remove') void remove(preset)
  }

  const thumbnail = (entry: LayoutChoice) => {
    const { preset } = entry
    const selected = entry.signature === currentSignature
    return (
      <ArrangementThumbnail
        key={preset.id}
        name={preset.name}
        boxes={boxesOf(preset.layout)}
        selected={selected}
        disabled={openingId !== null}
        pressLabel={selected ? `${preset.name}, open now` : `Open ${preset.name}`}
        onPress={() => { if (!selected) void open(entry) }}
        onMenuAt={entry.kept ? (point) => setMenuAt({ id: preset.id, point }) : undefined}
        nameEditor={renamingId === preset.id ? (
          <InlineEditText
            ref={renameField}
            value={preset.name}
            variant="body-xs"
            aria-label={`Name for ${preset.name}`}
            onCommit={(name) => rename(preset, name)}
          />
        ) : undefined}
        onNameEditorLeave={() => setRenamingId(null)}
        actions={<>
          {/* Hide this layout from the menu for a while, always or on this device (the person's show rules). */}
          <ShowRuleMenu subject="layout" thing={{ id: preset.id, name: preset.name }} label={`When ${preset.name} shows`} />
          {entry.kept ? (
            <ActionMenu
              label={`Actions for ${preset.name}`}
              items={menuItems(preset)}
              onAction={(action) => runAction(preset, action)}
              trigger={<Button variant="ghost" size="icon-xs" />}
              triggerContent={<NamedIcon name="MoreHorizontal" size="xs" />}
              align="end"
            />
          ) : null}
        </>}
      />
    )
  }

  // Invariant 7: layouts filed in a category under its name; the rest first, with no heading.
  const filed = new Map(categories.flatMap((category) => category.members.map((id) => [id, category.category_id] as const)))
  const sections = [
    { id: '', heading: null as string | null, entries: choices.filter((entry) => !filed.has(entry.preset.id)) },
    ...categories.map((category) => ({ id: category.category_id, heading: category.name, entries: choices.filter((entry) => filed.get(entry.preset.id) === category.category_id) })),
  ].filter((section) => section.entries.length)

  const menuEntry = menuAt ? choices.find((entry) => entry.preset.id === menuAt.id) : null

  return (
    <div className="layout-picker" data-layout-picker aria-label="Layouts" role="group">
      {loaded === 'failed' ? (
        <div className="layout-picker-read-error" role="alert">
          <Text variant="body-xs" color="secondary">Your saved layouts could not be read.</Text>
          <Button variant="ghost" size="xs" onClick={() => refresh()}>Try again</Button>
        </div>
      ) : null}
      <div className="layout-history-actions" role="group" aria-label="Arrangement history">
        <Button
          variant="ghost"
          size="xs"
          aria-label="Undo screen change"
          title={layoutState.arrangementHistory?.entries[layoutState.arrangementHistory.cursor]?.label
            ? `Undo ${layoutState.arrangementHistory.entries[layoutState.arrangementHistory.cursor].label}`
            : 'Undo screen change'}
          disabled={!canUndoArrangement(layoutState.arrangementHistory)}
          onClick={() => layoutActions.undoArrangement()}
        >
          <NamedIcon name="Undo2" size="xs" /> Undo
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Redo screen change"
          title={layoutState.arrangementHistory?.entries[layoutState.arrangementHistory.cursor + 1]?.label
            ? `Redo ${layoutState.arrangementHistory.entries[layoutState.arrangementHistory.cursor + 1].label}`
            : 'Redo screen change'}
          disabled={!canRedoArrangement(layoutState.arrangementHistory)}
          onClick={() => layoutActions.redoArrangement()}
        >
          <NamedIcon name="Redo2" size="xs" /> Redo
        </Button>
        <Button variant="ghost" size="xs" aria-expanded={historyOpen} onClick={() => setHistoryOpen(open => !open)}>
          <NamedIcon name="History" size="xs" /> {historyOpen ? 'Hide history' : 'History'}
        </Button>
      </div>
      {historyOpen && layoutState.arrangementHistory ? (
        <div className="layout-history-list" role="list" aria-label="Previous screen arrangements">
          {[...layoutState.arrangementHistory.entries].map((entry, index) => {
            const current = index === layoutState.arrangementHistory!.cursor
            const time = new Date(entry.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            const label = `${entry.label} · ${time}`
            return (
              <div role="listitem" key={`${entry.ts}-${index}`}>
                {current ? (
                  <Text variant="body-xs" color="secondary" aria-current="true">Current · {label}</Text>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    fullWidth
                    aria-label={`Restore ${label}`}
                    onClick={() => { layoutActions.restoreArrangementHistory(index); setHistoryOpen(false) }}
                  >
                    <NamedIcon name="CornerUpLeft" size="xs" /> {label}
                  </Button>
                )}
              </div>
            )
          }).reverse()}
        </div>
      ) : null}
      {sections.map((section) => (
        <React.Fragment key={section.id}>
          {section.heading ? <Text variant="body-xs" color="secondary" data-layout-category={section.id}>{section.heading}</Text> : null}
          <div className="layout-picker-grid">{section.entries.map(thumbnail)}</div>
        </React.Fragment>
      ))}
      {currentSignature !== null && loaded === 'ready' && currentLayoutNeedsName(choices, currentSignature) ? (
        <NameAndCreate
          label="Name this layout"
          value={newName}
          onChange={setNewName}
          onSubmit={() => void saveCurrent()}
          actionLabel="Save layout"
          disabled={!newName.trim() || saving}
        />
      ) : null}
      {openFailed ? (
        <Text variant="body-xs" color="secondary" role="alert">That layout could not be opened. Your screen is as it was.</Text>
      ) : null}
      {changeFailed ? (
        <Text variant="body-xs" color="secondary" role="alert">That change could not be confirmed. Try again.</Text>
      ) : null}
      {menuAt && menuEntry ? (
        <ActionMenu
          label={`Actions for ${menuEntry.preset.name}`}
          items={menuItems(menuEntry.preset)}
          onAction={(action) => runAction(menuEntry.preset, action)}
          open
          anchorPoint={menuAt.point}
          align="start"
          onOpenChange={(next) => { if (!next) setMenuAt(null) }}
        />
      ) : null}
    </div>
  )
}
