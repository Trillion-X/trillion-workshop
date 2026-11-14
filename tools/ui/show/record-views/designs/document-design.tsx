// parts/ui/show/record-views/designs/document-design.tsx
//
// PURPOSE
//   The `document` design (../view-designs): a whole list as one document to read and write, top to bottom in the
//   list's own order. Each record is a numbered part: its `title` the heading, its words (the `body` slot, else
//   `detail`) the paragraph under it, then the facts its other fields hold (as many as the list's zoom step shows).
//   Parts are sectioned by the person's Group by, each section headed by the group's value. Where the list keeps
//   changes, the heading and the paragraph are written in place (the shared InlineEditText: the words are the field)
//   and each change reaches the list; Open (`options.open`) opens the record.
//
// NON-NEGOTIABLE INVARIANTS
//   1. No list, field or product word: slots come from the row or the fields' roles, words from the list and options.
//   2. Only a field the list may write (it keeps changes and the field is not one it works out) is written in place.
//   3. Sections follow the order the grouping field declares its values, then the order records first name them.

import * as React from 'react'
import {Button} from '../../coss/ui/button'
import {InlineEditText} from '../../inline-edit-text/InlineEditText'
import {slotFields, valueOf, wordsOf, writable, type ViewDesignProps} from '../view-designs'
import type {FieldDescriptor} from '../record-views'

type DocumentOptions = {open?: string; untitled?: string; write_here?: string; empty?: string}

const SLOTS = ['title', 'body', 'detail'] as const

export function DocumentDesign({context, row}: ViewDesignProps) {
  const options = (row.options ?? {}) as DocumentOptions
  const slots = slotFields(row, context.fields, SLOTS)
  const title = slots.title
  const words = slots.body ?? slots.detail
  const section = context.fields.find(field => field.id === context.groupLevels?.[0]?.field)
  const facts = context.fields.filter(field => field !== title && field !== words && field !== section && field.id !== context.nesting?.field)
  const shownFacts = context.detail?.fields === null || context.detail === undefined ? facts : facts.slice(0, context.detail.fields)
  const save = (record: any, field: FieldDescriptor, next: string) => context.write!([{id: context.identify(record), values: {[field.id]: next}}])

  const sections = React.useMemo(() => {
    if (!section) return [{key: '', records: context.records}]
    const buckets = new Map<string, any[]>(Object.keys(section.values ?? {}).map(key => [key, []]))
    for (const record of context.records) {
      const raw = valueOf(section, record)
      const key = raw === null || raw === undefined || raw === '' ? '' : String(raw)
      buckets.set(key, [...(buckets.get(key) ?? []), record])
    }
    return [...buckets].filter(([, members]) => members.length).map(([key, members]) => ({key, records: members}))
  }, [context.records, section])

  if (!context.records.length) return <p className="record-views-design-empty">{options.empty ?? 'Nothing here yet.'}</p>
  let number = 0
  return (
    <div className="record-views-design record-views-document" data-design={row.design} aria-label={context.label}>
      {sections.map(({key, records}) => (
        <React.Fragment key={key || 'all'}>
          {section && key ? <h2 className="record-views-document-section">{section.values?.[key]?.label ?? key}</h2> : null}
          {records.map(record => {
            const id = context.identify(record)
            const heading = wordsOf(title, record)
            const paragraph = wordsOf(words, record)
            const shown = shownFacts.filter(field => wordsOf(field, record))
            number += 1
            return (
              <section key={id} className="record-views-document-part" data-record-id={id}>
                <h3 className="record-views-document-heading">
                  <span className="record-views-document-number">{number}</span>
                  {writable(context, title)
                    ? <InlineEditText variant="heading-lg" value={heading} aria-label={title.label} placeholder={options.untitled ?? 'Untitled'} onCommit={next => void save(record, title, next)}/>
                    : <span>{heading || options.untitled || id}</span>}
                  {context.open && options.open ? <Button type="button" variant="ghost" size="xs" onClick={() => context.open!(id)}>{options.open}</Button> : null}
                </h3>
                {writable(context, words)
                  ? <div className="record-views-document-words"><InlineEditText multiline variant="body" value={paragraph} aria-label={words.label} placeholder={options.write_here ?? 'Write here'} onCommit={next => void save(record, words, next)}/></div>
                  : paragraph ? <p className="record-views-document-words">{paragraph}</p> : null}
                {shown.length ? (
                  <dl className="record-views-document-facts">
                    {shown.map(field => <div key={field.id} className="record-views-document-fact"><dt>{field.label}</dt><dd>{field.render?.(record) ?? wordsOf(field, record)}</dd></div>)}
                  </dl>
                ) : null}
              </section>
            )
          })}
        </React.Fragment>
      ))}
    </div>
  )
}
