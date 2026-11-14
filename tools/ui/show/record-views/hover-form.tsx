// parts/ui/show/record-views/hover-form.tsx
//
// PURPOSE
//   A value in a record list that asks for something ("Your answer needed") answers it in place: hovering the value
//   opens a small popover holding what the person needs to know to answer and the box to answer in, and pressing the
//   value opens the same popover for touch and keyboard. The caller describes the form per record as DATA
//   (`FieldDescriptor.hoverForm`); this file draws it and never knows what is being asked.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Nothing in the popover reaches the row behind it: typing, clicking and double-clicking inside never select,
//      drag or open the record (the popover is portalled, and React events still bubble to the row without this).
//   2. A refusal is shown inside the popover, beside the answer that was refused, and the typed words are kept.
//   3. Once the caller's `run` resolves the popover closes; the caller refreshes its own records.
//   4. Words being typed are never lost to the pointer drifting away: once the box holds text, only Escape, a press
//      outside or sending closes it.
//   5. One form body (`HoverFormBody`) draws every such form, in the popover here and in place wherever a screen asks
//      it inline (the Waiting on you queue, src/workspace/waiting-screen.tsx): each box by its DATA `kind` (words,
//      a link, a file from the person's files through the shared file field, fetched the first time a form asks for
//      a file, a row that exists through the shared record picker, so a field that means a person or a customer is
//      chosen from the person's lists and never typed as free words), never a second form.
//   6. The boxes are one block (`record-hover-form-fields`) and the refusal and the send button another
//      (`record-hover-form-actions`), so a screen can scroll the boxes and keep the send row in view without restyling the
//      button: the send button is always the shared button's own primary face.
//   7. A box the person has not touched holds the form's `start` (a suggested row); touching it, even to clear it, is theirs.

import React, {useState} from 'react'
import { lazyPart } from '../load-later/later';
import {Popover, PopoverPopup, PopoverTrigger} from '../coss/ui/popover'
import {Textarea} from '../coss/ui/textarea'
import {Button} from '../coss/ui/button'
import {Input} from '../coss/ui/input'
import {DatePicker} from '../date-picker/DatePicker'
import type {FileFieldSource} from '../file-field'
import {AudioClipPlayer} from '../audio-clip-player/AudioClipPlayer'
import {RecordPicker} from '../record-picker/RecordPicker'
import {Text} from '../text'
import type {RecordFrom, RecordNew, RecordSource, RecordSuggestion} from 'trillion-workshop/tools/ui/show/record-picker/record-value.ts'

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
// The file box (the person's files, their folders tree) is fetched the first time a form asks for a file, so every
// record list that can draw a form does not carry it until one does.
const FileField = lazyPart(() => import('../file-field'), module => module.FileField)
/** One box of a form. `kind` says what it takes: words, a web address, a file, email, phone, number, date, one of
 *  `options` (`choice`), or yes/no (`boolean`). A file's value is its id and `takes` narrows its kind.
 *  `detail` is a short line under its label (what was said), and `clip` a sound to play before answering (a voice). */
export type HoverFormField = {
  name: string; label: string; placeholder?: string; optional?: boolean; kind?: string; takes?: string;
  options?: {value: string; label: string}[]; detail?: string; clip?: string
  /** `record`: where its rows come from, where a row that is not found is made, and what the card suggests. The value
   *  is the chosen row as text (record-picker/record-value.ts). */
  from?: RecordFrom; new?: RecordNew; suggestions?: RecordSuggestion[]
}

/** What one record's value asks for, and what answering it does. */
export type HoverForm = {
  /** The question, in the person's words. */
  title: string
  /** What the person needs in front of them to answer: each a short label and its text. Empty texts are left out. */
  details?: {label: string; text: string | null | undefined}[]
  /** The boxes to fill. One is usual. Every box must be filled to send, except one marked `optional`. */
  fields: HoverFormField[]
  /** Where a `file` box chooses or uploads from; without it a file box's buttons are off. */
  files?: FileFieldSource
  /** Where a `record` box searches and makes rows; without it a record box is a plain words box. */
  records?: RecordSource
  /** What a box holds before the person touches it (a row the caller suggests), by box name, in the text form the box
   *  keeps (a `record` box: record-picker/record-value.ts `encodeRecord`). A box the person changes or clears is theirs. */
  start?: Record<string, string>
  /** The words on the button that sends the answer. */
  submit: string
  /** Sends the answer. A thrown error's message is shown in the popover. */
  run: (values: Record<string, string>) => Promise<void>
}

const keepInside = {
  onClick: (event: React.SyntheticEvent) => event.stopPropagation(),
  onDoubleClick: (event: React.SyntheticEvent) => event.stopPropagation(),
  onPointerDown: (event: React.SyntheticEvent) => event.stopPropagation(),
  onKeyDown: (event: React.SyntheticEvent) => event.stopPropagation(),
  onDragStart: (event: React.SyntheticEvent) => event.stopPropagation(),
}

/** One form's boxes, its refusal and its send button: drawn in the popover below and in place by any screen. The values
 *  are the caller's (`values`, `onValues`), so a popover can keep them while it decides whether to close. */
