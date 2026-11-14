// parts/ui/show/record-views/designs/records-on-a-board.ts
//
// PURPOSE
//   Any list as a board's source (the shape parts/group/do-work/board-source.ts draws: cards and lines): each record is
//   a card whose words are its `title` slot, whose live state is its `status` slot (else the list's `statusField`, else
//   the first field whose values carry a tone: the value's label, the tone its declared value carries, a pulse while
//   the value is a working one), whose buttons are Open (where the list opens a record and the row names `open`) and the
//   list's row actions that apply to it, and whose frame is its
//   `group` slot (else the person's first Group by). Lines are the list's own links: its `links` (with the words on
//   each line and the kind of thing it carries), each field declaring `links` (../view-designs recordLinks) and each
//   record nested under another (the list's nesting), drawn from the record above to the one under it. A card with
//   stated records under it (along those lines, at any depth) says how many of them are done (the row's `done` words),
//   counted by the shared roll-up (../../node-graph/roll-up.ts) with what counts as done read from the one rule every
//   list view reads (views-offered-to-every-list.json `done`, through doneValuesOf) or a value declared `settled`.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word: slots come from the row or the fields' roles, actions from the list.
//   2. The same records give the same cards and lines in the same order (the board plans nothing on a second read).
//   3. A line joins two records of this list only, never a record to itself, and each pair once per kind.
//   4. A done count is never guessed: a card with no stated record under it says none.

import {nestedByIdentity} from 'trillion-workshop/tools/turn-frames-into-slides/read-data/group-graph.ts'
import {rollUp} from '../../node-graph/roll-up'
import {doneValuesOf} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/visual-database-input-from-list.ts'
import offeredToEveryList from 'trillion-workshop/tools/keep-lists-of-rows/source-data/views-offered-to-every-list.json'
import {recordLinks, slotFields, valueOf, wordsOf, type DesignedViewRow} from '../view-designs'
import type {FieldDescriptor, RecordViewContext} from '../record-views'

export type BoardCardState = {label: string; tone?: string; pulse?: boolean}
export type BoardCardAction = {id: string; label: string}
export type BoardCard = {id: string; text: string; state?: BoardCardState | null; actions?: BoardCardAction[] | null; group?: string | null}
export type BoardLine = {from: string; to: string; label?: string | null; kind?: string | null}
export type RecordsOnABoard = {cards: BoardCard[]; lines: BoardLine[]}

const SLOTS = ['title', 'status', 'group'] as const
/** The button that opens a card's record where the list shows a record whole (never a row action's id). */
export const OPEN_ACTION = '\u241fopen'
const DONE = {done_tones: offeredToEveryList.done.tones, done_values: offeredToEveryList.done.values}

/** The field whose value is a record's state: the row's `status` slot, else the list's own, else the first whose
 *  values carry a tone. */
function statusFieldOf(context: RecordViewContext, slot: FieldDescriptor | undefined): FieldDescriptor | undefined {
  return slot ?? context.fields.find(field => field.id === context.statusField)
    ?? context.fields.find(field => Object.values(field.values ?? {}).some(value => value?.tone))
}

/** The field a board frames records by: the row's `group` slot, else the person's first Group by. */
function groupFieldOf(context: RecordViewContext, slot: FieldDescriptor | undefined): FieldDescriptor | undefined {
  return slot ?? context.fields.find(field => field.id === context.groupLevels?.[0]?.field)
}

/** A record's live state from the status field: its value's words, the tone its declared value carries, and a pulse
 *  while that value is declared as one still being worked on. */
function stateOf(field: FieldDescriptor | undefined, record: unknown): BoardCardState | null {
  if (!field) return null
  const raw = valueOf(field, record)
  if (raw === null || raw === undefined || raw === '') return null
  const declared = field.values?.[String(raw)]
  const label = wordsOf(field, record)
  return label ? {label, ...(declared?.tone ? {tone: declared.tone} : {}), ...(declared?.working ? {pulse: true} : {})} : null
}

/** The records of a list as a board draws them (invariants 1-3). */
export function recordsOnABoard(context: RecordViewContext, row: DesignedViewRow): RecordsOnABoard {
  const slots = slotFields(row, context.fields, SLOTS)
  const group = groupFieldOf(context, slots.group)
  const status = statusFieldOf(context, slots.status)
  const actions = context.rowActions ?? []
  // Open leads a card's buttons where the list opens a record whole and the row names its words.
  const openWords = (row.options as {open?: string} | undefined)?.open
  const opens = context.open && openWords ? [{id: OPEN_ACTION, label: openWords}] : []
  const cards = context.records.map(record => {
    const id = context.identify(record)
    const offered = [...opens, ...actions.filter(action => !action.appliesTo || action.appliesTo(record)).map(action => ({id: action.id, label: action.label}))]
    const frame = group ? wordsOf(group, record) : ''
    return {
      id,
      text: wordsOf(slots.title, record) || id,
      state: stateOf(status, record),
      actions: offered.length ? offered : null,
      group: frame || null,
    }
  })
  const ids = new Set(cards.map(card => card.id))
  const seen = new Set<string>()
  const lines: BoardLine[] = []
  const join = (from: string, to: string, said: {label?: string; kind?: string} = {}) => {
    const key = `${from}>${to}>${said.kind ?? ''}`
    if (from === to || !ids.has(from) || !ids.has(to) || seen.has(key)) return
    seen.add(key)
    lines.push({from, to, ...(said.label ? {label: said.label} : {}), ...(said.kind ? {kind: said.kind} : {})})
  }
  for (const link of context.links?.(context.records) ?? []) join(link.from, link.to, link)
  for (const link of recordLinks(context.records, context.fields, context.identify)) join(link.from, link.to)
  if (context.nesting) {
    const {children} = nestedByIdentity(context.nesting.graph, context.nesting.identityOf)
    for (const card of cards) for (const child of children.get(card.id) ?? []) join(card.id, child)
  }
  return {cards: withDoneCounts(cards, lines, status, context.records, context.identify, row), lines}
}

/** Each card's state gains how many of the stated records under it are done (invariant 4), in the row's `done` words
 *  (`{done}` and `{count}`). */
function withDoneCounts(cards: BoardCard[], lines: BoardLine[], status: FieldDescriptor | undefined, records: unknown[], identify: (record: any) => string, row: DesignedViewRow): BoardCard[] {
  const words = (row.options as {done?: string} | undefined)?.done
  if (!status || !words || !lines.length) return cards
  const done = new Set([...doneValuesOf(status, DONE), ...Object.entries(status.values ?? {}).filter(([, value]) => value?.settled).map(([id]) => id)])
  const stated = records.map(record => {
    const raw = valueOf(status, record)
    return {id: identify(record), ...(raw === null || raw === undefined || raw === '' ? {} : {status: String(raw)})}
  })
  const counted = rollUp(stated, lines, value => done.has(value))
  return cards.map(card => {
    const count = counted.get(card.id)
    if (!count) return card
    const said = words.replace('{done}', String(count.done)).replace('{count}', String(count.of))
    return {...card, state: card.state ? {...card.state, label: `${card.state.label} · ${said}`} : {label: said, ...(count.done === count.of ? {tone: 'success'} : {})}}
  })
}
