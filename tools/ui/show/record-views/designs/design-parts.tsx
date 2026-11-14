// parts/ui/show/record-views/designs/design-parts.tsx
//
// PURPOSE
//   The two pieces several designs draw with: a record's card (`DesignCard`: its picture, title, status and words, the
//   title opening the record) and a grid of cells records are placed in (`PlacedCells`: columns across the top, rows
//   down the side or headed above, each cell holding the records that belong in it). Dragging a card to another cell,
//   or moving a focused card with the arrow keys, reports the cell it now belongs in; the design turns that into the
//   values it writes. The Matrix (two fields across and down) and Sprints (periods down, status across) are this grid.
//   Anatomy: the kanban boards on 21st.dev (components 1088 and 29372: drag between columns, a keyboard path that moves
//   a card without dragging, the cell a card is over drawn ringed).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word: cells, cards and words all come from the design that draws them.
//   2. A card moves only where the list keeps changes (`onPlace` given); a drop on the cell a card is already in reports
//      nothing.
//   3. Every visible word is the caller's.

import * as React from 'react'
import {Button} from '../../coss/ui/button'
import {Badge, badgeVariantForTone} from '../../coss/ui/badge'
import {ImageBlock} from '../../image-block/ImageBlock'
import {toneOf, valueOf, wordsOf, type SlotFields} from '../view-designs'
import type {RecordViewContext} from '../record-views'

/** A picture a field holds: an address it reads as, or the address its object names. */
const pictureOf = (value: unknown): string | undefined => {
  if (typeof value === 'string' && /^(https?:|data:image\/|blob:|\/)/.test(value)) return value
  if (value && typeof value === 'object') {
    for (const key of ['src', 'url', 'thumbnail']) if (typeof (value as any)[key] === 'string') return pictureOf((value as any)[key])
  }
  return undefined
}

/** One record as a card: its picture (when a field holds one), title (pressing it opens the record), status and words. */
export function DesignCard({context, slots, record, size = 'small', ...rest}: {
  context: RecordViewContext
  slots: SlotFields
  record: any
  size?: 'small' | 'large'
} & Omit<React.HTMLAttributes<HTMLElement>, 'children'>) {
  const id = context.identify(record)
  const title = wordsOf(slots.title, record) || id
  const status = wordsOf(slots.status, record)
  const tone = toneOf(slots.status, record)
  const detail = wordsOf(slots.body ?? slots.detail, record)
  const address = pictureOf(valueOf(slots.picture, record))
  const picture = slots.picture?.render?.(record) ?? (address ? <ImageBlock src={address} alt="" objectFit="cover" rounded="lg" width="full" loading="lazy"/> : null)
  return (
    <article className="record-views-design-card" data-size={size} data-record-id={id} aria-label={title} {...rest}>
      {picture ? <div className="record-views-design-card-picture">{picture}</div> : null}
      <header className="record-views-design-card-head">
        {context.open
          ? <Button type="button" variant="ghost" size={size === 'large' ? 'default' : 'xs'} className="record-views-design-card-title" onClick={() => context.open!(id)}>{title}</Button>
          : <span className="record-views-design-card-title">{title}</span>}
        {status ? <Badge variant={badgeVariantForTone(tone)} data-tone={tone}>{status}</Badge> : null}
      </header>
      {detail ? <p className="record-views-design-card-detail">{detail}</p> : null}
    </article>
  )
}

/** One cell's place: its row's key and its column's key ('' for the records holding no value). */
export type CellPlace = {row: string; column: string}
export type PlacedRow = {key: string; label?: React.ReactNode; header?: React.ReactNode; current?: boolean}
export type PlacedColumn = {key: string; label: React.ReactNode}
export type CardHandlers = React.HTMLAttributes<HTMLElement> & {draggable?: boolean}

const STEPS: Record<string, readonly [number, number]> = {ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0]}

/** A grid of cells records are placed in. `placeOf` says which cell a record belongs in (null: none on this grid);
 *  `onPlace` keeps a card moved to another cell. */
