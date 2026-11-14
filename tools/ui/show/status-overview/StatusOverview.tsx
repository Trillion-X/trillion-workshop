// parts/ui/show/status-overview/StatusOverview.tsx
//
// Purpose
//   One glance at a body of work: what needs the person now, what is moving,
//   what finished lately. A row of stat cards (one per section that holds
//   anything), one proportional strip, then short lists per section, newest or
//   oldest first, each able to show the rest in place.
//
// Reference anatomy (inspiration only, original code)
//   - 21st.dev 28770 "App Dashboard Layout" (shadcnstore): stat cards with a
//     label, one large figure and a quiet detail line; "Recent activity" rows.
//   - 21st.dev 29473 "Share Strip" (eugeneshilow): one hard-bordered strip
//     whose segments show how the whole divides.
//   - Linear "My issues" grouped list (mobbin fd1b4d88, ef923b0e) and Asana
//     home "My tasks" (mobbin fedd964a): a small section header with a count,
//     one line per item, the time on the right.
//
// Non-negotiable invariants
//   1. Blind: every state, label, tone, section and its order is caller DATA
//      (`looks`). Nothing here names a state or branches on one.
//   2. Empty sections are not drawn; zero is never shown as a figure. A
//      section may carry `empty` copy, drawn only in its list.
//   3. Tones are names in the shared record-kind palette, resolved through one
//      CSS custom property, so a new tone is a palette row, not a rule here.
//   4. Records are the caller's real items; this component invents none.

import React from 'react'
import {Card} from '../coss/ui/card'
import {Button} from '../coss/ui/button'
import {mountSharedContent} from '../coss/shared-content'
import {EmptyState, type EmptyStateOptions} from '../empty-state'

export type StatusLook = {label: string; tone?: string; section?: string; working?: boolean}
export type OverviewSection = {
  id: string
  label: string
  /** The shorter name used on the stat card, when the list heading is longer. */
  stat_label?: string
  /** Copy for the list when this section holds nothing. Without it the list is not drawn. */
  empty?: string
  /** Whether the section is listed below the cards, or only counted. */
  list?: boolean
  /** Items shown before "Show all". */
  limit?: number
  /** Direction of the list by `since`: the two directions time has. */
  order?: 'newest-first' | 'oldest-first'
}
export type StatusLooks = {states: Record<string, StatusLook>; sections: OverviewSection[]}
export type OverviewRecord = {id: string; title: string; status: string; detail?: string; since?: string | null}
export type OverviewAside = {label: string; items: Array<{label: string; value: number}>}
export type StatusOverviewOptions = {
  label: string
  looks: StatusLooks
  records: OverviewRecord[]
  /** A small secondary card of counts; zero counts are left out. */
  aside?: OverviewAside
  empty?: EmptyStateOptions
}

const toneStyle = (tone?: string) =>
  ({'--status-tone': `var(--record-kind-${tone || 'grey'}, var(--record-kind-grey))`}) as React.CSSProperties

const number = new Intl.NumberFormat()
const relative = new Intl.RelativeTimeFormat(undefined, {numeric: 'auto', style: 'short'})
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [['year', 31536e6], ['month', 2592e6], ['week', 6048e5], ['day', 864e5], ['hour', 36e5], ['minute', 6e4]]

/** "3 days ago", "yesterday", "just now", from a timestamp; null when unknown. */
export function sinceLabel(since: string | null | undefined, now = Date.now()): string | null {
  const time = since ? Date.parse(since) : NaN
  if (!Number.isFinite(time)) return null
  const elapsed = time - now
  for (const [unit, size] of UNITS) if (Math.abs(elapsed) >= size) return relative.format(Math.round(elapsed / size), unit)
  return relative.format(0, 'minute')
}

type Bucket = {section: OverviewSection; records: OverviewRecord[]; parts: Array<{label: string; tone?: string; count: number}>}

/** Sort each record into its section and count its visible labels, in DATA order. */
export function bucketRecords(looks: StatusLooks, records: OverviewRecord[]): Bucket[] {
  const buckets = new Map(looks.sections.map(section => [section.id, {section, records: [] as OverviewRecord[], parts: [] as Bucket['parts']}]))
  for (const record of records) {
    const look = looks.states[record.status]
    const bucket = look?.section ? buckets.get(look.section) : undefined
    if (!bucket || !look) continue
    bucket.records.push(record)
    const part = bucket.parts.find(item => item.label === look.label)
    if (part) part.count += 1
    else bucket.parts.push({label: look.label, tone: look.tone, count: 1})
  }
  for (const bucket of buckets.values()) {
    const direction = bucket.section.order === 'oldest-first' ? 1 : -1
    bucket.records.sort((left, right) => direction * String(left.since ?? '').localeCompare(String(right.since ?? '')))
  }
  return [...buckets.values()]
}

