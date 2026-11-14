// parts/ui/show/record-views/designs/matrix-design.tsx
//
// PURPOSE
//   The `matrix` design (../view-designs): any list with two fields of declared values as a grid of them, one field
//   across the top (`across`) and one down the side (`down`): a two-by-two of urgent and important, effort and impact,
//   or any pair a list holds. Each cell holds the cards (./design-parts DesignCard) of the records with both values;
//   records missing a value sit in a column or row of their own (`options.unset`). Dragging a card to another cell, or
//   moving it there with the arrow keys, writes both values through the list when it keeps changes.
//   The idea is the canvas's two-facet arrangement (parts/group/show/arrange-matrix.ts, which places cards on a canvas
//   by pixel); here the same cross-tab is a grid of cells that grow with what they hold.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or value word: the axes are the fields filling the slots, their values in the order each field
//      declares them; every other word is the row's options.
//   2. A move writes the two values of the cell it lands in (null for the column or row of records with none), and only
//      the values that change.

import * as React from 'react'
import {DesignCard, PlacedCells, type CellPlace} from './design-parts'
import {slotFields, valueOf, wordsOf, writable, type ViewDesignProps} from '../view-designs'
import type {FieldDescriptor} from '../record-views'

type MatrixOptions = {unset?: string; moving?: string; empty?: string}

const SLOTS = ['across', 'down', 'title', 'status', 'detail', 'picture'] as const
const keyOf = (field: FieldDescriptor, record: any) => {
  const value = valueOf(field, record)
  return value === null || value === undefined || value === '' ? '' : String(value)
}
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')

/** A field's values in the order it declares them, then any value records hold that it does not declare, then the
 *  records holding none ('') when there are some. */
function axisKeys(field: FieldDescriptor, records: any[]): string[] {
  const held = new Set(records.map(record => keyOf(field, record)))
  const declared = Object.keys(field.values ?? {})
  return [...declared, ...[...held].filter(key => key && !declared.includes(key)).sort(), ...(held.has('') ? [''] : [])]
}

export function MatrixDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as MatrixOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const across = slots.across!
  const down = slots.down!
  const words = (field: FieldDescriptor, key: string) => (key ? field.values?.[key]?.label ?? key : options.unset ?? 'None')
  const columns = React.useMemo(() => axisKeys(across, context.records).map(key => ({key, label: words(across, key)})), [across, context.records])
  const rows = React.useMemo(() => axisKeys(down, context.records).map(key => ({key, label: words(down, key)})), [down, context.records])
  const placeOf = React.useCallback((record: any): CellPlace => ({row: keyOf(down, record), column: keyOf(across, record)}), [across, down])
  const keeps = writable(context, across) && writable(context, down)
  const place = (record: any, to: CellPlace) => {
    const from = placeOf(record)
    const values: Record<string, unknown> = {}
    if (from.column !== to.column) values[across.id] = to.column || null
    if (from.row !== to.row) values[down.id] = to.row || null
    return context.write!([{id: context.identify(record), values}])
  }
  if (!context.records.length) return <p className="record-views-design-empty">{options.empty ?? 'Nothing here yet.'}</p>
  return (
    <section className="record-views-design record-views-matrix" data-design={row.design} aria-label={context.label}>
      <PlacedCells
        label={context.label}
        rows={rows}
        columns={columns}
        records={context.records}
        identify={context.identify}
        placeOf={placeOf}
        corner={<span className="record-views-matrix-axes">{`${down.label} / ${across.label}`}</span>}
        renderCard={(record, handlers) => <DesignCard context={context} slots={slots} record={record} {...handlers}/>}
        {...(keeps ? {onPlace: place} : {})}
        moving={(record, to) => fill(options.moving ?? '{title}: {across} and {down}', {
          title: wordsOf(slots.title, record), across: words(across, to.column), down: words(down, to.row),
        })}
      />
    </section>
  )
}
