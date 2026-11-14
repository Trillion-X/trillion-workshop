// parts/ui/show/record-views/designs/inbox-design.tsx
//
// PORTED FROM: parts/ui/show/inbox-3pane/InboxThreePane.tsx (the list | open shell, one pane at a time on a narrow
//   surface), parts/ui/show/listing-card (each conversation as one glance row) and parts/ui/show/coss/thread.tsx (the
//   open conversation and its reply box). Anatomy after Plain's thread list and open thread
//   (mobbin.com/screens/1b5bc0b2-f41b-4375-8b2c-8f14f218c8f6): who wrote, the subject, one line of the newest words,
//   a status dot and the face of whoever has it; the open conversation reads oldest first with the reply box under it.
//   Written fresh against the shared parts; no source was copied.
//
// PURPOSE
//   The `inbox` design (../view-designs): each record no other record in the list holds is a conversation, and every
//   record the list's nesting holds under it, at any depth, is a message in it. The conversations are a list, newest
//   activity first; the chosen one is open beside it, its messages oldest first and the list's own way of taking words
//   (`compose`) under them, so an answer is written where it is read. A shared inbox, a support queue, a mailing list
//   and a comment thread are rows of this one design (designed-views.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word here: slots and options come from the row, words from the list. `status` is the
//      field whose declared values carry a tone, `person` the field that names who has it.
//   2. A conversation's messages are its root and every record nested under it; a record whose parent is not drawn is
//      a conversation of its own.
//   3. The surface's own width decides the layout (container-size), never the window's: below `narrow_below_px` one pane
//      shows at a time, the list first, the conversation when one is chosen, with a way back.
//   4. A reply goes to the newest message of the open conversation through the list's compose; the list's row actions
//      marked `lead` are the open conversation's buttons (give it to someone, mark it done).

import * as React from 'react'
import {InboxThreePane} from '../../inbox-3pane/InboxThreePane'
import {ListingCard, type Listing} from '../../listing-card'
import {Thread, type ThreadAction, type ThreadPost} from '../../coss/thread'
import {Button} from '../../coss/ui/button'
import {NamedIcon} from '../../icon'
import {bindContainerSize} from '../../container-size/container-size'
import {nestedByIdentity} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts'
import {slotFields, wordsOf, type ViewDesignProps} from '../view-designs'
import type {FieldDescriptor} from '../record-views'

type InboxOptions = {empty?: string; reply?: string; pick?: string; back?: string; narrow_below_px?: number}

const SLOTS = ['title', 'body', 'author', 'when', 'status', 'person'] as const

const instantOf = (field: FieldDescriptor | undefined, record: any): number => {
  if (!field) return 0
  const value = field.factValue?.(record) ?? field.sortValue?.(record) ?? (field.read ? field.read(record) : record?.[field.id])
  const at = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : 0
}
const rawOf = (field: FieldDescriptor | undefined, record: any) => (field ? (field.read ? field.read(record) : record?.[field.id]) : undefined)
const firstLine = (text: string) => text.split('\n').map(line => line.trim()).find(Boolean) ?? ''

type Conversation = {id: string; root: any; messages: any[]; latest: any; at: number}

