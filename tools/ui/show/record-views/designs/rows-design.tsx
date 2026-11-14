// parts/ui/show/record-views/designs/rows-design.tsx
//
// PORTED FROM: parts/ui/show/coss/guide.tsx (the guide's sections of rows: a title, a line under it, a status at the
//   right and the row's own buttons), the look the Tours screen was drawn in; this file only reads a list's records
//   into those rows, so that look is a view of any list.
//
// PURPOSE
//   The `rows` design (../view-designs): one row per record (its `title` slot, `detail` under it, `status` as a tone
//   at the right), sectioned by the grouping the person chose in the view bar (or the row's `section` slot), each
//   record's lead actions as its buttons and Open when the list opens records.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word here: slots come from the row, sections from the grouping, words from the list.
//   2. Sections follow the order the grouping field declares its values, then the order records first name them.
//   3. A button runs the list's own row action for that one record; nothing else is invented.

import * as React from 'react'
import {Guide, type GuideAction, type GuideRow, type GuideSection} from '../../coss/guide'
import {slotFields, wordsOf, type ViewDesignProps} from '../view-designs'

type RowsOptions = {open?: string; empty?: string}

const SLOTS = ['title', 'detail', 'status', 'section'] as const

export function RowsDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as RowsOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const {records, identify, rowActions = [], open} = context
  const sectionField = context.fields.find(field => field.id === context.groupLevels?.[0]?.field) ?? slots.section
  const runs = React.useRef(new WeakMap<GuideAction, () => unknown>())
  const sections = React.useMemo((): GuideSection[] => {
    const rowOf = (record: any): GuideRow => {
      const id = identify(record)
      const status = slots.status ? (() => {
        const raw = slots.status!.read ? slots.status!.read(record) : record?.[slots.status!.id]
        const label = wordsOf(slots.status, record)
        return label ? {label, ...(slots.status!.values?.[String(raw)]?.tone ? {tone: slots.status!.values![String(raw)]!.tone} : {})} : undefined
      })() : undefined
      const actions: GuideAction[] = rowActions.filter(action => action.lead && (!action.appliesTo || action.appliesTo(record))).map(action => {
        const made: GuideAction = {label: action.label, icon: action.icon}
        runs.current.set(made, () => action.run([id]))
        return made
      })
      if (open && options.open) { const made: GuideAction = {label: options.open, tone: 'quiet'}; runs.current.set(made, () => open(id)); actions.push(made) }
      return {id, title: wordsOf(slots.title, record), ...(wordsOf(slots.detail, record) ? {detail: wordsOf(slots.detail, record)} : {}), ...(status ? {status} : {}), ...(actions.length ? {actions} : {})}
    }
    if (!sectionField) return [{rows: records.map(rowOf)}]
    const declared = Object.keys(sectionField.values ?? {})
    const buckets = new Map<string, any[]>(declared.map(value => [value, []]))
    for (const record of records) {
      const raw = sectionField.read ? sectionField.read(record) : record?.[sectionField.id]
      const key = raw === null || raw === undefined || raw === '' ? '' : String(raw)
      buckets.set(key, [...(buckets.get(key) ?? []), record])
    }
    return [...buckets].filter(([, members]) => members.length).map(([key, members]) => ({
      ...(key ? {heading: sectionField.values?.[key]?.label ?? key} : {}),
      rows: members.map(rowOf),
    }))
  }, [records, identify, rowActions, open, options.open, slots.title, slots.detail, slots.status, sectionField])
  if (!records.length) return null
  return (
    <div className="record-views-design" data-design={row.design}>
      <Guide description={{title: context.label, hide_header: true, sections}} onAction={async action => { await runs.current.get(action)?.() }}/>
    </div>
  )
}
