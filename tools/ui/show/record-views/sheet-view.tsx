// packages/ui/show/record-views/sheet-view.tsx
//
// Purpose
//   The records as a dense spreadsheet: numbered rows, one column per shown
//   field, and one selected cell whose value reads in full in a bar above the
//   grid, the way a spreadsheet's formula bar does. Arrow keys, Tab, Home, End
//   and Page Up / Down move the selected cell; Enter opens the cell's record.
//
// Non-negotiable invariants
//   - Blind: the fields, their words and the cell drawing come from the caller
//     (record-views.tsx); no field or record kind is named here.
//   - Only rows on screen are drawn. Row height is measured once drawn, so ten
//     thousand rows cost what forty do.
//   - Appearance lives in ../twenty/record-table.css (.record-views-sheet*);
//     the only inline style is geometry (column widths, spacer heights).

import React, {useEffect, useLayoutEffect, useRef, useState} from 'react'
import {offsetsOf, useMeasuredHeight, useScrollWindow, visibleRange} from './windowing'

export type SheetColumn = {id: string; label: string; width: number; align: 'left' | 'center' | 'right'}

export type SheetViewProps = {
  columns: SheetColumn[]
  records: any[]
  identify: (record: any) => string
  /** The cell as drawn in the grid (the same drawing a table cell uses). */
  drawCell: (columnId: string, record: any) => React.ReactNode
  /** The cell's full value as words, for the bar above the grid. */
  cellText: (columnId: string, record: any) => string
  selected: ReadonlySet<string>
  /** The selected cell moved to another record: that record becomes the selection. */
  onPickRecord: (id: string) => void
  onOpen?: (id: string) => void
  label: string
}

/** A spreadsheet column name for a position: A, B, … Z, AA, AB, … */
export function columnName(index: number): string {
  let name = ''
  for (let at = index + 1; at > 0; at = Math.floor((at - 1) / 26)) name = String.fromCharCode(65 + ((at - 1) % 26)) + name
  return name
}

export function SheetView({columns, records, identify, drawCell, cellText, selected, onPickRecord, onOpen, label}: SheetViewProps) {
  const [cell, setCell] = useState<{row: number; column: number}>({row: 0, column: 0})
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const grid = useRef<HTMLTableElement | null>(null)
  const seen = useScrollWindow(host, 600)
  const rowHeight = useMeasuredHeight(host, 'tbody tr[data-sheet-row]', 28, null, true)
  const headerHeight = useMeasuredHeight(host, 'thead', 28, null)
  const offsets = offsetsOf(records.map(() => rowHeight))
  const [from, to] = visibleRange(offsets, seen.top - headerHeight, seen.bottom - headerHeight)

  // The cell stays inside the grid when records or columns change under it.
  const row = Math.min(cell.row, Math.max(0, records.length - 1))
  const column = Math.min(cell.column, Math.max(0, columns.length - 1))
  const current = records[row]
  const currentColumn = columns[column]

  // A record selected elsewhere (a table row, a revealed record) brings the
  // selected cell to its row.
  useEffect(() => {
    if (current && selected.has(identify(current))) return
    const at = records.findIndex(record => selected.has(identify(record)))
    if (at >= 0) setCell(position => ({...position, row: at}))
    // Only a selection change moves the cell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const moveTo = (nextRow: number, nextColumn: number) => {
    const clampedRow = Math.max(0, Math.min(records.length - 1, nextRow))
    const clampedColumn = Math.max(0, Math.min(columns.length - 1, nextColumn))
    setCell({row: clampedRow, column: clampedColumn})
    const record = records[clampedRow]
    if (record && !selected.has(identify(record))) onPickRecord(identify(record))
  }

  // Keep the selected cell on screen, only as far as needed.
  useLayoutEffect(() => {
    grid.current?.querySelector<HTMLElement>('[data-sheet-selected="true"]')?.scrollIntoView?.({block: 'nearest', inline: 'nearest'})
  }, [row, column])

  const keyDown = (event: React.KeyboardEvent) => {
    const page = Math.max(1, Math.floor((seen.bottom - seen.top) / rowHeight) - 2)
    const moves: Record<string, () => void> = {
      ArrowDown: () => moveTo(row + 1, column),
      ArrowUp: () => moveTo(row - 1, column),
      ArrowRight: () => moveTo(row, column + 1),
      ArrowLeft: () => moveTo(row, column - 1),
      Tab: () => moveTo(row, column + (event.shiftKey ? -1 : 1)),
      Home: () => moveTo(event.metaKey || event.ctrlKey ? 0 : row, 0),
      End: () => moveTo(event.metaKey || event.ctrlKey ? records.length - 1 : row, columns.length - 1),
      PageDown: () => moveTo(row + page, column),
      PageUp: () => moveTo(row - page, column),
      Enter: () => { if (current) onOpen?.(identify(current)) },
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    event.stopPropagation()
    move()
  }

  const where = currentColumn && current ? `${columnName(column)}${row + 1}` : ''
  return (
    <div className="record-views-sheet">
      <div className="record-views-sheet-bar" role="group" aria-label="Selected cell">
        <span className="record-views-sheet-address">{where}</span>
        <span className="record-views-sheet-field">{currentColumn?.label ?? ''}</span>
        <output className="record-views-sheet-value" aria-live="polite">{currentColumn && current ? cellText(currentColumn.id, current) : ''}</output>
      </div>
      <div className="record-views-sheet-scroll" ref={setHost}>
        <table
          ref={grid}
          className="record-views-sheet-grid"
          role="grid"
          aria-label={label}
          aria-rowcount={records.length + 1}
          aria-colcount={columns.length + 1}
          tabIndex={0}
          onKeyDown={keyDown}
        >
          <colgroup>
            <col className="record-views-sheet-number-column"/>
            {columns.map(one => <col key={one.id} style={{width: `${one.width}px`}}/>)}
          </colgroup>
          <thead>
            <tr aria-rowindex={1}>
              <th className="record-views-sheet-corner" aria-hidden="true"/>
              {columns.map((one, index) => (
                <th key={one.id} role="columnheader" data-align={one.align} data-sheet-current={index === column ? 'true' : undefined} title={one.label}>
                  <span className="record-views-sheet-letter">{columnName(index)}</span>
                  <span className="record-views-sheet-label">{one.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {from > 0 && <tr aria-hidden="true"><td colSpan={columns.length + 1} style={{height: offsets[from]}}/></tr>}
            {records.slice(from, to).map((record, at) => {
              const index = from + at
              const id = identify(record)
              return (
                <tr key={id} aria-rowindex={index + 2} data-sheet-row="" data-record-id={id} data-selected={selected.has(id) ? 'true' : 'false'}>
                  <th role="rowheader" className="record-views-sheet-number" data-sheet-current={index === row ? 'true' : undefined}>{index + 1}</th>
                  {columns.map((one, columnIndex) => {
                    const chosen = index === row && columnIndex === column
                    return (
                      <td
                        key={one.id}
                        role="gridcell"
                        data-align={one.align}
                        data-sheet-selected={chosen ? 'true' : undefined}
                        aria-selected={chosen}
                        onClick={() => moveTo(index, columnIndex)}
                        onDoubleClick={() => onOpen?.(id)}
                      >
                        <span className="record-views-sheet-cell">{drawCell(one.id, record)}</span>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {to < records.length && <tr aria-hidden="true"><td colSpan={columns.length + 1} style={{height: offsets[records.length]! - offsets[to]!}}/></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