export function InboxDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as InboxOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const {records, identify, compose, designExtras, nesting, rowActions = []} = context
  const host = React.useRef<HTMLDivElement | null>(null)
  const [narrow, setNarrow] = React.useState(false)
  const [chosen, setChosen] = React.useState<string | null>(null)
  const breakpoint = options.narrow_below_px ?? 760
  React.useEffect(() => {
    if (!host.current) return
    return bindContainerSize(host.current, {classes: [{id: 'narrow', below_px: breakpoint}, {id: 'wide'}], onChange: size => setNarrow(size === 'narrow')})
  }, [breakpoint])

  const conversations = React.useMemo((): Conversation[] => {
    const loaded = new Set(records.map(identify))
    const parents = nesting ? nestedByIdentity(nesting.graph, nesting.identityOf).parents : new Map<string, string[]>()
    const parentOf = (record: any) => parents.get(identify(record))?.find(id => loaded.has(id) && id !== identify(record)) ?? null
    const byId = new Map(records.map(record => [identify(record), record]))
    const rootOf = (record: any) => {
      const seen = new Set<string>()
      let at = record
      for (let parent = parentOf(at); parent && !seen.has(parent); parent = parentOf(at)) { seen.add(identify(at)); at = byId.get(parent) }
      return at
    }
    const groups = new Map<string, any[]>()
    for (const record of records) { const root = identify(rootOf(record)); groups.set(root, [...(groups.get(root) ?? []), record]) }
    return [...groups.entries()].map(([id, messages]) => {
      const ordered = [...messages].sort((a, b) => instantOf(slots.when, a) - instantOf(slots.when, b))
      const latest = ordered.at(-1)
      return {id, root: byId.get(id), messages: ordered, latest, at: instantOf(slots.when, latest)}
    }).sort((a, b) => b.at - a.at)
  }, [records, identify, nesting, slots.when])

  // On a wide surface the newest conversation is open until one is chosen; on a narrow one the list shows first.
  const open = conversations.find(item => item.id === chosen) ?? (narrow ? null : conversations[0] ?? null)

  const listingOf = (item: Conversation): Listing => {
    const author = wordsOf(slots.author, item.latest)
    const status = wordsOf(slots.status, item.root)
    const tone = slots.status?.values?.[String(rawOf(slots.status, item.root))]?.tone
    const person = wordsOf(slots.person, item.root)
    return {
      id: item.id, form: 'row', whole: true,
      title: wordsOf(slots.title, item.root) || firstLine(wordsOf(slots.body, item.root)),
      ...(author ? {face: {name: author}} : {}),
      when: wordsOf(slots.when, item.latest) || undefined,
      text: firstLine(wordsOf(slots.body, item.latest)) || undefined,
      ...(status ? {mark: {label: status, ...(tone ? {tone} : {})}} : {}),
      ...(person ? {chips: [{label: person}]} : {}),
      ...(item.messages.length > 1 ? {value: String(item.messages.length)} : {}),
    }
  }

  const posts = React.useMemo((): ThreadPost[] => (open ? [...open.messages].reverse().map(record => ({
    id: identify(record),
    author: wordsOf(slots.author, record),
    when: wordsOf(slots.when, record) || undefined,
    body: wordsOf(slots.body, record) || wordsOf(slots.title, record),
    replies: [],
    ...(designExtras?.(row.design, record) ?? {}),
  } as ThreadPost)) : []), [open, identify, slots.author, slots.when, slots.body, slots.title, designExtras, row.design])

  const replyAction = React.useMemo((): ThreadAction => ({label: compose?.label ?? 'Send'}), [compose?.label])
  const reply = compose && open ? {placeholder: compose.placeholder ?? options.reply ?? 'Reply', action: replyAction} : undefined
  const onAction = async (action: ThreadAction, values: Record<string, string>) => {
    if (compose && open && action === replyAction && values.text) return compose.send({text: values.text, parent: identify(open.latest)})
    return context.designAction?.(action, values)
  }
  const buttons = open ? rowActions.filter(action => action.lead && (!action.appliesTo || action.appliesTo(open.root))) : []
  const back = () => setChosen(null)

  const list = (
    <div className="record-views-inbox-list" role="list">
      {conversations.length ? conversations.map(item => (
        <div key={item.id} role="listitem" data-chosen={open?.id === item.id ? '' : undefined}>
          <ListingCard listing={listingOf(item)} onOpen={setChosen}/>
        </div>
      )) : <div className="record-views-inbox-empty">{options.empty ?? 'Nothing here yet.'}</div>}
    </div>
  )
  const detail = open ? (
    <div className="record-views-inbox-open">
      <div className="record-views-inbox-head">
        {narrow ? <Button variant="ghost" size="sm" onClick={back}><NamedIcon name="chevron-left" size="xs" aria-hidden/>{options.back ?? 'Back'}</Button> : null}
        <div className="record-views-inbox-title">{wordsOf(slots.title, open.root) || firstLine(wordsOf(slots.body, open.root))}</div>
        {buttons.map(action => (
          <Button key={action.id} variant="outline" size="sm" onClick={() => action.run([identify(open.root)])}>
            <NamedIcon name={action.icon} size="xs" aria-hidden/>{action.label}
          </Button>
        ))}
      </div>
      <Thread thread={{posts, style: 'discussion', order: 'newest-last', empty: options.empty ?? 'Nothing here yet.', ...(reply ? {compose: reply} : {})}} onAction={onAction}/>
    </div>
  ) : <div className="record-views-inbox-empty">{options.pick ?? 'Choose a conversation to read it.'}</div>

  return (
    <div ref={host} className="record-views-design record-views-inbox" data-design={row.design}>
      <InboxThreePane
        rail={null}
        list={list}
        detail={detail}
        width={narrow ? 0 : breakpoint}
        narrowBreakpointPx={breakpoint}
        hasSelection
        isItemOpen={Boolean(open)}
        preferredPane="list"
        onNavigateBack={back}
      />
    </div>
  )
}
