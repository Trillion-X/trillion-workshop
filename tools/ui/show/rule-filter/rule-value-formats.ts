// packages/ui/show/rule-filter/rule-value-formats.ts
//
// Purpose
//   How a filter shows and reads a measured number for each kind of field: a
//   length reads "1:30", a file size "250 MB", a date "Sep 26, 2026". The rule
//   tree always holds the plain number the facts hold (seconds, bytes,
//   milliseconds since 1970); only the words a person sees and types change.
//
// Non-negotiable invariants
//   - One row per field kind. A kind with no row reads and writes plain
//     numbers with the field's unit, so a new kind works before it has a row.
//   - `parse` never guesses: text it cannot read returns null and the control
//     keeps the last good value.

export type ValueFormat = {
  format: (value: number, unit?: string) => string
  parse: (text: string) => number | null
  /** Slider step in the fact's own unit. */
  step: number
  /** Slider bounds when the facts have not said what exists yet. */
  fallbackRange: [number, number]
  placeholder: string
  /** Round a slider position to a value worth showing (whole seconds, whole MB). */
  snap?: (value: number) => number
}

const plainNumber = (text: string) => {
  const value = Number(text.trim().replace(/,/g, ''))
  return text.trim() !== '' && Number.isFinite(value) ? value : null
}

const DURATION_UNITS: Record<string, number> = {s: 1, sec: 1, second: 1, seconds: 1, m: 60, min: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600}
const BYTE_UNITS: Record<string, number> = {b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12}

function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds))
  const hours = Math.floor(whole / 3600), minutes = Math.floor((whole % 3600) / 60), rest = whole % 60
  const two = (part: number) => String(part).padStart(2, '0')
  return hours ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`
}

function parseDuration(text: string) {
  const trimmed = text.trim().toLowerCase()
  if (/^\d+(:\d{1,2}){1,2}$/.test(trimmed)) return trimmed.split(':').reduce((total, part) => total * 60 + Number(part), 0)
  const unit = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/.exec(trimmed)
  if (unit && DURATION_UNITS[unit[2]]) return Number(unit[1]) * DURATION_UNITS[unit[2]]
  return plainNumber(trimmed)
}

function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes, at = 0
  while (Math.abs(value) >= 1000 && at < units.length - 1) { value /= 1000; at += 1 }
  return `${value >= 100 || at === 0 ? Math.round(value) : Number(value.toFixed(1))} ${units[at]}`
}

function parseBytes(text: string) {
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b)?$/i.exec(text.trim())
  if (!match) return null
  return Number(match[1]) * (match[2] ? BYTE_UNITS[match[2].toLowerCase()] : 1e6)
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', year: 'numeric'})

function parseDate(text: string) {
  const trimmed = text.trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(trimmed)
  const time = iso ? new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])).getTime() : Date.parse(trimmed)
  return trimmed && Number.isFinite(time) ? time : null
}

const round = (value: number, places: number) => Number(value.toFixed(places))

export const VALUE_FORMATS: Record<string, ValueFormat> = {
  duration: {format: formatDuration, parse: parseDuration, step: 1, fallbackRange: [0, 3600], placeholder: '1:30', snap: Math.round},
  bytes: {format: formatBytes, parse: parseBytes, step: 1e6, fallbackRange: [0, 10e9], placeholder: '250 MB', snap: value => Math.round(value / 1e6) * 1e6},
  date: {format: value => DAY_FORMAT.format(value), parse: parseDate, step: 86400000, fallbackRange: [Date.now() - 365 * 86400000, Date.now()], placeholder: 'YYYY-MM-DD'},
}

export const NUMBER_FORMAT: ValueFormat = {
  format: (value, unit) => `${round(value, Math.abs(value) >= 100 ? 0 : 1)}${unit ? ' ' + unit : ''}`,
  parse: plainNumber,
  step: 0.1,
  fallbackRange: [0, 100],
  placeholder: 'Number',
  snap: value => round(value, 1),
}

export const formatFor = (kind: string | undefined): ValueFormat => VALUE_FORMATS[kind ?? ''] ?? NUMBER_FORMAT
