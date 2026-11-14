// parts/ui/show/record-views/view-designs.ts
//
// NO PRIOR: searched bitfield-packages/packages/*/show for "designed view", "view design", "custom view",
//   "view template", "layout template" (none), and 21st.dev for reusable list view templates (only fixed tables and
//   calendars). The designs drawn through this seam are the existing shared parts (coss/thread, coss/guide).
//
// PURPOSE
//   Designed views: a view of a list is a DATA row ({ id, label, icon, design, slots, options }) that names a design (a
//   way of drawing records: a chat, a feed, guide rows, anything a part registers) and says which of the list's fields
//   fill the design's slots (the title, the words, who wrote it, a status). A design made once is a row, so it is
//   offered on every list whose fields can fill it, and a person's own rows (kept as their record
//   `workspace-preference:designed-views`) are offered beside the rows a part ships.
//
// NON-NEGOTIABLE INVARIANTS
//   1. This file names no design and no list: a design is registered by the part that draws it (registerViewDesign),
//      and a row is DATA. A row naming a design nobody registered is not offered.
//   2. A slot is filled by the field a row names for it (`slots`), else by the field whose descriptor declares that
//      role (`FieldDescriptor.role`), else by the generic fallback below (the first field names a record, the first
//      document is its body, the first date says when, the first field whose declared values carry a tone is its status, the next two fields with
//      declared values are a grid's axes, the first thumbnail is its picture). Never by a field's id.
//   3. A row is offered only to a list whose fields fill every slot it `needs`.

import type {ReactNode} from 'react'
import type {FieldDescriptor, RecordView, RecordViewContext} from './record-views'
import {dayStart, isWholeDay} from '../schedule-calendar/schedule-placement.mjs'
import type {ScrollFadeEdge} from '../scrollable-surface/scroll-fade'

/** One designed view, as DATA. `slots` maps a slot to a field id of a particular list; left out, roles decide. */
export type DesignedViewRow = {
  id: string
  label: string
  icon?: string
  design: string
  slots?: Record<string, string>
  needs?: readonly string[]
  /** Which edges fade while records run past them (RecordView.fadeEdges); top and bottom when left out. A design that
   *  scrolls itself, a board say, names none. */
  fade_edges?: readonly ScrollFadeEdge[]
  options?: Record<string, unknown>
}

/** What a design draws from: the list's context, its own row, and the field filling each slot. */
export type SlotFields = Record<string, FieldDescriptor | undefined>
export type ViewDesignProps = {context: RecordViewContext; row: DesignedViewRow}
export type ViewDesign = (props: ViewDesignProps) => ReactNode

/** Where a person's own designed views are kept: one of their records, read on every list. */
export const DESIGNED_VIEWS_PREFERENCE = 'designed-views'

const designs = new Map<string, ViewDesign>()

/** Registers how one design draws. Registering the same id again replaces it. */
export function registerViewDesign(id: string, design: ViewDesign) { designs.set(id, design) }
export function viewDesign(id: string): ViewDesign | undefined { return designs.get(id) }

const isDate = (field: FieldDescriptor) => field.kind === 'date' || field.ruleKind === 'date'
const declaresValues = (field: FieldDescriptor) => Boolean(field.values && Object.keys(field.values).length)
const isWords = (field: FieldDescriptor) => (field.ruleKind ?? 'text') === 'text' && !isDate(field) && !declaresValues(field)

// A status reads as a tone: the first field whose declared values carry one, else the first with declared values that
// plays no other declared part.
const statusOf = (fields: FieldDescriptor[]) => fields.slice(1).find(field => declaresValues(field) && Object.values(field.values!).some(value => value.tone))
  ?? fields.slice(1).find(field => declaresValues(field) && !field.role)

// The fallback for a slot no row names and no field declares: generic facts every list's fields carry.
const FALLBACK: Record<string, (fields: FieldDescriptor[]) => FieldDescriptor | undefined> = {
  title: fields => fields[0],
  when: fields => fields.find(isDate),
  status: fields => statusOf(fields),
  detail: fields => fields.slice(1).find(field => isWords(field) && field.kind !== 'tag'),
  // A record's body: the first field holding a document (its notes), the words a thread, an inbox or a document reads.
  body: fields => fields.find(field => field.document),
  // A grid's two axes: the first two fields with declared values that are not the status, no date and play no declared
  // part, so a list with a priority and an effort is a two-by-two of them.
  across: fields => axisFields(fields)[0],
  down: fields => axisFields(fields)[1],
  // A picture: the first field drawn as one.
  picture: fields => fields.find(field => field.kind === 'thumbnail'),
}

function axisFields(fields: FieldDescriptor[]): FieldDescriptor[] {
  const status = statusOf(fields)
  return fields.slice(1).filter(field => declaresValues(field) && field !== status && !isDate(field) && !field.role)
}

