// parts/ui/show/record-views/designs/thread-design.tsx
//
// PORTED FROM: parts/ui/show/coss/thread.tsx (the shared discussion: posts, nested replies, votes, a box); this file
//   only reads a list's records into its posts, so a chat and a feed are views of any list that holds words.
//
// PURPOSE
//   The `thread` design (../view-designs): each record is a post (its `body` slot the words, `author` who wrote it,
//   `when` when), a record the list's nesting holds under another sits under it as a reply, at any depth, and the
//   list's own way of taking words (`compose`) is the box, on top or under the posts as the row's options say. A chat
//   and a feed are two DATA rows of this one design (designed-views.json).
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word here: slots and options come from the row, words from the list.
//   2. Replies nest by the list's nesting (the group graph every view reads, ../../group/group-graph nestedByIdentity)
//      to any depth; a record whose parent is not among the records drawn is a post.
//   3. A list's extras for this design (designExtras('thread', record): a vote, a menu, a shared thing, mentions) are
//      laid over the post the slots made; the list's compose writes every new post and reply.

import * as React from 'react'
import {Thread, type ThreadAction, type ThreadPost} from '../../coss/thread'
import {nestedByIdentity} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts'
import {slotFields, wordsOf, type ViewDesignProps} from '../view-designs'
import type {FieldDescriptor} from '../record-views'

type ThreadOptions = {style?: 'cards' | 'discussion'; order?: 'newest-first' | 'newest-last'; box?: 'top' | 'bottom' | 'none'; empty?: string; reply?: string}

const SLOTS = ['body', 'title', 'author', 'when'] as const

// The instant a record was written, for ordering: the fact its when field compares, else its value.
const instantOf = (field: FieldDescriptor | undefined, record: any): number => {
  if (!field) return 0
  const value = field.factValue?.(record) ?? field.sortValue?.(record) ?? (field.read ? field.read(record) : record?.[field.id])
  const at = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(at) ? at : 0
}

export function ThreadDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as ThreadOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const {records, identify, compose, designExtras, nesting} = context
  const replyRuns = React.useRef(new WeakMap<object, string>())
  const posts = React.useMemo(() => {
    const loaded = new Set(records.map(identify))
    const parents = nesting ? nestedByIdentity(nesting.graph, nesting.identityOf).parents : new Map<string, string[]>()
    const parentOf = (record: any) => parents.get(identify(record))?.find(id => loaded.has(id) && id !== identify(record)) ?? null
    const children = new Map<string, any[]>()
    for (const record of records) { const parent = parentOf(record); if (parent) children.set(parent, [...(children.get(parent) ?? []), record]) }
    const by = (newestFirst: boolean) => (a: any, b: any) => (instantOf(slots.when, b) - instantOf(slots.when, a)) * (newestFirst ? 1 : -1)
    const postOf = (record: any, seen: Set<string>): ThreadPost => {
      const id = identify(record)
      const next = new Set(seen).add(id)
      const reply: ThreadAction | undefined = compose ? {label: options.reply ?? 'Reply'} : undefined
      if (reply) replyRuns.current.set(reply, id)
      const extras = designExtras?.(row.design, record) ?? {}
      return {
        id,
        author: wordsOf(slots.author, record),
        when: wordsOf(slots.when, record) || undefined,
        body: wordsOf(slots.body, record) || wordsOf(slots.title, record),
        ...(reply ? {reply} : {}),
        replies: [...(children.get(id) ?? [])].filter(child => !next.has(identify(child))).sort(by(false)).map(child => postOf(child, next)),
        ...extras,
      } as ThreadPost
    }
    return records.filter(record => !parentOf(record)).sort(by(true)).map(record => postOf(record, new Set()))
  }, [records, identify, nesting, slots.when, slots.author, slots.body, slots.title, compose, designExtras, row.design, options.reply])

  const box = options.box ?? 'top'
  const ownBox = compose?.box && box !== 'none' ? <div className="record-views-design-box">{compose.box()}</div> : null
  const plainBox = compose && !compose.box && box !== 'none'
    ? {placeholder: compose.placeholder ?? 'Write something', action: {label: compose.label ?? 'Send'}} : undefined
  const onAction = async (action: ThreadAction, values: Record<string, string>) => {
    const parent = replyRuns.current.get(action)
    if (compose && (parent || action === plainBox?.action) && values.text) return compose.send({text: values.text, ...(parent ? {parent} : {})})
    return context.designAction?.(action, values)
  }
  const order = options.order ?? (box === 'bottom' ? 'newest-last' : 'newest-first')
  return (
    <div className="record-views-design" data-design={row.design} data-box={box}>
      {box === 'top' ? ownBox : null}
      <Thread thread={{posts, style: options.style ?? 'cards', order, empty: options.empty ?? 'Nothing here yet.', ...(plainBox ? {compose: plainBox} : {})}} onAction={onAction}/>
      {box === 'bottom' ? ownBox : null}
    </div>
  )
}
