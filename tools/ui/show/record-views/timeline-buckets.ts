// packages/ui/show/record-views/timeline-buckets.ts
//
// Purpose
//   Cuts a run of dated records into the calendar stretches one zoom level of
//   a timeline names: a few hours, a day, a week, a month, a year, a decade, a
//   century. Which stretch each level uses, how big its tiles are and how its
//   heading reads are DATA (timeline-zoom-levels.json); this file only knows
//   how a calendar unit and a span turn one instant into a bucket.
//
// Non-negotiable invariants
//   - Buckets are local calendar time, the same days the date filter and the
//     date grouping use.
//   - A level is a unit plus a span; decades and centuries are years with a
//     span, three-hour moments are hours with a span. No level is named here.
//   - Records keep the order they arrived in; buckets only describe that run.

export type TimelineUnit = 'hour' | 'day' | 'week' | 'month' | 'year'

export type TimelineLevel = {
  id: string
  label: string
  /** The smallest a tile may be at this level; the row fits as many as fit. */
  tile_px: number
  /** At this level a tile is only its picture: no selection box, row menu or
   *  hover card, which a far zoom has no room for and which would multiply by
   *  the thousands of tiles on screen. Clicking, range selection and the
   *  right-click menu still work. */
  picture_only?: boolean
  group: {unit: TimelineUnit | string; span: number}
  heading: {
    format?: Intl.DateTimeFormatOptions
    /** A second format for the end of a stretch ("Mon, Sep 26, 3 PM – 6 PM"). */
    range_end_format?: Intl.DateTimeFormatOptions
    prefix?: string
    /** Headings that read as the first year of the span plus a suffix: "2020s". */
    span_start_suffix?: string
  }
}

export type TimelineLevels = {default_level: string; levels: TimelineLevel[]; undated_heading: string}

export type TimelineBucket = {key: string; start: number; label: string}

/** The first instant of the stretch holding `time` at this level. */
export function bucketStart(time: number, group: TimelineLevel['group']): Date {
  const date = new Date(time)
  const span = Math.max(1, Math.floor(group.span || 1))
  switch (group.unit) {
    case 'hour': return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() - (date.getHours() % span))
    case 'day': return new Date(date.getFullYear(), date.getMonth(), date.getDate())
    case 'week': {
      // The week the person's locale starts on (Monday by ISO where the
      // runtime does not say), so a week heading names its first day.
      const first = weekStartDay()
      const back = (date.getDay() - first + 7) % 7
      return new Date(date.getFullYear(), date.getMonth(), date.getDate() - back)
    }
    case 'month': return new Date(date.getFullYear(), date.getMonth() - (date.getMonth() % span), 1)
    default: return new Date(date.getFullYear() - (date.getFullYear() % span), 0, 1)
  }
}

let cachedWeekStart: number | null = null
function weekStartDay(): number {
  if (cachedWeekStart !== null) return cachedWeekStart
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & {getWeekInfo?: () => {firstDay: number}; weekInfo?: {firstDay: number}}
    const info = locale.getWeekInfo?.() ?? locale.weekInfo
    cachedWeekStart = info ? info.firstDay % 7 : 1
  } catch { cachedWeekStart = 1 }
  return cachedWeekStart
}

const formatters = new Map<string, Intl.DateTimeFormat>()
const formatter = (options: Intl.DateTimeFormatOptions) => {
  const key = JSON.stringify(options)
  let found = formatters.get(key)
  if (!found) { found = new Intl.DateTimeFormat(undefined, options); formatters.set(key, found) }
  return found
}

/** The heading a stretch reads as at this level. */
export function bucketLabel(start: Date, level: TimelineLevel): string {
  const heading = level.heading
  if (heading.span_start_suffix !== undefined) return `${start.getFullYear()}${heading.span_start_suffix}`
  const text = formatter(heading.format ?? {dateStyle: 'medium'}).format(start)
  const end = heading.range_end_format && level.group.unit === 'hour'
    ? ` – ${formatter(heading.range_end_format).format(new Date(start.getTime() + Math.max(1, level.group.span) * 3_600_000))}`
    : ''
  return `${heading.prefix ?? ''}${text}${end}`
}

/** The bucket one instant falls in at this level; null time is undated. */
export function bucketFor(time: number | null, level: TimelineLevel, undatedHeading: string): TimelineBucket {
  if (time === null || !Number.isFinite(time)) return {key: 'undated', start: Number.NEGATIVE_INFINITY, label: undatedHeading}
  const start = bucketStart(time, level.group)
  return {key: String(start.getTime()), start: start.getTime(), label: bucketLabel(start, level)}
}

/** Whichever level is nearest to a stored or requested id; the default otherwise. */
export function levelIndex(levels: TimelineLevels, id: string | undefined): number {
  const found = levels.levels.findIndex(level => level.id === id)
  if (found >= 0) return found
  const fallback = levels.levels.findIndex(level => level.id === levels.default_level)
  return fallback >= 0 ? fallback : 0
}
