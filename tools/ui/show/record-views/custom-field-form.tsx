import React, {useState} from 'react'
import {Button} from '../coss/ui/button'
import {Input} from '../coss/ui/input'
import {Dropdown} from '../dropdown/Dropdown'
import type {FieldDescriptor} from './record-views'

/** Field kinds are data rows: consumers may offer a narrower or wider set. */
export type CustomFieldKind = {
  id: string
  label: string
  kind: string
  /** The fact kind its rules compare (formula-engine rule-operators.json `applies_to`). */
  ruleKind?: string
}

export const DEFAULT_CUSTOM_FIELD_KINDS: CustomFieldKind[] = [
  {id: 'text', label: 'Text', kind: 'text', ruleKind: 'text'},
  {id: 'number', label: 'Number', kind: 'number', ruleKind: 'number'},
  {id: 'date', label: 'Date', kind: 'date', ruleKind: 'date'},
  {id: 'tag', label: 'Tags', kind: 'tag', ruleKind: 'tags'},
]

export function CustomFieldForm({
  fields,
  kinds = DEFAULT_CUSTOM_FIELD_KINDS,
  onAdd,
}: {
  fields: readonly FieldDescriptor[]
  kinds?: readonly CustomFieldKind[]
  onAdd: (field: Pick<FieldDescriptor, 'id' | 'label' | 'kind' | 'ruleKind' | 'filterable' | 'groupable'>) => void
}) {
  const [label, setLabel] = useState('')
  const [kindId, setKindId] = useState(kinds[0]?.id ?? '')
  const kind = kinds.find(candidate => candidate.id === kindId)
  const id = label.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const duplicate = fields.some(field => field.id === id)
  const add = () => {
    if (!id || !kind || duplicate) return
    onAdd({id, label: label.trim(), kind: kind.kind, ruleKind: kind.ruleKind, filterable: true, groupable: true})
    setLabel('')
  }
  if (kinds.length === 0) return null
  return (
    <div className="record-views-add-field" role="group" aria-label="Add a field">
      <Input
        aria-label="New field name"
        placeholder="New field name"
        value={label}
        onChange={event => setLabel(event.currentTarget.value)}
        onKeyDown={event => { if (event.key === 'Enter') add() }}
      />
      <Dropdown
        aria-label="New field type"
        value={kindId}
        onValueChange={setKindId}
        items={kinds.map(candidate => ({value: candidate.id, label: candidate.label}))}
      />
      <Button variant="ghost" size="sm" disabled={!id || duplicate || !kind} onClick={add}>Add field</Button>
      {duplicate && <span role="status">A field with this name already exists.</span>}
    </div>
  )
}
