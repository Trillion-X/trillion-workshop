// parts/ui/show/record-views/designs/carousel-design.tsx
//
// PURPOSE
//   The `carousel` design (../view-designs): any list as a ring of large cards turning in place, on the shared rotating
//   carousel (../../cult/rotating-carousel, Cult UI's MIT cylinder carousel, 21st.dev component 1529). Each card is the
//   record's picture (the `picture` slot, when a field holds one), title, status and words (./design-parts
//   DesignCard); the arrows, a sideways swipe or the arrow keys turn the ring, and the card in front is the one that
//   can be pressed: its title opens the record, and under it sit Open (`options.open`), the record's lead row actions
//   and its menu.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word: slots come from the row or the fields' roles, words from the list and options.
//   2. Only the card in front takes presses (the carousel makes the others inert).

import * as React from 'react'
import {RotatingCarousel} from '../../cult/rotating-carousel'
import {Button} from '../../coss/ui/button'
import {NamedIcon} from '../../icon'
import {DesignCard} from './design-parts'
import {slotFields, wordsOf, type ViewDesignProps} from '../view-designs'
import {RowActionMenu} from '../row-action-menu'

type CarouselOptions = {open?: string; empty?: string}

const SLOTS = ['title', 'status', 'detail', 'body', 'picture'] as const

export function CarouselDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as CarouselOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const byId = React.useMemo(() => new Map(context.records.map(record => [context.identify(record), record])), [context.records, context.identify])
  const items = React.useMemo(() => context.records.map(record => ({id: context.identify(record)})), [context.records, context.identify])
  if (!items.length) return <p className="record-views-design-empty">{options.empty ?? 'Nothing here yet.'}</p>
  return (
    <section className="record-views-design record-views-carousel" data-design={row.design} aria-label={context.label}>
      <RotatingCarousel
        items={items}
        label={context.label}
        renderItem={(item: {id: string}) => <DesignCard context={context} slots={slots} record={byId.get(item.id)} size="large"/>}
        renderActiveAction={(item: {id: string} | undefined) => {
          const record = item && byId.get(item.id)
          if (!record) return null
          const lead = (context.rowActions ?? []).filter(action => action.lead && (!action.appliesTo || action.appliesTo(record)))
          return (
            <div className="record-views-carousel-actions">
              {context.open && options.open ? <Button type="button" variant="outline" size="sm" onClick={() => context.open!(item.id)}>{options.open}</Button> : null}
              {lead.map(action => <Button key={action.id} type="button" variant="outline" size="sm" onClick={() => action.run([item.id])}><NamedIcon name={action.icon} size="xs" aria-hidden/>{action.label}</Button>)}
              {context.rowActions?.length ? <RowActionMenu actions={context.rowActions} record={record} id={item.id} name={wordsOf(slots.title, record) || item.id} about={context.aboutRecord?.(record) ?? undefined}/> : null}
            </div>
          )
        }}
      />
    </section>
  )
}
