// parts/ui/show/record-views/designs/sprints-design.tsx
//
// PURPOSE
//   The `sprints` design (../view-designs): any list with a date (`when`) and a status as periods of work, the way a
//   team works in sprints. Records are gathered into periods of `options.period_days` days by their date (the first
//   period starts on the week's first day, `options.week_starts_on`, of the earliest record); each period is a row of
//   status columns in the order the status field declares its values, headed by its dates, how many of its records are
//   done and a bar of that share. Records with no date sit in a last row (`options.undated`). Dragging a card to
//   another column sets its status; to another period, moves its date by whole periods (a record with no date takes
//   the period's first day); both are written through the list when it keeps changes.
//   What counts as done is the one rule every list view reads (trillion-workshop/tools/keep-lists-of-rows/source-data/
//   views-offered-to-every-list.json `done`, through doneValuesOf).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or status word: columns are the status field's declared values, every other word the row's
//      options.
//   2. Periods are counted in local days, so a period never slips across a clock change.
//   3. A move writes only the values that change: the status for another column, the date for another period.

import * as React from 'react'
import {ProgressBar} from '../../progress-bar'
import {DesignCard, PlacedCells, type CellPlace, type PlacedRow} from './design-parts'
import {instantOf, slotFields, valueOf, wordsOf, writable, type ViewDesignProps} from '../view-designs'
import {addDays, dayDropTime, dayKey, dayOf as dayOfWhen, dayStart, isWholeDay, shiftWhen, weekStart} from '../../schedule-calendar/schedule-placement.mjs'
import {doneValuesOf} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database-input-from-list.ts'
import offeredToEveryList from 'trillion-workshop/tools/keep-lists-of-rows/source-data/views-offered-to-every-list.json'
import type {FieldDescriptor} from '../record-views'

type SprintOptions = {period_days?: number; week_starts_on?: number; undated?: string; unset?: string; done?: string; moving?: string; empty?: string}

const SLOTS = ['when', 'status', 'title', 'detail', 'picture'] as const
const UNDATED = 'undated'
const DONE = {done_tones: offeredToEveryList.done.tones, done_values: offeredToEveryList.done.values}
const DAY_MS = 86_400_000
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
const statusKey = (field: FieldDescriptor, record: any) => {
  const value = valueOf(field, record)
  return value === null || value === undefined || value === '' ? '' : String(value)
}
/** Whole local days from one day key to another. */
const daysBetween = (from: string, to: string) => Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / DAY_MS)
const short = (key: string) => dayStart(key).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})

export function SprintsDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as SprintOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const when = slots.when!
  const status = slots.status!
  const length = Math.max(1, Math.floor(options.period_days ?? 14))
  const done = React.useMemo(() => new Set(doneValuesOf(status, DONE)), [status])
  const dayOf = React.useCallback((record: any) => dayOfWhen(instantOf(when, record)), [when])
  const start = React.useMemo(() => {
    const days = context.records.map(dayOf).filter((key): key is string => Boolean(key)).sort()
    return days.length ? weekStart(days[0]!, options.week_starts_on ?? 1) : null
  }, [context.records, dayOf, options.week_starts_on])
  const periodOf = React.useCallback((record: any) => {
    const day = dayOf(record)
    return day && start ? String(Math.floor(daysBetween(start, day) / length)) : UNDATED
  }, [dayOf, start, length])
  const placeOf = React.useCallback((record: any): CellPlace => ({row: periodOf(record), column: statusKey(status, record)}), [periodOf, status])

  const columns = React.useMemo(() => {
    const declared = Object.keys(status.values ?? {})
    const held = new Set(context.records.map(record => statusKey(status, record)))
    const keys = [...declared, ...[...held].filter(key => key && !declared.includes(key)).sort(), ...(held.has('') ? [''] : [])]
    return keys.map(key => ({key, label: key ? status.values?.[key]?.label ?? key : options.unset ?? 'No status'}))
  }, [status, context.records, options.unset])

  const today = dayKey(new Date())
  const rows = React.useMemo((): PlacedRow[] => {
    const members = new Map<string, any[]>()
    for (const record of context.records) members.set(periodOf(record), [...(members.get(periodOf(record)) ?? []), record])
    // The periods holding records, and the one holding today, in order: an empty stretch between them is not drawn.
    const current = start ? Math.floor(daysBetween(start, today) / length) : null
    const shown = [...new Set([...[...members.keys()].filter(key => key !== UNDATED).map(Number), ...(current === null ? [] : [current])])].sort((a, b) => a - b)
    const header = (title: string, records: any[]) => {
      const finished = records.filter(record => done.has(statusKey(status, record))).length
      const share = records.length ? Math.round((finished / records.length) * 100) : 0
      return (
        <div className="record-views-sprint-head">
          <span className="record-views-sprint-title">{title}</span>
          <span className="record-views-sprint-count">{fill(options.done ?? '{done} of {count} done', {done: String(finished), count: String(records.length)})}</span>
          <ProgressBar className="record-views-sprint-progress" percentage={share} color="var(--record-kind-green, var(--color-success))" aria-label={`${share}%`}/>
        </div>
      )
    }
    const periods: PlacedRow[] = start ? shown.map(index => {
      const from = addDays(start, index * length)
      const to = addDays(from, length - 1)
      return {key: String(index), header: header(`${short(from)} – ${short(to)}`, members.get(String(index)) ?? []), current: index === current}
    }) : []
    return members.has(UNDATED) ? [...periods, {key: UNDATED, header: header(options.undated ?? 'No date', members.get(UNDATED)!)}] : periods
  }, [context.records, periodOf, start, length, done, status, options.done, options.undated, today])

  // The current period is the one in view when the sprints are first drawn.
  const host = React.useRef<HTMLElement>(null)
  React.useEffect(() => {
    host.current?.querySelector('[data-current="true"]')?.scrollIntoView?.({block: 'nearest'})
  }, [])

  const keeps = writable(context, status) && writable(context, when)
  const place = (record: any, to: CellPlace) => {
    const from = placeOf(record)
    const values: Record<string, unknown> = {}
    if (from.column !== to.column) values[status.id] = to.column || null
    if (from.row !== to.row) {
      const at = instantOf(when, record)
      if (to.row === UNDATED) values[when.id] = null
      else if (at && from.row !== UNDATED) values[when.id] = shiftWhen(at, (Number(to.row) - Number(from.row)) * length)
      // A record given its first date takes a whole day when its dated neighbours hold whole days, else the default time.
      else if (start) {
        const key = addDays(start, Number(to.row) * length)
        values[when.id] = isWholeDay(context.records.map(other => instantOf(when, other)).find(Boolean)) ? key : dayDropTime(key, null)
      }
    }
    return context.write!([{id: context.identify(record), values}])
  }

  if (!context.records.length) return <p className="record-views-design-empty">{options.empty ?? 'Nothing here yet.'}</p>
  return (
    <section ref={host} className="record-views-design record-views-sprints" data-design={row.design} aria-label={context.label}>
      <PlacedCells
        label={context.label}
        rows={rows}
        columns={columns}
        records={context.records}
        identify={context.identify}
        placeOf={placeOf}
        renderCard={(record, handlers) => <DesignCard context={context} slots={{...slots, status: undefined}} record={record} {...handlers}/>}
        {...(keeps ? {onPlace: place} : {})}
        moving={(record, to) => fill(options.moving ?? '{title}: {status}', {
          title: wordsOf(slots.title, record),
          status: columns.find(column => column.key === to.column)?.label ?? '',
        })}
      />
    </section>
  )
}
