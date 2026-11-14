import React, {useState} from 'react'
import {DatePicker} from '../date-picker/DatePicker'
import {TimePicker} from '../date-picker/TimePicker'
import {Button} from '../coss/ui/button'
import {Input} from '../coss/ui/input'
import units from 'trillion-workshop/tools/keep-lists-of-rows/source-data/view-time-units.json'

export type SavedViewTime = {field: string; after?: {value?: string; binding?: unknown; refs?: unknown[]}; before?: {value?: string; binding?: unknown; refs?: unknown[]}} | null
type TimeField = {id: string; label: string}

const ownDay = (value: unknown) => {
  if (typeof value !== 'string') return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return ''
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}
const ownTime = (value: unknown) => {
  if (typeof value !== 'string' || !value.includes('T')) return ''
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) return ''
  const minutes = `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
  return parsed.getSeconds() || parsed.getMilliseconds() ? `${minutes}:${String(parsed.getSeconds()).padStart(2, '0')}${parsed.getMilliseconds() ? `.${String(parsed.getMilliseconds()).padStart(3, '0')}` : ''}` : minutes
}
const instant = (day: string, time: string, end: boolean) => day ? new Date(`${day}T${time || (end ? '23:59:59.999' : '00:00:00')}`).toISOString() : undefined
const clock = { $kind: 'binding', select: {from: 'self', path: ['now']} }
const rollingWindow = (value?: SavedViewTime) => {
  const after = value?.after?.binding as {select?: unknown; transform?: {op?: string; args?: {value?: number}}[]} | undefined
  const before = value?.before?.binding as {select?: unknown; transform?: unknown[]} | undefined
  if (!after || !before || value?.after?.refs?.length || value?.before?.refs?.length ||
      JSON.stringify(after.select) !== JSON.stringify(clock.select) ||
      JSON.stringify(before.select) !== JSON.stringify(clock.select) || before.transform?.length ||
      after.transform?.length !== 1 || after.transform[0]?.op !== 'op:core.sub') return null
  const duration = after.transform[0]?.args?.value
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return null
  const unit = [...units.units].reverse().find(row => duration % row.milliseconds === 0) ?? units.units[0]
  return {amount: duration / unit.milliseconds, unit: unit.id}
}

/** Plain controls over the same saved time expression an AI writes. DatePicker
 *  supplies calendar days; time is optional, so an end day includes its end. */
export function SavedViewTimeEditor({fields, value, onSave, onCancel, busy = false}: {fields: TimeField[]; value?: SavedViewTime; onSave: (time: SavedViewTime) => void | Promise<void>; onCancel: () => void; busy?: boolean}) {
  const initialRolling = rollingWindow(value)
  const custom = Boolean(value && (value.after?.binding || value.before?.binding) && !initialRolling)
  const [mode, setMode] = useState(custom ? 'formula' : initialRolling ? 'rolling' : 'dates')
  const [field, setField] = useState(value?.field ?? fields[0]?.id ?? '')
  const [afterDay, setAfterDay] = useState(ownDay(value?.after?.value))
  const [afterTime, setAfterTime] = useState(ownTime(value?.after?.value))
  const [beforeDay, setBeforeDay] = useState(ownDay(value?.before?.value))
  const [beforeTime, setBeforeTime] = useState(ownTime(value?.before?.value))
  const [amount, setAmount] = useState(initialRolling?.amount ?? 7)
  const [unit, setUnit] = useState(initialRolling?.unit ?? units.units[2].id)
  const [error, setError] = useState<string | null>(null)
  const save = () => {
    if (!field || busy) return
    setError(null)
    if (mode === 'formula') { onSave(value ?? null); return }
    if (mode === 'rolling') {
      const milliseconds = units.units.find(row => row.id === unit)?.milliseconds ?? units.units[2].milliseconds
      onSave({field, after: {binding: {...clock, transform: [{op: 'op:core.sub', args: {value: Math.max(1, amount) * milliseconds}}]}}, before: {binding: clock}})
      return
    }
    const after = instant(afterDay, afterTime, false)
    const before = instant(beforeDay, beforeTime, true)
    if (after && before && after > before) { setError('The time range starts after it ends.'); return }
    onSave(after || before ? {field, ...(after ? {after: {value: after}} : {}), ...(before ? {before: {value: before}} : {})} : null)
  }
  return <form className="record-views-time-editor" aria-label="Time range" onSubmit={event => {event.preventDefault(); save()}}><fieldset disabled={busy}>
    <label>Time field<select value={field} onChange={event => setField(event.target.value)}>{fields.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>
    <label>Range<select value={mode} onChange={event => setMode(event.target.value)}><option value="dates">Choose dates</option><option value="rolling">Rolling window</option>{custom && <option value="formula">Custom formula</option>}</select></label>
    {mode === 'rolling' ? <div className="record-views-time-line"><span>Last</span><Input aria-label="Amount" type="number" min={1} value={amount} onChange={event => setAmount(Number(event.target.value))}/><select aria-label="Unit" value={unit} onChange={event => setUnit(event.target.value)}>{units.units.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}</select></div> : mode === 'formula' ? <p>This range follows a formula or event. Your AI can change its rule.</p> : <>
      <div className="record-views-time-line"><span>From</span><DatePicker aria-label="Start date" value={afterDay || null} max={beforeDay || null} onChange={day => setAfterDay(day ?? '')}/><TimePicker aria-label="Start time" value={afterTime} onChange={time => setAfterTime(time ?? '')}/></div>
      <div className="record-views-time-line"><span>To</span><DatePicker aria-label="End date" value={beforeDay || null} min={afterDay || null} onChange={day => setBeforeDay(day ?? '')}/><TimePicker aria-label="End time" value={beforeTime} onChange={time => setBeforeTime(time ?? '')}/></div>
    </>}
    {error && <p role="alert">{error}</p>}
    <div className="record-views-time-line"><Button type="submit" variant="outline" size="sm" disabled={busy || !field}>{busy ? 'Saving…' : 'Save range'}</Button><Button type="button" variant="ghost" size="sm" onClick={() => onSave(null)}>Clear range</Button><Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button></div>
  </fieldset></form>
}