export function HoverFormBody({form, values: typed, onValues, onSent, autoFocus = true, className = 'record-hover-form-body'}: {
  form: HoverForm
  values: Record<string, string>
  onValues: (next: (current: Record<string, string>) => Record<string, string>) => void
  onSent?: () => void
  autoFocus?: boolean
  className?: string
}) {
  // A box not yet touched holds the form's `start`; once touched (even cleared) it holds what the person left in it.
  const values = React.useMemo(() => ({...form.start, ...typed}), [form.start, typed])
  const [refusal, setRefusal] = useState('')
  const [sending, setSending] = useState(false)
  const ready = form.fields.every(field => field.optional || (values[field.name] ?? '').trim())
  const send = async () => {
    if (!ready || sending) return
    setSending(true)
    setRefusal('')
    try {
      await form.run(values)
      onValues(() => ({}))
      onSent?.()
    } catch (error) {
      setRefusal(errorWords(error))
    } finally {
      setSending(false)
    }
  }
  const set = (name: string, text: string) => onValues(current => ({...current, [name]: text}))
  const details = (form.details ?? []).filter(item => item.text && item.text.trim())
  return (
    <div className={className} data-slot="record-hover-form">
      <div className="record-hover-form-fields">
      {form.title ? <strong className="record-hover-form-title">{form.title}</strong> : null}
      {details.length > 0 && (
        <dl className="record-hover-form-details">
          {details.map(item => (
            <div key={item.label} className="record-hover-form-detail">
              <dt>{item.label}</dt>
              <dd>{item.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {form.fields.map((field, index) => field.kind === 'record' && field.from
        ? (
          <div key={field.name} className="record-hover-form-field" data-kind="record">
            <span className="record-hover-form-label block">{field.label}</span>
            {field.detail ? <Text variant="caption" color="muted" className="record-hover-form-field-detail block">{field.detail}</Text> : null}
            {field.clip ? <span className="record-hover-form-field-clip"><AudioClipPlayer src={field.clip}/></span> : null}
            <RecordPicker name={field.name} label={field.label} placeholder={field.placeholder} from={field.from} made={field.new} suggestions={field.suggestions}
              value={values[field.name] ?? ''} onChange={text => set(field.name, text)} source={form.records} autoFocus={autoFocus && index === 0} invalid={Boolean(refusal)} />
          </div>
        )
        : field.kind === 'file'
        ? (
          <div key={field.name} className="record-hover-form-field" data-kind="file">
            <React.Suspense fallback={<span className="record-hover-form-label">{field.label}</span>}>
              <FileField label={field.label} takes={field.takes} value={values[field.name] ?? ''} onChange={id => set(field.name, id)} source={form.files} />
            </React.Suspense>
          </div>
        )
        : (
          <label key={field.name} className="record-hover-form-field" data-kind={field.kind ?? 'long-text'}>
            <span className="record-hover-form-label block">{field.label}</span>
            {field.detail ? <Text variant="caption" color="muted" className="record-hover-form-field-detail block">{field.detail}</Text> : null}
            {field.clip ? <span className="record-hover-form-field-clip" onClick={event => event.preventDefault()}><AudioClipPlayer src={field.clip}/></span> : null}
            {field.kind === 'choice'
              ? <select
                  autoFocus={autoFocus && index === 0}
                  name={field.name}
                  value={values[field.name] ?? ''}
                  aria-invalid={refusal ? true : undefined}
                  onChange={event => set(field.name, event.currentTarget.value)}
                >
                  <option value="">{field.placeholder ?? 'Choose'}</option>
                  {(field.options ?? []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              : field.kind === 'boolean'
                ? <Input
                    autoFocus={autoFocus && index === 0}
                    name={field.name}
                    type="checkbox"
                    checked={(values[field.name] ?? '') === 'true'}
                    aria-invalid={refusal ? true : undefined}
                    onChange={event => set(field.name, event.currentTarget.checked ? 'true' : '')}
                  />
                : field.kind === 'date'
                  ? <DatePicker name={field.name} aria-label={field.label ?? field.name} value={values[field.name] || null}
                      aria-invalid={refusal ? true : undefined} placeholder={field.placeholder} onChange={day => set(field.name, day ?? '')} />
                : ['link', 'text', 'email', 'phone', 'number'].includes(field.kind ?? '')
                  ? <Input
                      autoFocus={autoFocus && index === 0}
                      name={field.name}
                      type={field.kind === 'link' ? 'url' : field.kind === 'phone' ? 'tel' : field.kind ?? 'text'}
                      placeholder={field.placeholder}
                      value={values[field.name] ?? ''}
                      aria-invalid={refusal ? true : undefined}
                      onChange={event => set(field.name, event.currentTarget.value)}
                      onKeyDown={event => { if (event.key === 'Enter') void send() }}
                    />
                  : <Textarea
                      autoFocus={autoFocus && index === 0}
                      name={field.name}
                      placeholder={field.placeholder}
                      value={values[field.name] ?? ''}
                      aria-invalid={refusal ? true : undefined}
                      onChange={event => set(field.name, event.currentTarget.value)}
                      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send() }}
                    />}
          </label>
        ))}
      </div>
      <div className="record-hover-form-actions">
        {refusal && <p className="record-hover-form-refusal" role="alert">{refusal}</p>}
        <Button className="record-hover-form-send" disabled={!ready || sending} onClick={() => send()}>
          {sending ? 'Saving…' : form.submit}
        </Button>
      </div>
    </div>
  )
}

export function HoverFormCell({form, children, trigger}: {form: HoverForm; children: React.ReactNode; trigger?: React.ReactElement}) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  return (
    <Popover open={open} onOpenChange={(next, details) => {
      const started = Object.values(values).some(value => value.trim())
      if (!next && started && (details.reason === 'trigger-hover' || details.reason === 'focus-out')) return
      setOpen(next)
    }}>
      <PopoverTrigger openOnHover delay={250} closeDelay={200} nativeButton={Boolean(trigger)} render={trigger ?? <span role="button" tabIndex={0}/>} className="record-hover-form-trigger" onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" sideOffset={6} className="record-hover-form" {...keepInside}>
        <HoverFormBody form={form} values={values} onValues={setValues} onSent={() => setOpen(false)} />
      </PopoverPopup>
    </Popover>
  )
}
