// packages/ui/show/record-views/group-sections.ts
//
// Purpose
//   Cuts a run of records into nested, labelled sections from an ordered list
//   of grouping levels ("Project, then Captured by month"). A field whose
//   values name a parent (a project inside a project) nests as a tree, so a
//   recording in Projects sits under Team > Projects rather than under
//   a flat "Team / Projects" heading. A date field groups by the
//   bucket a person picks: a day, a week, a month, a year, or how long ago.
//
// Non-negotiable invariants
//   - Blind: no field, value or product name. What a field groups by comes
//     from its descriptor (`values[v].parent`, `groupBuckets`) and the bucket
//     rows below, which are DATA a caller can replace per field.
//   - The records keep the order they arrived in inside every section, so a
//     sort still decides the sequence and sections only describe it.
//   - One builder feeds every view (gallery, table, board), so their sections
//     can never disagree.

import {calendarBucket, calendarBucketSpan} from 'trillion-workshop/tools/keep-lists-of-rows/read-data/saved-view-engine.mjs'

/** `show_empty_choices` (view DATA on the group) adds a section for every choice the field declares in `values`, so a
 *  choice nobody holds yet still shows as an empty section. */
export type GroupLevel = {field: string; bucket?: string; show_empty_choices?: boolean}

/** Where one value falls when grouped by a bucket: its section key, the words
 *  its heading shows, and where that section sorts (lower first). */
export type BucketKey = {value: string; label: string; order: number; range?: {min: number; max: number}}

/** One way to group a field's values. `key` returns null for a value this
 *  bucket cannot place, which then falls in the field's "No …" section. */
export type GroupBucket = {id: string; label: string; icon: string; key?: (value: string) => BucketKey | null; tree?: 'nested' | 'top' | 'own'}

export type GroupableField = {
  id: string
  label: string
  icon?: string
  values?: Record<string, {label?: string; parent?: string}>
  groupBuckets?: GroupBucket[]
}

export type SectionNode = {
  /** Stable across renders: the path of section values from the top. */
  key: string
  value: string
  label: string
  fieldId: string
  depth: number
  /** Every record inside this section and its sections, once each. */
  count: number
  /** The span of time a date section covers, so picking it can filter by it. */
  range?: {min: number; max: number}
  /** Records placed here directly, when no further level splits them. */
  records: any[]
  /** Sections inside this one: child values of a tree, then the next level. */
  children: SectionNode[]
}

const DAY = 86_400_000

const toDate = (value: string): Date | null => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const date = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) : new Date(/^\d+$/.test(value) ? Number(value) : value)
  return Number.isNaN(date.getTime()) ? null : date
}
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const pad = (value: number) => String(value).padStart(2, '0')
const dayId = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const startOfWeek = (date: Date) => { const day = startOfDay(date); day.setDate(day.getDate() - ((day.getDay() + 6) % 7)); return day }

const dated = (place: (date: Date) => BucketKey) => (value: string) => { const date = toDate(value); return date ? place(date) : null }
/** The span of time from `start` up to (not including) `end`, as a rule holds it. */
const span = (start: Date, end: Date) => ({min: start.getTime(), max: end.getTime() - 1})
const addDays = (date: Date, days: number) => { const next = new Date(date); next.setDate(next.getDate() + days); return next }

/** How long ago, the way Finder and Mail head their lists. */
function relative(date: Date, now = new Date()): BucketKey {
  const today = startOfDay(now)
  const day = startOfDay(date)
  const ago = Math.round((today.getTime() - day.getTime()) / DAY)
  const tomorrow = addDays(today, 1)
  if (ago <= 0) return {value: 'today', label: 'Today', order: 0, range: span(today, tomorrow)}
  if (ago === 1) return {value: 'yesterday', label: 'Yesterday', order: 1, range: span(addDays(today, -1), today)}
  if (ago < 7) return {value: 'week', label: 'Previous 7 days', order: 2, range: span(addDays(today, -6), addDays(today, -1))}
  if (ago < 30) return {value: 'month', label: 'Previous 30 days', order: 3, range: span(addDays(today, -29), addDays(today, -6))}
  if (date.getFullYear() === now.getFullYear()) {
    const month = new Date(date.getFullYear(), date.getMonth(), 1)
    return {value: `m${date.getMonth()}`, label: date.toLocaleDateString(undefined, {month: 'long'}), order: 4 + (11 - date.getMonth()), range: span(month, new Date(date.getFullYear(), date.getMonth() + 1, 1))}
  }
  return {value: `y${date.getFullYear()}`, label: String(date.getFullYear()), order: 20 + (now.getFullYear() - date.getFullYear()), range: span(new Date(date.getFullYear(), 0, 1), new Date(date.getFullYear() + 1, 0, 1))}
}

