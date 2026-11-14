// parts/ui/show/record-views/designs/swipe-design.tsx
//
// PURPOSE
//   Draw any list as a swipeable set of work cards. The list supplies the title,
//   summary and status fields; its own record writer keeps status changes, and
//   its own row actions keep sharing, pinning and other work actions.
//
// INVARIANTS
//   1. This design names no product, list, status value or record kind.
//   2. The status field's declared value order is the status progression. Swiping
//      left or right chooses the adjacent declared value; undo restores the value
//      held before that swipe.
//   3. Opening the card opens its subject. An optional tour slot opens the linked
//      record through the same list owner.

import * as React from 'react'
import {SwipeDeck, type SwipeChoice, type SwipeTone} from '../../swipe-deck/SwipeDeck'
import {Button} from '../../coss/ui/button'
import {Badge, badgeVariantForTone} from '../../coss/ui/badge'
import {NamedIcon} from '../../icon'
import {slotFields, valueOf, wordsOf, type ViewDesignProps} from '../view-designs'
import {RowActionMenu} from '../row-action-menu'

const SLOTS = ['title', 'detail', 'status', 'tour'] as const

const referenceId = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (!value || typeof value !== 'object') return undefined
  const ref = value as Record<string, unknown>
  for (const candidate of [ref.id, ref.record, ref.ref]) if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  return undefined
}

const choiceIndex = (current: unknown, choices: string[], direction: SwipeChoice) => {
  if (!choices.length) return -1
  const at = choices.indexOf(String(current ?? ''))
  const from = at < 0 ? 0 : at
  return Math.max(0, Math.min(choices.length - 1, from + (direction === 'right' ? 1 : -1)))
}

export function SwipeDesign({context, row}: ViewDesignProps) {
  const slots = slotFields(row, context.fields, SLOTS)
  const status = slots.status
  const choices = React.useMemo(() => Object.keys(status?.values ?? {}), [status])
  const previous = React.useRef(new Map<string, unknown>())
  const [at, setAt] = React.useState(0)
  const options = row.options ?? {}
  const inputIds = React.useMemo(() => context.records.map(context.identify), [context.records, context.identify])
  const signature = [...inputIds].sort().join('\u241f')
  const [sequence, setSequence] = React.useState<{signature: string; ids: string[]}>({signature: '', ids: []})
  const orderedIds = sequence.signature === signature ? sequence.ids : inputIds
  const recordsById = React.useMemo(() => new Map(context.records.map(record => [context.identify(record), record])), [context.records, context.identify])
  const records = orderedIds.map(id => recordsById.get(id)).filter((record): record is any => Boolean(record))
  const sections = (context.groupLevels ?? []).map(level => context.fields.find(field => field.id === level.field)).filter((field): field is NonNullable<typeof field> => Boolean(field))
  const current = records[Math.min(at, Math.max(0, records.length - 1))]
  const currentId = current ? context.identify(current) : undefined
  const tourId = referenceId(valueOf(slots.tour, current))

  const decide = async (record: any, direction: SwipeChoice) => {
    if (!context.write || !status || choices.length < 2) return
    const id = context.identify(record)
    const old = valueOf(status, record)
    const next = choices[choiceIndex(old, choices, direction)]
    if (next === undefined || String(old ?? '') === next) return
    previous.current.set(id, old)
    await context.write([{id, values: {[status.id]: next}}])
    setAt(index => Math.min(index + 1, records.length - 1))
  }

  const undo = async (record: any) => {
    if (!context.write || !status) return
    const id = context.identify(record)
    if (!previous.current.has(id)) return
    const value = previous.current.get(id)
    previous.current.delete(id)
    await context.write([{id, values: {[status.id]: value ?? null}}])
    setAt(index => Math.max(0, index - 1))
  }

  const actions = current ? (context.rowActions ?? []).filter(action => action.lead && (!action.appliesTo || action.appliesTo(current))) : []
  const label = (options.label as string | undefined) ?? context.label
  React.useEffect(() => {
    if (sequence.signature !== signature) {
      setSequence({signature, ids: inputIds})
      setAt(0)
      previous.current.clear()
    } else {
      setAt(index => Math.min(index, Math.max(0, records.length - 1)))
    }
  }, [signature, inputIds, sequence.signature, records.length])
  if (!records.length) return <div className="record-views-swipe-empty">{(options.empty as string | undefined) ?? 'Nothing here yet.'}</div>

  return (
    <section className="record-views-design record-views-swipe" data-design={row.design} aria-label={label}>
      <SwipeDeck
        key={signature}
        items={records}
        itemKey={context.identify}
        itemLabel={record => wordsOf(slots.title, record) || context.identify(record)}
        label={label}
        leftLabel={(options.left_label as string | undefined) ?? 'Earlier'}
        rightLabel={(options.right_label as string | undefined) ?? 'Later'}
        leftTone={options.left_tone as SwipeTone | undefined}
        rightTone={options.right_tone as SwipeTone | undefined}
        emptyLabel={(options.empty as string | undefined) ?? 'All caught up'}
        disabled={!context.write || choices.length < 2}
        height={300}
        onDecide={decide}
        onUndo={undo}
        onOpen={record => context.open?.(context.identify(record))}
        onRestart={() => setAt(0)}
      >
        {record => {
          const rawStatus = valueOf(status, record)
          const tone = status?.values?.[String(rawStatus ?? '')]?.tone
          const detail = wordsOf(slots.detail, record)
          const title = wordsOf(slots.title, record) || context.identify(record)
          const group = sections.map(field => wordsOf(field, record)).filter(Boolean).join(' › ')
          return (
            <article className="record-views-swipe-card" aria-label={title}>
              {group ? <div className="record-views-swipe-card-group">{group}</div> : null}
              <header className="record-views-swipe-card-head">
                <div className="record-views-swipe-card-title">{title}</div>
                {status && wordsOf(status, record) ? <Badge variant={badgeVariantForTone(tone)}>{wordsOf(status, record)}</Badge> : null}
              </header>
              {detail ? <p className="record-views-swipe-card-detail">{detail}</p> : null}
              {slots.tour && referenceId(valueOf(slots.tour, record)) ? (
                <div className="record-views-swipe-card-tour">Tour attached</div>
              ) : null}
            </article>
          )
        }}
      </SwipeDeck>
      {current ? (
        <div className="record-views-swipe-actions">
          {tourId ? <Button type="button" variant="outline" size="sm" onClick={() => context.open?.(tourId)}><NamedIcon name="Route" size="xs" aria-hidden/>Open tour</Button> : null}
          {actions.map(action => <Button key={action.id} type="button" variant="outline" size="sm" onClick={() => action.run([currentId!])}><NamedIcon name={action.icon} size="xs" aria-hidden/>{action.label}</Button>)}
          <RowActionMenu actions={context.rowActions ?? []} record={current} id={currentId!} name={wordsOf(slots.title, current) || 'this record'} about={context.aboutRecord?.(current) ?? undefined}/>
        </div>
      ) : null}
      {status && choices.length < 2 ? <p className="record-views-swipe-help">Add at least two declared status values to change status by swiping.</p> : null}
      {!context.write ? <p className="record-views-swipe-help">This list is read-only.</p> : null}
    </section>
  )
}
