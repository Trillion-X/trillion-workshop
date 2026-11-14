// parts/ui/show/record-views/designs/chat-design.tsx
//
// PURPOSE
//   The `chat` design (../view-designs): a list that holds words, drawn as one conversation on the shared chat part
//   (../../chat/ChatThread): each record a message (its `body` slot the words, else its `title`; `author` who wrote
//   it; `when` when), oldest at the top and newest at the bottom with the list's own way of taking words (`compose`)
//   pinned under it. A record the list's nesting holds under another is a message that answers it, drawn in its time
//   with the words it answers quoted at its top, as Messenger, WhatsApp and Slack draw a reply. Pressing a message's
//   Reply puts what it answers over the box, and the next message sent goes under it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word here: slots and options come from the row, words from the list, and what a list
//      adds to a record (designExtras('chat', record): who wrote it and whether it was the reader, a shared thing, its
//      reactions, its menu, a quiet line for words taken back, whether it is new to the reader) is laid over the
//      message the slots made, in the shape the thread design reads too (../../coss/thread ThreadPost).
//   2. Every press a list added (a menu row, a reaction, a shared thing's Open) is reported to the list through
//      designAction with the record's id under `post`; replying reaches compose.send with the record as `parent`.
//   3. A list whose compose draws its own box (`compose.box`) is handed what the next message answers; one without
//      its own box gets the shared composer.

import * as React from 'react'
import {ChatThread, type ChatAttachment, type ChatEntry, type ReactionChoice} from '../../chat'
import {Composer} from '../../composer'
import {DisplayMark} from '../../display-mark'
import {MediaPreview} from '../../media-preview/MediaPreview'
import {recordKindAppearance} from '../../record-kind/RecordKindMark'
import {nestedByIdentity} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts'
import type {ThreadAction, ThreadPost} from '../../coss/thread'
import {slotFields, wordsOf, type ViewDesignProps} from '../view-designs'
import type {FieldDescriptor} from '../record-views'

type ChatOptions = {empty?: string; reply?: string; words?: Record<string, string>}

const SLOTS = ['body', 'title', 'author', 'when'] as const

// The instant a record was written: the fact its when field compares, else its value.
const instantOf = (field: FieldDescriptor | undefined, record: any): number => {
  if (!field) return Number.NaN
  const value = field.factValue?.(record) ?? field.sortValue?.(record) ?? (field.read ? field.read(record) : record?.[field.id])
  const at = typeof value === 'number' ? value : value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(at) ? at : Number.NaN
}

export function ChatDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as ChatOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const {records, identify, compose, designExtras, designAction, nesting, label} = context
  const [replyTo, setReplyTo] = React.useState<string | null>(null)

  const entries = React.useMemo(() => {
    const loaded = new Map(records.map(record => [identify(record), record]))
    const parents = nesting ? nestedByIdentity(nesting.graph, nesting.identityOf).parents : new Map<string, string[]>()
    const parentOf = (id: string) => parents.get(id)?.find(parent => loaded.has(parent) && parent !== id) ?? null
    const posts = new Map(records.map(record => {
      const id = identify(record)
      const extras = (designExtras?.(row.design, record) ?? {}) as Partial<ThreadPost>
      const body = wordsOf(slots.body, record) || wordsOf(slots.title, record)
      return [id, {author: extras.author || wordsOf(slots.author, record), body, ...extras} as ThreadPost & {unseen?: boolean}]
    }))
    const report = (action: ThreadAction | undefined, values: Record<string, string>) => action ? designAction?.(action, values) : undefined
    return records.map((record): ChatEntry => {
      const id = identify(record)
      const post = posts.get(id)!
      const at = instantOf(slots.when, record)
      const parent = parentOf(id)
      const answered = parent ? posts.get(parent) : undefined
      const preview = post.attachment?.preview
      const attachment: ChatAttachment | undefined = post.attachment ? {
        kind: post.attachment.kind, title: post.attachment.title, ...(post.attachment.detail ? {detail: post.attachment.detail} : {}),
        // A picture of the thing itself; a kind's own glyph tile is drawn by the chat from the kind's icon instead.
        ...(preview && preview.renderer !== 'type-icon' ? {picture: <MediaPreview {...preview}/>} : {}),
        icon: (preview as {icon?: string} | undefined)?.icon ?? recordKindAppearance(post.attachment.kind).icon,
        ...(post.attachment.open ? {open: () => report(post.attachment!.open, {post: id}), openLabel: post.attachment.open.label} : {}),
      } : undefined
      const react = post.react
      return {
        id,
        speaker: {id: post.author || '?', name: post.author || '?', mine: Boolean(post.you)},
        // A shared thing's card says what it is; the words announcing it would only repeat the card.
        text: attachment ? '' : post.body,
        at: Number.isFinite(at) ? new Date(at).toISOString() : '',
        ...(post.mentions?.length ? {mentions: post.mentions} : {}),
        ...(post.part?.quote || answered ? {quote: {...(answered ? {name: answered.author} : {}), text: post.part?.quote || answered?.body || answered?.attachment?.title || ''}} : {}),
        ...(attachment ? {attachment} : {}),
        ...(react ? {reactions: post.reactions ?? [], ...(post.palette ? {palette: post.palette} : {}),
          onReact: (choice: ReactionChoice) => report(react, {post: id, on: String(choice.on), ...(choice.symbol ? {symbol: choice.symbol} : {}), ...(choice.glyph ? {glyph: choice.glyph} : {})})} : {}),
        ...(compose && !post.withdrawn ? {onReply: () => setReplyTo(id)} : {}),
        ...(post.menu?.length ? {menu: {items: post.menu, onAction: (chosen: string) => {
          const item = post.menu!.find(one => one.id === chosen)
          if (item) void report({id: item.id, label: item.label}, {post: id})
        }}} : {}),
        ...(post.withdrawn ? {withdrawn: post.withdrawn} : {}),
        ...(post.unseen ? {unread: true} : {}),
      }
    })
  }, [records, identify, nesting, slots.body, slots.title, slots.author, slots.when, designExtras, designAction, row.design, compose])

  const replying = replyTo ? entries.find(entry => entry.id === replyTo) : undefined
  const done = () => setReplyTo(null)
  const box = !compose ? null : compose.box
    ? compose.box(replying ? {parent: replying.id, done} : undefined)
    : <Composer words={{label: compose.label ?? 'Send', placeholder: compose.placeholder ?? 'Write a message'}}
        onSend={async draft => { if (!draft.text.trim()) return; await compose.send({text: draft.text, ...(replying ? {parent: replying.id} : {})}); done() }}/>

  return (
    <div className="record-views-design" data-design={row.design}>
      <ChatThread
        entries={entries}
        ariaLabel={label}
        empty={options.empty ?? 'Nothing here yet.'}
        markOf={speaker => <DisplayMark spec={{name: speaker.name}} size="sm"/>}
        composer={box}
        replying={replying ? {name: replying.speaker.mine ? (options.words?.yourself ?? 'yourself') : replying.speaker.name, text: replying.text || replying.attachment?.title || '', onCancel: done} : null}
        {...(options.words ? {words: options.words} : {})}
      />
    </div>
  )
}