/** Date buckets, newest section first; a day is the usual choice. */
export const DATE_BUCKETS: GroupBucket[] = [
  {id: 'day', label: 'Day', icon: 'calendar-days', key: dated(date => { const day = startOfDay(date); return {value: dayId(day), label: day.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'}), order: -day.getTime(), range: span(day, addDays(day, 1))} })},
  {id: 'week', label: 'Week', icon: 'calendar-range', key: dated(date => { const week = startOfWeek(date); return {value: dayId(week), label: `Week of ${week.toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'})}`, order: -week.getTime(), range: span(week, addDays(week, 7))} })},
  {id: 'month', label: 'Month', icon: 'calendar', key: dated(date => { const month = new Date(date.getFullYear(), date.getMonth(), 1); return {value: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`, label: date.toLocaleDateString(undefined, {month: 'long', year: 'numeric'}), order: -month.getTime(), range: span(month, new Date(date.getFullYear(), date.getMonth() + 1, 1))} })},
  {id: 'year', label: 'Year', icon: 'calendar-fold', key: dated(date => ({value: String(date.getFullYear()), label: String(date.getFullYear()), order: -date.getFullYear(), range: span(new Date(date.getFullYear(), 0, 1), new Date(date.getFullYear() + 1, 0, 1))}))},
  {id: 'relative', label: 'How long ago', icon: 'history', key: dated(date => relative(date))},
]

/** How a field whose values sit inside other values (projects in projects) groups. */
export const TREE_BUCKETS: GroupBucket[] = [
  {id: 'nested', label: 'Inside their parents', icon: 'list-tree', tree: 'nested'},
  {id: 'top', label: 'Top level only', icon: 'folder', tree: 'top'},
  {id: 'own', label: 'Each on its own', icon: 'folders', tree: 'own'},
]

const hasTree = (field: GroupableField) => Object.values(field.values ?? {}).some(row => !!row?.parent)

/** The buckets a field offers: its own rows, a tree's, a date's, or none. */
export function bucketsFor(field: GroupableField, isDate: boolean): GroupBucket[] {
  return field.groupBuckets ?? (hasTree(field) ? TREE_BUCKETS : isDate ? DATE_BUCKETS : [])
}

/** The chain from a value's top-level ancestor down to the value. */
export function ancestry(field: GroupableField, value: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let at: string | undefined = value
  while (at && !seen.has(at)) { seen.add(at); chain.unshift(at); at = field.values?.[at]?.parent }
  return chain
}

/** Words for a value: its own label, not its path. */
const labelOf = (field: GroupableField, value: string, readable: (value: string) => string) => field.values?.[value]?.label ?? readable(value)

export type GroupingInput = {
  levels: GroupLevel[]
  /** Saved configuration context; omitted callers keep their existing local calendar. */
  timeZone?: string
  now?: number
  fieldOf: (id: string) => GroupableField | undefined
  /** The raw values a record holds for a field (already local-day keys for dates). */
  valuesOf: (field: GroupableField, record: any) => string[]
  isDate: (field: GroupableField) => boolean
  /** Declared-then-natural order of plain values. */
  compare: (field: GroupableField) => (left: string, right: string) => number
  /** Words for a value nobody labelled. */
  readable: (field: GroupableField, value: string) => string
}

type Step = {value: string; label: string; order: number | null; range?: {min: number; max: number}}
type Draft = Step & {records: any[]; children: Map<string, Draft>}

// The projection engine owns the bucket key and its instant boundaries. The
// surface only supplies the words, so opening the same configuration in another
// zone cannot change either the record's section or that section's filter.
function dateBucketInZone(key: string, bucket: string, timeZone: string, now: number): BucketKey | null {
  const range = calendarBucketSpan(key, bucket, timeZone, now)
  if (!range) return null
  const at = new Date(`${range.start}T12:00:00Z`)
  const format = (options: Intl.DateTimeFormatOptions) => at.toLocaleDateString(undefined, {...options, timeZone: 'UTC'})
  const relativeNames: Record<string, string> = {today: 'Today', yesterday: 'Yesterday', week: 'Previous 7 days', month: 'Previous 30 days'}
  const relativeRank = ['today', 'yesterday', 'week', 'month'].indexOf(key)
  const label = bucket === 'relative' ? relativeNames[key] ?? format({month: 'long', year: 'numeric'})
    : bucket === 'week' ? `Week of ${format({month: 'short', day: 'numeric', year: 'numeric'})}`
    : bucket === 'month' ? format({month: 'long', year: 'numeric'})
    : bucket === 'year' ? key : format({weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'})
  const order = bucket === 'relative' ? relativeRank >= 0 ? relativeRank : 4 + (now - range.min) / DAY : -range.min
  return {value: key, label, order, range: {min: range.min, max: range.max}}
}

/** Nested sections for `records`, one tree per level, the next level inside each. */
export function buildSections(records: any[], input: GroupingInput, depth = 0, prefix = ''): SectionNode[] {
  const [level, ...rest] = input.levels
  const field = level && input.fieldOf(level.field)
  if (!field) return []
  const buckets = bucketsFor(field, input.isDate(field))
  const bucket = buckets.find(row => row.id === level.bucket) ?? buckets[0]
  const zonedDate = input.timeZone && input.isDate(field) && !field.groupBuckets && !hasTree(field)
  const now = input.now ?? Date.now()
  const placedDates = new Map<string, BucketKey | null>()
  const roots = new Map<string, Draft>()
  const place = (path: Step[], record: any) => {
    let map = roots
    let draft: Draft | undefined
    for (const step of path) {
      draft = map.get(step.value)
      if (!draft) { draft = {...step, records: [], children: new Map()}; map.set(step.value, draft) }
      map = draft.children
    }
    if (draft && !draft.records.includes(record)) draft.records.push(record)
  }
  const readable = (value: string) => input.readable(field, value)
  for (const record of records) {
    const values = input.valuesOf(field, record)
    if (!values.length) { place([{value: '', label: `No ${field.label.toLocaleLowerCase()}`, order: Number.POSITIVE_INFINITY}], record); continue }
    for (const value of values) {
      if (bucket?.tree) {
        const chain = bucket.tree === 'own' ? [value] : bucket.tree === 'top' ? ancestry(field, value).slice(0, 1) : ancestry(field, value)
        place(chain.map(step => ({value: step, label: labelOf(field, step, readable), order: null})), record)
      } else if (bucket?.key) {
        let placed: BucketKey | null
        if (zonedDate) {
          const key = calendarBucket(value, bucket.id, input.timeZone!, now)
          if (!placedDates.has(key)) placedDates.set(key, dateBucketInZone(key, bucket.id, input.timeZone!, now))
          placed = placedDates.get(key)!
        } else placed = bucket.key(value)
        place([placed ? {value: placed.value, label: placed.label, order: placed.order, range: placed.range} : {value: '', label: `No ${field.label.toLocaleLowerCase()}`, order: Number.POSITIVE_INFINITY}], record)
      } else {
        place([{value, label: labelOf(field, value, readable), order: null}], record)
      }
    }
  }
  if (level.show_empty_choices && !bucket?.tree && !bucket?.key) {
    for (const value of Object.keys(field.values ?? {})) {
      if (!roots.has(value)) roots.set(value, {value, label: labelOf(field, value, readable), order: null, records: [], children: new Map()})
    }
  }
  const compare = input.compare(field)
  const sortDrafts = (drafts: Draft[]) => drafts.sort((left, right) => {
    if (left.value === '' || right.value === '') return left.value === '' ? 1 : -1
    if (left.order !== null && right.order !== null) return left.order - right.order
    return compare(left.value, right.value)
  })
  const finish = (draft: Draft, at: number, path: string): SectionNode => {
    const key = `${path}/${field.id}:${draft.value}`
    const treeChildren = sortDrafts([...draft.children.values()]).map(child => finish(child, at + 1, key))
    const nextLevel = rest.length && draft.records.length ? buildSections(draft.records, {...input, levels: rest}, at + 1, key) : []
    const all = new Set<any>(draft.records)
    const collect = (nodes: SectionNode[]) => { for (const node of nodes) { for (const record of node.records) all.add(record); collect(node.children) } }
    collect(treeChildren)
    return {
      key,
      value: draft.value,
      label: draft.label,
      fieldId: field.id,
      depth: at,
      count: all.size,
      ...(draft.range ? {range: draft.range} : {}),
      records: nextLevel.length ? [] : draft.records,
      children: [...nextLevel, ...treeChildren],
    }
  }
  return sortDrafts([...roots.values()]).map(draft => finish(draft, depth, prefix))
}

/** Every record inside a section, in arrival order, once. */
export function recordsIn(node: SectionNode): any[] {
  const out = new Set<any>(node.records)
  for (const child of node.children) for (const record of recordsIn(child)) out.add(record)
  return [...out]
}

export type SectionBlock =
  | {kind: 'heading'; node: SectionNode; collapsed: boolean}
  | {kind: 'records'; key: string; depth: number; records: any[]}

/** Sections as the run of headings and record blocks a view draws, skipping
 *  what sits inside a collapsed section. */
export function flattenSections(nodes: SectionNode[], collapsed: ReadonlySet<string>): SectionBlock[] {
  const out: SectionBlock[] = []
  const visit = (node: SectionNode) => {
    const closed = collapsed.has(node.key)
    out.push({kind: 'heading', node, collapsed: closed})
    if (closed) return
    if (node.records.length) out.push({kind: 'records', key: `${node.key}#records`, depth: node.depth + 1, records: node.records})
    for (const child of node.children) visit(child)
  }
  for (const node of nodes) visit(node)
  return out
}