export function PlacedCells({label, rows, columns, records, identify, placeOf, renderCard, onPlace, corner, moving}: {
  label: string
  rows: PlacedRow[]
  columns: PlacedColumn[]
  records: any[]
  identify: (record: any) => string
  placeOf: (record: any) => CellPlace | null
  renderCard: (record: any, handlers: CardHandlers) => React.ReactNode
  onPlace?: (record: any, to: CellPlace) => unknown
  corner?: React.ReactNode
  /** Read aloud while a card is held over a cell or moved to one: the card's name and the cell's words. */
  moving?: (record: any, to: CellPlace) => string
}) {
  const [held, setHeld] = React.useState<string | null>(null)
  const [over, setOver] = React.useState<CellPlace | null>(null)
  const [said, setSaid] = React.useState('')
  const byId = React.useMemo(() => new Map(records.map(record => [identify(record), record])), [records, identify])
  const cells = React.useMemo(() => {
    const placed = new Map<string, any[]>()
    for (const record of records) {
      const place = placeOf(record)
      if (!place) continue
      const key = `${place.row}\u0000${place.column}`
      placed.set(key, [...(placed.get(key) ?? []), record])
    }
    return placed
  }, [records, placeOf])
  const sideLabels = rows.some(row => row.label !== undefined)
  const place = (record: any, to: CellPlace) => {
    const from = placeOf(record)
    if (!onPlace || (from && from.row === to.row && from.column === to.column)) return
    if (moving) setSaid(moving(record, to))
    void onPlace(record, to)
  }
  const handlersFor = (record: any): CardHandlers => onPlace ? {
    draggable: true,
    tabIndex: 0,
    onDragStart: event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', identify(record)); setHeld(identify(record)) },
    onDragEnd: () => { setHeld(null); setOver(null) },
    // Arrow keys move a focused card to the next cell that way, so a card moves without dragging.
    onKeyDown: event => {
      const step = STEPS[event.key]
      const from = placeOf(record)
      if (!step || !from || event.target !== event.currentTarget) return
      const row = rows.findIndex(item => item.key === from.row) + step[0]
      const column = columns.findIndex(item => item.key === from.column) + step[1]
      if (row < 0 || row >= rows.length || column < 0 || column >= columns.length) return
      event.preventDefault()
      place(record, {row: rows[row]!.key, column: columns[column]!.key})
    },
  } : {}
  const cellHandlers = (to: CellPlace) => onPlace ? {
    onDragOver: (event: React.DragEvent) => {
      if (!held) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      if (over?.row === to.row && over?.column === to.column) return
      setOver(to)
      const record = byId.get(held)
      if (record && moving) setSaid(moving(record, to))
    },
    onDrop: (event: React.DragEvent) => {
      const record = held ? byId.get(held) : undefined
      setHeld(null)
      setOver(null)
      if (!record) return
      event.preventDefault()
      place(record, to)
    },
  } : {}
  return (
    <div className="record-views-placed" role="region" aria-label={label} data-side-labels={sideLabels ? 'true' : undefined}
      style={{'--placed-columns': columns.length} as React.CSSProperties}>
      <div className="record-views-placed-row" data-heading="true">
        {sideLabels ? <div className="record-views-placed-corner">{corner}</div> : null}
        {columns.map(column => <div key={column.key} className="record-views-placed-column-label">{column.label}</div>)}
      </div>
      {rows.map(row => (
        <React.Fragment key={row.key}>
          {row.header ? <div className="record-views-placed-row-header" data-row-header={row.key} data-current={row.current ? 'true' : undefined}>{row.header}</div> : null}
          <div className="record-views-placed-row" data-row={row.key}>
            {sideLabels ? <div className="record-views-placed-row-label">{row.label}</div> : null}
            {columns.map(column => {
              const to = {row: row.key, column: column.key}
              const members = cells.get(`${row.key}\u0000${column.key}`) ?? []
              return (
                <div key={column.key} className="record-views-placed-cell" data-cell={`${row.key}/${column.key}`}
                  data-drop-target={over?.row === row.key && over?.column === column.key ? 'true' : undefined} {...cellHandlers(to)}>
                  {members.map(record => <React.Fragment key={identify(record)}>{renderCard(record, handlersFor(record))}</React.Fragment>)}
                </div>
              )
            })}
          </div>
        </React.Fragment>
      ))}
      <p role="status" aria-live="polite" className="sr-only">{said}</p>
    </div>
  )
}
