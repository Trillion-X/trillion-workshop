// Shared row actions draw only caller-supplied data; they have no account-store dependency.
// Extracted unchanged from record-views.tsx; its Twenty CRM AGPL-3.0 provenance remains applicable.
import React from 'react'
import {ActionMenu, type ActionMenuItem, type MenuThing} from '../action-menu'
import type {BulkAction} from './record-views'

export function RowActionMenu({actions, record, id, name, about, stopPropagation = false}: {actions: BulkAction[]; record: any; id: string; name: string; about?: MenuThing; stopPropagation?: boolean}) {
  const [open, setOpen] = React.useState(false)
  const [loaded, setLoaded] = React.useState<Record<string, readonly ActionMenuItem[]>>({})
  const available = actions.filter(action => !action.appliesTo || action.appliesTo(record))
  // Choices are read each time the menu opens (they may need loading), and the
  // submenu shows them as soon as they arrive.
  React.useEffect(() => {
    if (!open) return
    let live = true
    for (const action of available) {
      if (!action.choices) continue
      Promise.resolve(action.choices(record)).then(rows => { if (live) setLoaded(current => ({...current, [action.id]: rows})) }, () => {})
    }
    return () => { live = false }
    // Reading once per opening is the contract; the record identity is `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, id])
  const chosen = new Map<string, {action: BulkAction; choiceId: string}>()
  const nest = (action: BulkAction, rows: readonly ActionMenuItem[], path: string): ActionMenuItem[] => rows.map(row => {
    const key = `${path}\u241f${row.id}`
    if (!row.items?.length) chosen.set(key, {action, choiceId: row.id})
    return {...row, id: key, ...(row.items?.length ? {items: nest(action, row.items, key)} : {})}
  })
  if (!available.length && !about) return null
  return (
    <ActionMenu
      label={`Actions for ${name}`}
      about={about}
      items={available.map(action => {
        const nested = action.choices ? loaded[action.id] : null
        return {id: action.id, label: action.label, icon: action.icon || 'sparkles', tone: action.tone, shortcut: action.shortcut, confirm: action.confirm,
          ...(action.choices ? {items: nested?.length ? nest(action, nested, action.id) : [{id: `${action.id}\u241floading`, label: 'Loading…', icon: 'loader', disabled: true}]} : {})}
      })}
      onOpenChange={setOpen}
      triggerProps={{size: 'sm', ...(stopPropagation ? {onClick: (event: React.MouseEvent) => event.stopPropagation()} : {})}}
      onAction={actionId => {
        const nested = chosen.get(actionId)
        if (nested) nested.action.choose?.([id], nested.choiceId)
        else available.find(action => action.id === actionId)?.run([id])
      }}
    />
  )
}
