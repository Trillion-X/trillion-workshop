// parts/ui/show/record-views/designs/calendar-design.tsx
//
// PURPOSE
//   The `calendar` design (../view-designs): any list with a date as a calendar, on the shared ScheduleCalendar (the
//   month board and the hour lanes the posting calendar draws). Each record sits on its day (its `when` slot), coloured
//   by its `status` tone, with its `detail` under it where there is room; records with no date wait in the tray beside
//   it. The header's month, week and day choice is the row's `options.views`; pressing a record opens it, pressing a
//   day's number shows that day (`options.day_view`). Dragging a record to another day (keeping its time of day), to an
//   hour lane (taking that time) or to the tray (taking its date away) writes its `when` through the list, when the list
//   keeps changes and the field is not one it works out.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word: slots come from the row or the fields' roles, every word from the row's options.
//   2. A date is written as an ISO time, or null for the tray; nothing else in the record changes.
//   3. Which way of showing is chosen and which day the calendar is on belong to this view while it is drawn.

import * as React from 'react'
import {ScheduleCalendar, dayKey, type ScheduleItem, type ScheduleView} from '../../schedule-calendar'
import {instantOf, slotFields, toneOf, wordsOf, writable, type ViewDesignProps} from '../view-designs'

type CalendarChoice = {id: string; label: string; view: ScheduleView}
type CalendarOptions = {
  views?: CalendarChoice[]
  day_view?: string
  words?: Partial<Record<'previous' | 'next' | 'today' | 'tray' | 'tray_empty' | 'more' | 'placing' | 'unplacing' | 'show', string>>
  snap_minutes?: number
  item_minutes?: number
  start_scroll_minute?: number
}

const SLOTS = ['title', 'when', 'status', 'detail'] as const
const MONTH: CalendarChoice = {id: 'month', label: 'Month', view: {grid: 'month'}}
const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')

export function CalendarDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as CalendarOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const choices = options.views?.length ? options.views : [MONTH]
  const [choice, setChoice] = React.useState(choices[0]!.id)
  const [anchor, setAnchor] = React.useState(() => dayKey(new Date()))
  const chosen = choices.find(item => item.id === choice) ?? choices[0]!
  const movable = writable(context, slots.when)
  const words = options.words ?? {}
  const items = React.useMemo((): ScheduleItem[] => context.records.map(record => {
    const subtitle = wordsOf(slots.detail, record)
    const tone = toneOf(slots.status, record)
    return {
      id: context.identify(record),
      title: wordsOf(slots.title, record) || context.identify(record),
      at: instantOf(slots.when, record),
      movable,
      ...(subtitle ? {subtitle} : {}),
      ...(tone ? {tone} : {}),
    }
  }), [context.records, context.identify, slots.title, slots.when, slots.detail, slots.status, movable])
  const move = (id: string, at: string | null) => {
    if (!movable) return
    void context.write!([{id, values: {[slots.when!.id]: at}}])
  }
  return (
    <section className="record-views-design record-views-calendar" data-design={row.design} aria-label={context.label}>
      <ScheduleCalendar
        items={items}
        view={chosen.view}
        anchor={anchor}
        onAnchorChange={setAnchor}
        onMove={move}
        onOpen={context.open}
        onSelectDay={options.day_view && choices.some(item => item.id === options.day_view) ? key => { setAnchor(key); setChoice(options.day_view!) } : undefined}
        choices={choices.map(({id, label}) => ({id, label}))}
        choice={chosen.id}
        onChoiceChange={setChoice}
        ariaLabel={context.label}
        words={{
          previous: words.previous ?? 'Earlier',
          next: words.next ?? 'Later',
          today: words.today ?? 'Today',
          tray: words.tray ?? 'No date yet',
          trayEmpty: words.tray_empty ?? 'Everything here has a date.',
          more: count => fill(words.more ?? '{count} more', {count: String(count)}),
          placing: (title, when) => fill(words.placing ?? '{title} moves to {when}.', {title, when}),
          unplacing: title => fill(words.unplacing ?? 'Let go to take the date away from {title}.', {title}),
          ...(words.show ? {show: words.show} : {}),
        }}
        {...(options.snap_minutes ? {snapMinutes: options.snap_minutes} : {})}
        {...(options.item_minutes ? {durationMinutes: options.item_minutes} : {})}
        {...(options.start_scroll_minute !== undefined ? {initialScrollMinute: options.start_scroll_minute} : {})}
      />
    </section>
  )
}