function StatCard({bucket}: {bucket: Bucket}) {
  const {section, records, parts} = bucket
  const latest = sinceLabel([...records].map(record => record.since).filter(Boolean).sort().at(-1))
  const detail = parts.length > 1
    ? parts.map(part => `${number.format(part.count)} ${part.label.toLowerCase()}`).join(' · ')
    : latest && `Latest ${latest}`
  return <Card className="status-overview-stat" style={toneStyle(parts[0]?.tone)}>
    <span className="status-overview-stat-label"><i className="status-overview-dot" aria-hidden="true"/>{section.stat_label ?? section.label}</span>
    <strong className="status-overview-stat-value">{number.format(records.length)}</strong>
    {detail && <small className="status-overview-stat-detail">{detail}</small>}
  </Card>
}

function ShareStrip({buckets, label}: {buckets: Bucket[]; label: string}) {
  const parts = buckets.flatMap(bucket => bucket.parts)
  const total = parts.reduce((sum, part) => sum + part.count, 0)
  if (!total) return null
  const summary = parts.map(part => `${part.count} ${part.label.toLowerCase()}`).join(', ')
  return <div className="status-overview-strip" role="img" aria-label={`${label}: ${summary}`}>
    {parts.map(part => <span key={part.label} title={`${number.format(part.count)} ${part.label.toLowerCase()}`}
      style={{...toneStyle(part.tone), flexGrow: part.count}}/>)}
  </div>
}

function SectionList({bucket, looks}: {bucket: Bucket; looks: StatusLooks}) {
  const [open, setOpen] = React.useState(false)
  const {section, records} = bucket
  if (!records.length && !section.empty) return null
  const limit = section.limit ?? records.length
  const shown = open ? records : records.slice(0, limit)
  return <section className="status-overview-section" aria-label={section.label}>
    <header className="status-overview-section-header">
      <h3>{section.label}</h3>
      {records.length > 0 && <span className="status-overview-count">{number.format(records.length)}</span>}
    </header>
    {records.length === 0 ? <p className="status-overview-empty">{section.empty}</p> : <ul>
      {shown.map(record => {
        const look = looks.states[record.status]
        const when = sinceLabel(record.since)
        return <li key={record.id} style={toneStyle(look?.tone)}>
          <i className="status-overview-dot" aria-hidden="true"/>
          <span className="status-overview-item">
            <span className="status-overview-title">{record.title}</span>
            {record.detail && <small className="status-overview-detail">{record.detail}</small>}
          </span>
          <span className="status-overview-meta">
            {bucket.parts.length > 1 && look && <small className="status-overview-state">{look.label}</small>}
            {when && <time dateTime={record.since ?? undefined}>{when}</time>}
          </span>
        </li>
      })}
    </ul>}
    {records.length > limit && <Button variant="ghost" size="sm" className="status-overview-more" onClick={() => setOpen(value => !value)}>
      {open ? 'Show fewer' : `Show all ${number.format(records.length)}`}
    </Button>}
  </section>
}

function Aside({aside}: {aside: OverviewAside}) {
  const items = aside.items.filter(item => item.value > 0)
  if (!items.length) return null
  return <Card className="status-overview-aside" aria-label={aside.label}>
    <span className="status-overview-aside-label">{aside.label}</span>
    <span className="status-overview-aside-items">{items.map(item => <span key={item.label}><strong>{number.format(item.value)}</strong> {item.label}</span>)}</span>
  </Card>
}

export function StatusOverview({label, looks, records, aside}: StatusOverviewOptions) {
  const buckets = bucketRecords(looks, records)
  const counted = buckets.filter(bucket => bucket.records.length)
  return <section className="status-overview" aria-label={label}>
    <div className="status-overview-stats">{counted.map(bucket => <StatCard key={bucket.section.id} bucket={bucket}/>)}</div>
    <ShareStrip buckets={counted} label={label}/>
    <div className="status-overview-sections">
      {buckets.filter(bucket => bucket.section.list).map(bucket => <SectionList key={bucket.section.id} bucket={bucket} looks={looks}/>)}
    </div>
    {aside && <Aside aside={aside}/>}
  </section>
}

/** Mount the overview into any host. With no records it is the shared empty state. */
export function mountStatusOverview(node: HTMLElement, options: StatusOverviewOptions) {
  if (!options.records.length) return mountSharedContent(node, <EmptyState {...(options.empty || {})}/>)
  return mountSharedContent(node, <StatusOverview {...options}/>)
}