/** The field filling one slot of a row on a list with these fields. */
export function slotField(row: DesignedViewRow, slot: string, fields: FieldDescriptor[]): FieldDescriptor | undefined {
  const named = row.slots?.[slot]
  if (named) return fields.find(field => field.id === named)
  return fields.find(field => field.role === slot) ?? FALLBACK[slot]?.(fields)
}

/** The slots a design reads, filled for this list. */
export function slotFields(row: DesignedViewRow, fields: FieldDescriptor[], wanted: readonly string[]): SlotFields {
  return Object.fromEntries([...new Set([...(row.needs ?? []), ...wanted])].map(slot => [slot, slotField(row, slot, fields)]))
}

/** Whether a list with these fields fills every slot the row needs. */
export function rowFits(row: DesignedViewRow, fields: FieldDescriptor[]): boolean {
  return (row.needs ?? []).every(slot => Boolean(slotField(row, slot, fields)))
}

/** A person's kept rows, read defensively: anything that is not a row is left out. */
export function keptRows(value: unknown): DesignedViewRow[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is DesignedViewRow => Boolean(row) && typeof row === 'object'
    && typeof (row as DesignedViewRow).id === 'string' && typeof (row as DesignedViewRow).label === 'string' && typeof (row as DesignedViewRow).design === 'string')
}

/** A field's raw value on a record, the way the list itself reads it. */
export function valueOf(field: FieldDescriptor | undefined, record: any): unknown {
  return field ? (field.read ? field.read(record) : record?.[field.id]) : undefined
}

/** The lines a list's own fields draw between its records: each field declaring `links` holds the ids of records of the
 *  same list this one came from (`from`: a line from that record into this one) or leads to (`to`). Ids naming no
 *  record of `records`, and a record naming itself, draw nothing. */
export function recordLinks(records: any[], fields: FieldDescriptor[], identify: (record: any) => string): {from: string; to: string}[] {
  const linking = fields.filter(field => field.links)
  if (!linking.length) return []
  const ids = new Set(records.map(identify))
  const lines: {from: string; to: string}[] = []
  for (const record of records) {
    const id = identify(record)
    for (const field of linking) {
      const value = valueOf(field, record)
      const others = (Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]).map(String)
      for (const other of others) {
        if (other === id || !ids.has(other)) continue
        lines.push(field.links!.direction === 'from' ? {from: other, to: id} : {from: id, to: other})
      }
    }
  }
  return lines
}

/** A field's value as a when: a whole day ("YYYY-MM-DD") stays that day, never a UTC instant that would fall on the
 * evening before west of UTC; any other date becomes an instant (an ISO time), from the fact a date compares when it
 * has one; null when it holds none. */
export function instantOf(field: FieldDescriptor | undefined, record: any): string | null {
  if (!field) return null
  const raw = valueOf(field, record)
  if (isWholeDay(raw)) return raw
  const fact = field.factValue?.(record)
  const value = typeof fact === 'number' ? fact : valueOf(field, record)
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : typeof value === 'number' || typeof value === 'string' ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** The tone a field's declared value carries for a record (the colour its tag and card are drawn in). */
export function toneOf(field: FieldDescriptor | undefined, record: any): string | undefined {
  const value = valueOf(field, record)
  return value === null || value === undefined ? undefined : field?.values?.[String(value)]?.tone
}

/** Whether a view may write a field's value: the list keeps changes and the field is not marked as worked out. */
export function writable(context: RecordViewContext, field: FieldDescriptor | undefined): field is FieldDescriptor {
  return Boolean(context.write && field && field.editable !== false)
}

/** A field's value as words, the way every view reads a value it only shows. */
export function wordsOf(field: FieldDescriptor | undefined, record: any): string {
  if (!field) return ''
  const value = valueOf(field, record)
  const dated = isDate(field)
  const one = (item: unknown): string => {
    if (item === null || item === undefined) return ''
    // A whole day is that local day with no time (a Date would read it as UTC midnight, the evening before west of UTC).
    if (dated && isWholeDay(item)) return dayStart(item as string).toLocaleDateString(undefined, {dateStyle: 'medium'})
    if (dated && (typeof item === 'string' || typeof item === 'number') && Number.isFinite(new Date(item).getTime())) return new Date(item).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'})
    if (Array.isArray(item)) return item.map(one).filter(Boolean).join(', ')
    if (item instanceof Date) return item.toLocaleDateString()
    if (typeof item === 'object') return String((item as any).label ?? (item as any).name ?? (item as any).title ?? '')
    const named = field.values?.[String(item)]?.label
    return named ?? String(item)
  }
  return one(value)
}

/** A row as one entry of a list's view switch: offered where its slots fit, drawn by its design. */
export function designedRecordView(row: DesignedViewRow): RecordView | null {
  const design = viewDesign(row.design)
  if (!design) return null
  return {
    id: row.id,
    label: row.label,
    icon: row.icon,
    fadeEdges: row.fade_edges ?? ['top', 'bottom'],
    designed: row,
    offeredFor: fields => rowFits(row, fields),
    render: context => design({context, row}),
  }
}
