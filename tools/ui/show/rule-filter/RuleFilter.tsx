// packages/ui/show/rule-filter/RuleFilter.tsx
//
// Purpose
//   The filter a person builds over any list of records, in three parts that
//   share one rule tree:
//     RuleFilterMenu   the Filter menu: search the fields, hover one to see its
//                      values (a tree nests under its parents) or its
//                      comparisons, pick to add a rule; "Advanced filter" opens
//                      the builder.
//     RuleFilterChips  one chip per rule or group (field | comparison | value |
//                      remove) and the builder they open.
//     the builder      rows prefixed Where / and / or, groups that nest and turn
//                      into their opposite with Not, a menu on each row to copy,
//                      group or remove it.
//   Each rule picks a field, a comparison and a value: several values from a
//   checklist with counts, a range on a two-thumb slider with typed ends, a
//   day, words to look for, or one value. Every picker is the shared
//   ActionMenu, so this filter's menus look and behave like every other menu.
//
// Reference anatomy (inspiration only, no code copied)
//   - Notion database filter, Mobbin screens b801453a-b5a3-4a54-913d-c5381b7113c5,
//     24295cd3-d92b-453e-8566-2f4f50fe14db, d41e1c3f-7554-4129-af21-b8d1c8eace43:
//     "Where / And" row prefixes, "Add filter rule" and "Add filter group",
//     a chip per rule in the toolbar, the multi-value checklist
//     (d8abbe0b-4c55-4316-91b7-2e6b4baecb52).
//   - Airtable filter, 3de03dd6-b397-49fb-9fee-f194f1456e6a and
//     f2241482-541b-4d10-9295-0cd14783fc45: "Add condition / Add condition
//     group", the conjunction chosen on the second row.
//   - Flodesk subscriber filter, 04ff770f-c284-48a4-83ea-6ab99b784fc3:
//     "Matching all | any of these" as a two-way switch.
//   - Linear view filters, ed670cda-0527-4716-a1a6-0159f12c4f42 and
//     d1d26f7d-e1e5-490f-ab4f-c96dd12854c1: one Filter entry point, "Add
//     Filter…" search, fields listed with icons, hovering a field opens its
//     values with counts, "Advanced filter" for groups.
//   - Airtable filter f2241482-541b-4d10-9295-0cd14783fc45: Where / field /
//     comparison / value / remove on one line.
//   - 21st.dev 1633 "Filters" (Linear-inspired): the segmented chip
//     field | is | value | ×.
//   - ReUI Filters (keenthemes/reui, MIT; bookmarked by the team): chip bar plus
//     advanced builder modes, nested groups with AND/OR. Anatomy only; the
//     controls are the licensed Coss primitives already in this package.
//   - 21st.dev 27325 "Advanced Data Table Filter Builder" (laziekiki): chip =
//     field | comparison | value | remove, searchable checkbox list with a
//     "N selected" footer, dashed add button. 21st.dev 26824 "Filter Token
//     Bar": chips as one keyboard row. 21st.dev 31347 slider: two thumbs with
//     the value beside each. No licence was stated for these, so nothing was
//     copied; the anatomy was rebuilt on the licensed Coss primitives.
//
// Non-negotiable invariants
//   - Blind: no field, comparison, value or product name appears here. Fields
//     arrive as descriptors, comparisons as formula-engine DATA rows, value
//     counts and ranges as facets.
//   - Never decides which records match. Every edit is handed to `onChange`
//     as a rule tree; the caller evaluates it with the formula engine.
//   - Which control edits a value is chosen by the comparison's `input` DATA
//     through INPUT_CONTROLS; a comparison with a new input shape is one row.

import React, {createContext, useContext, useEffect, useMemo, useRef, useState} from 'react'
import {Button} from '../coss/ui/button'
import {Checkbox} from '../coss/ui/checkbox'
import {Input} from '../coss/ui/input'
import {DatePicker} from '../date-picker/DatePicker'
import {localDay, localDayBounds} from '../date-picker/date-values.mjs'
import {SearchField} from '../search-field/SearchField'
import {Popover, PopoverPopup, PopoverTrigger} from '../coss/ui/popover'
import {Slider} from '../coss/ui/slider'
import {NamedIcon} from '../icon'
import {ActionMenu, type ActionMenuItem} from '../action-menu/ActionMenu'
import {SortableRows} from '../drag-reorder-list/SortableRows'
import {formatFor} from './rule-value-formats'
import {
  appendAt,
  carryParams,
  combinatorById,
  countRules,
  duplicateAt,
  holdsValue,
  isGroup,
  newRule,
  operatorById,
  operatorsFor,
  replaceAt,
  toggleValue,
  wrapAt,
  type Rule,
  type RuleGroup,
  type RuleNode,
  type RuleOperator,
  type RuleOperatorData,
  type RulePath,
} from './rule-tree'

export type RuleFieldView = {
  id: string
  label: string
  /** Picks the comparisons (formula-engine rule-operators.json `applies_to`). */
  kind: string
  unit?: string
  icon?: string
  /** Words and icons for known values; a value with no row shows as itself.
   *  A value naming a `parent` nests under it wherever values are listed; one naming several `parents` is listed
   *  under each of them (a value that sits in several groups). */
  values?: Record<string, {label?: string; icon?: string; parent?: string; parents?: string[]}>
  /** A chooser for values a flat list cannot hold (a tree of projects). It
   *  replaces the checklist and may return its own teardown. */
  pickValues?: (host: HTMLElement, current: {values: string[]; choose: (values: string[]) => void}) => (() => void) | void
}

/** What exists for a field: value counts, and the measured range. */
export type RuleFacet = {options?: {value: string; count: number}[]; min?: number | null; max?: number | null}

export type RuleFilterProps = {
  /** In the order the person keeps them; the menu offers them in this order. */
  fields: RuleFieldView[]
  operators: RuleOperatorData
  value: RuleGroup
  onChange: (next: RuleGroup) => void
  facets?: Record<string, RuleFacet>
  /** The person dragged a field to a new place in the Filter menu. */
  onFieldOrderChange?: (ids: string[]) => void
}

type FilterContext = {
  fields: Map<string, RuleFieldView>
  fieldList: RuleFieldView[]
  operators: RuleOperatorData
  facets: Record<string, RuleFacet>
  root: RuleGroup
  change: (next: RuleGroup) => void
}

const Context = createContext<FilterContext | null>(null)
const useFilter = () => {
  const context = useContext(Context)
  if (!context) throw new Error('Rule filter controls must sit inside RuleFilter.')
  return context
}

const valueLabel = (field: RuleFieldView | undefined, value: string) => field?.values?.[value]?.label ?? value
const valuesOf = (params: Record<string, unknown>) => (Array.isArray(params.values) ? params.values.map(String) : [])
const numberOf = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** The words a chip shows for a rule's value. */
function valueSummary(field: RuleFieldView | undefined, operator: RuleOperator | undefined, params: Record<string, unknown>): string {
  if (!operator || operator.input === 'none') return ''
  const format = formatFor(field?.kind)
  if (operator.input === 'values') {
    const values = valuesOf(params).map(value => valueLabel(field, value))
    return values.length <= 2 ? values.join(', ') : `${values[0]} +${values.length - 1}`
  }
  if (operator.input === 'text') return typeof params.text === 'string' && params.text ? `“${params.text}”` : ''
  if (operator.input === 'words') {
    const entries = Array.isArray(params.values) ? params.values.map(entry => `“${entry}”`) : []
    return entries.length <= 2 ? entries.join(', ') : `${entries[0]} +${entries.length - 1}`
  }
  if (operator.input === 'day') {
    const min = numberOf(params.min)
    return min === null ? '' : format.format(min, field?.unit)
  }
  if (operator.input === 'range') {
    const min = numberOf(params.min), max = numberOf(params.max)
    if (min !== null && max !== null) return `${format.format(min, field?.unit)} – ${format.format(max, field?.unit)}`
    if (min !== null) return `from ${format.format(min, field?.unit)}`
    if (max !== null) return `up to ${format.format(max, field?.unit)}`
    return ''
  }
  const value = numberOf(params.value)
  return value === null ? '' : format.format(value, field?.unit)
}

/** A rule as words: "Length > 1:00", "Tags has any of drill, junk". */
function ruleWords(context: FilterContext, rule: Rule): string {
  const field = context.fields.get(rule.field)
  const operator = operatorById(context.operators, rule.operator)
  return [field?.label ?? '', operator?.chip ?? operator?.label ?? '', valueSummary(field, operator, rule.params)].filter(Boolean).join(' ')
}

/** A group as words: one rule reads as that rule, more as "Any of 3 rules". */
function groupWords(context: FilterContext, group: RuleGroup): string {
  const only = group.rules.length === 1 && !isGroup(group.rules[0]) ? ruleWords(context, group.rules[0] as Rule) : ''
  const count = countRules(group)
  const words = only || `${combinatorById(context.operators, group.combinator)?.label ?? ''} of ${count} rule${count === 1 ? '' : 's'}`
  return group.negate ? `Not ${only ? words : words.charAt(0).toLocaleLowerCase() + words.slice(1)}` : words
}

// ---------------------------------------------------------------------------
// Value controls, one per comparison input shape.

type ControlProps = {field: RuleFieldView; operator: RuleOperator; params: Record<string, unknown>; setParams: (params: Record<string, unknown>) => void}

/** A field's own chooser, mounted while the value popup is open. */
function ValuesPicker({pick, values, choose}: {pick: NonNullable<RuleFieldView['pickValues']>; values: string[]; choose: (values: string[]) => void}) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({values, choose})
  latest.current = {values, choose}
  useEffect(() => {
    if (!host.current) return
    const teardown = pick(host.current, {values: latest.current.values, choose: next => latest.current.choose(next)})
    return typeof teardown === 'function' ? teardown : undefined
  }, [pick])
  return <div ref={host} className="rule-filter-picker"/>
}

function ValuesControl({field, params, setParams}: ControlProps) {
  const {facets} = useFilter()
  const chosen = valuesOf(params)
  const [query, setQuery] = useState('')
  const options = useMemo(() => {
    const counted = new Map<string, number>((facets[field.id]?.options ?? []).map(option => [option.value, option.count]))
    for (const value of [...Object.keys(field.values ?? {}), ...chosen]) if (!counted.has(value)) counted.set(value, 0)
    return [...counted].map(([value, count]) => ({value, count, label: valueLabel(field, value)}))
  }, [facets, field, chosen])
  const needle = query.trim().toLocaleLowerCase()
  const shown = options
    .filter(option => !needle || option.label.toLocaleLowerCase().includes(needle))
    .sort((left, right) => Number(chosen.includes(right.value)) - Number(chosen.includes(left.value)) || right.count - left.count || left.label.localeCompare(right.label))
  const toggle = (value: string) => setParams({values: chosen.includes(value) ? chosen.filter(held => held !== value) : [...chosen, value]})
  // A value nobody holds yet can still be chosen, so a view like "not tagged
  // junk" is saved before the first recording is tagged.
  const typed = query.trim()
  const offerTyped = typed !== '' && !options.some(option => option.value.toLocaleLowerCase() === needle || option.label.toLocaleLowerCase() === needle)
  const summary = valueSummary(field, {input: 'values'} as RuleOperator, params)
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="rule-filter-value" aria-label={`${field.label} values`}/>}>
        {summary || 'Choose…'}
      </PopoverTrigger>
      <PopoverPopup className="rule-filter-values-popup" align="start" portalProps={{className: 'coss-ui'}}>
        {field.pickValues ? <ValuesPicker pick={field.pickValues} values={chosen} choose={values => setParams({values})}/> : (
          <>
            <SearchField size="sm" label={`Search ${field.label.toLocaleLowerCase()}`} placeholder={`Search ${field.label.toLocaleLowerCase()}`} value={query} onChange={event => setQuery(event.currentTarget.value)}/>
            <div className="rule-filter-options" role="group" aria-label={field.label}>
              {shown.map(option => (
                <label key={option.value} className="rule-filter-option" data-chosen={chosen.includes(option.value) ? 'true' : undefined}>
                  <Checkbox checked={chosen.includes(option.value)} onCheckedChange={() => toggle(option.value)} aria-label={option.label}/>
                  {field.values?.[option.value]?.icon && <NamedIcon name={field.values[option.value].icon!} size="xs" aria-hidden/>}
                  <span className="rule-filter-option-label">{option.label}</span>
                  {option.count > 0 && <span className="rule-filter-option-count">{option.count.toLocaleString()}</span>}
                </label>
              ))}
              {offerTyped && (
                <label className="rule-filter-option">
                  <Checkbox checked={false} onCheckedChange={() => { toggle(typed); setQuery('') }} aria-label={typed}/>
                  <span className="rule-filter-option-label">{typed}</span>
                </label>
              )}
              {!shown.length && !offerTyped && <p className="rule-filter-empty">{options.length ? 'Nothing matches that search.' : 'No values yet.'}</p>}
            </div>
            <div className="rule-filter-options-footer">
              <span>{chosen.length ? `${chosen.length} selected` : 'Choose one or more'}</span>
              {chosen.length > 0 && <Button variant="ghost" size="xs" onClick={() => setParams({values: []})}>Clear</Button>}
            </div>
          </>
        )}
      </PopoverPopup>
    </Popover>
  )
}

/** Words to look for. The rule changes once typing pauses, so a list that
 *  refilters on the server is asked once per word, not once per key. */
function TextControl({field, params, setParams}: ControlProps) {
  const committed = typeof params.text === 'string' ? params.text : ''
  const [text, setText] = useState(committed)
  const latest = useRef(setParams)
  latest.current = setParams
  useEffect(() => setText(committed), [committed])
  useEffect(() => {
    if (text === committed) return
    const timer = setTimeout(() => latest.current({text}), 350)
    return () => clearTimeout(timer)
  }, [text, committed])
  return (
    <Input
      size="sm"
      className="rule-filter-text"
      aria-label={`${field.label} words`}
      placeholder="A word or phrase"
      value={text}
      onChange={event => setText(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter') setParams({text}) }}
    />
  )
}

/** Several words or phrases: each Enter (or comma) keeps what was typed as
 *  one entry, so "forehand", "serve" and "keep your eye on the ball" are three
 *  entries the comparison looks for together, any of, or none of. */
function WordsControl({field, params, setParams}: ControlProps) {
  const entries = Array.isArray(params.values) ? params.values.map(String) : []
  const [draft, setDraft] = useState('')
  const keep = () => {
    const entry = draft.trim().replace(/^"(.*)"$/, '$1').trim()
    setDraft('')
    if (entry && !entries.some(held => held.toLocaleLowerCase() === entry.toLocaleLowerCase())) setParams({values: [...entries, entry]})
  }
  return (
    <span className="rule-filter-words" role="group" aria-label={`${field.label} entries`}>
      {entries.map(entry => (
        <span key={entry} className="rule-filter-word">
          <span className="rule-filter-word-text">{entry}</span>
          <Button variant="ghost" size="icon-xs" className="rule-filter-word-remove" aria-label={`Remove ${entry}`} onClick={() => setParams({values: entries.filter(held => held !== entry)})}>
            <NamedIcon name="x" size="xs" aria-hidden/>
          </Button>
        </span>
      ))}
      <Input
        size="sm"
        className="rule-filter-text"
        aria-label={`${field.label} words`}
        placeholder={entries.length ? 'Add another' : 'Type a word or phrase, then Enter'}
        value={draft}
        onChange={event => setDraft(event.currentTarget.value)}
        onBlur={keep}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); keep() }
          else if (event.key === 'Backspace' && !draft && entries.length) setParams({values: entries.slice(0, -1)})
        }}
      />
    </span>
  )
}

/** A typed number in the field's own words (1:30, 250 MB, 2026-09-26). */
function TypedNumber({field, value, onCommit, label}: {field: RuleFieldView; value: number | null; onCommit: (value: number | null) => void; label: string}) {
  const format = formatFor(field.kind)
  const shown = value === null ? '' : format.format(value)
  const [text, setText] = useState(shown)
  const [invalid, setInvalid] = useState(false)
  useEffect(() => { setText(shown); setInvalid(false) }, [shown])
  const commit = () => {
    if (text.trim() === '') { setInvalid(false); onCommit(null); return }
    const parsed = format.parse(text)
    setInvalid(parsed === null)
    if (parsed !== null) onCommit(parsed)
  }
  if (field.kind === 'date') return <DatePicker aria-label={label} value={value === null ? null : localDay(new Date(value))}
    onChange={day => onCommit(day ? localDayBounds(day)!.min : null)} />
  return (
    <Input
      size="sm"
      className="rule-filter-number"
      aria-label={label}
      aria-invalid={invalid || undefined}
      placeholder={format.placeholder}
      value={text}
      onChange={event => setText(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') commit() }}
    />
  )
}

function SingleValueControl({field, params, setParams}: ControlProps) {
  return (
    <span className="rule-filter-single">
      <TypedNumber field={field} label={`${field.label} value`} value={numberOf(params.value)} onCommit={value => setParams(value === null ? {} : {value})}/>
      {field.unit && <span className="rule-filter-unit">{field.unit}</span>}
    </span>
  )
}

function RangeControl({field, params, setParams}: ControlProps) {
  const {facets} = useFilter()
  const format = formatFor(field.kind)
  const facet = facets[field.id]
  const low = numberOf(facet?.min) ?? format.fallbackRange[0]
  const high = Math.max(numberOf(facet?.max) ?? format.fallbackRange[1], low + format.step)
  const min = numberOf(params.min), max = numberOf(params.max)
  const [drag, setDrag] = useState<number[] | null>(null)
  const position = drag ?? [min ?? low, max ?? high]
  const snap = format.snap ?? ((value: number) => value)
  const settle = (values: number[]) => {
    setDrag(null)
    const [from, to] = values.map(snap)
    setParams({...(from > low ? {min: from} : {}), ...(to < high ? {max: to} : {})})
  }
  const summary = valueSummary(field, {input: 'range'} as RuleOperator, params)
  // Calendar ranges select whole local days, including the last day's end.
  // The two calendars open directly from the builder, so choosing an end does
  // not require another range popup. Their menu layer stays above this host.
  if (field.kind === 'date') return <span className="rule-filter-date-range" role="group" aria-label={`${field.label} range`}>
    <DatePicker label="From" aria-label={`${field.label} from`} value={min === null ? null : localDay(new Date(min))}
      max={max === null ? null : localDay(new Date(max))}
      onChange={day => { const {min: _previous, ...rest} = params; setParams(day ? {...rest, min: localDayBounds(day)!.min} : rest) }} />
    <DatePicker label="To" aria-label={`${field.label} to`} value={max === null ? null : localDay(new Date(max))}
      min={min === null ? null : localDay(new Date(min))}
      onChange={day => { const {max: _previous, ...rest} = params; setParams(day ? {...rest, max: localDayBounds(day)!.max} : rest) }} />
  </span>
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="rule-filter-value" aria-label={`${field.label} range`}/>}>
        {summary || 'Any'}
      </PopoverTrigger>
      <PopoverPopup className="rule-filter-range-popup" align="start" portalProps={{className: 'coss-ui'}}>
        {/* Three rows that never share space: the two ends as words, the
            track with room above and below for its thumbs, the typed ends. */}
        <div className="rule-filter-range">
          <div className="rule-filter-range-values" aria-hidden="true">
            <span>{format.format(snap(position[0]), field.unit)}</span>
            <span>{format.format(snap(position[1]), field.unit)}</span>
          </div>
          <div className="rule-filter-range-track">
            <Slider
              className="rule-filter-slider"
              min={low}
              max={high}
              step={format.step}
              value={position}
              getThumbAriaLabel={index => `${field.label} ${index === 0 ? 'from' : 'to'}`}
              onValueChange={value => setDrag(Array.isArray(value) ? [...value] : [value])}
              onValueCommitted={value => settle(Array.isArray(value) ? [...value] : [value])}
            />
          </div>
          <div className="rule-filter-range-inputs">
            <TypedNumber field={field} label={`${field.label} from`} value={min} onCommit={value => setParams({...params, min: value ?? undefined})}/>
            <span aria-hidden="true">to</span>
            <TypedNumber field={field} label={`${field.label} to`} value={max} onCommit={value => setParams({...params, max: value ?? undefined})}/>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  )
}

/** One calendar day, held as the range of time that day covers. */
function DayControl({field, params, setParams}: ControlProps) {
  const value = numberOf(params.min)
  return <DatePicker aria-label={`${field.label} day`} value={value === null ? null : localDay(new Date(value))}
    onChange={day => setParams(day ? localDayBounds(day)! : {})} />
}

const INPUT_CONTROLS: Record<string, (props: ControlProps) => React.ReactElement | null> = {
  values: ValuesControl,
  text: TextControl,
  words: WordsControl,
  value: SingleValueControl,
  range: RangeControl,
  day: DayControl,
  none: () => null,
}

// ---------------------------------------------------------------------------
// Pickers: the shared ActionMenu, so they look like every other menu.

const fieldIcon = (field: RuleFieldView | undefined) => field?.icon || 'list-filter'

function PickerButton({icon, children}: {icon?: string; children: React.ReactNode}) {
  return (
    <>
      {icon && <NamedIcon name={icon} size="xs" aria-hidden/>}
      <span className="rule-filter-picker-label">{children}</span>
      <NamedIcon name="chevron-down" size="xs" aria-hidden className="rule-filter-picker-chevron"/>
    </>
  )
}

function FieldPicker({rule, path}: {rule: Rule; path: RulePath}) {
  const {fields, fieldList, operators, root, change} = useFilter()
  const field = fields.get(rule.field)
  return (
    <ActionMenu
      label="Field"
      align="start"
      trigger={<Button variant="outline" size="sm" className="rule-filter-field"/>}
      triggerContent={<PickerButton icon={field ? fieldIcon(field) : 'plus'}>{field?.label ?? 'Choose a field'}</PickerButton>}
      search={fieldList.length > 8 ? {placeholder: 'Find a field'} : undefined}
      items={fieldList.map(candidate => ({id: candidate.id, label: candidate.label, icon: fieldIcon(candidate), checked: candidate.id === rule.field}))}
      onAction={id => {
        const next = fields.get(id)
        if (next && id !== rule.field) change(replaceAt(root, path, newRule(operators, next)))
      }}
    />
  )
}

function OperatorPicker({rule, path, field}: {rule: Rule; path: RulePath; field: RuleFieldView}) {
  const {operators, root, change} = useFilter()
  const offered = operatorsFor(operators, field.kind)
  const current = operatorById(operators, rule.operator)
  return (
    <ActionMenu
      label={`${field.label} comparison`}
      align="start"
      trigger={<Button variant="ghost" size="sm" className="rule-filter-operator"/>}
      triggerContent={<PickerButton>{current?.label ?? 'Choose'}</PickerButton>}
      items={offered.map(operator => ({id: operator.id, label: operator.label, icon: operator.icon || 'equal', checked: operator.id === rule.operator}))}
      onAction={id => {
        const next = operatorById(operators, id)
        if (next) change(replaceAt(root, path, {...rule, operator: next.id, params: carryParams(current, next, rule.params)}))
      }}
    />
  )
}

function RuleRow({rule, path}: {rule: Rule; path: RulePath}) {
  const {fields, operators, root, change} = useFilter()
  const field = fields.get(rule.field)
  const operator = operatorById(operators, rule.operator)
  const Control = operator ? INPUT_CONTROLS[operator.input] : undefined
  return (
    <div className="rule-filter-rule" role="group" aria-label={field ? `${field.label} rule` : 'New rule'}>
      <FieldPicker rule={rule} path={path}/>
      {field && <OperatorPicker rule={rule} path={path} field={field}/>}
      {field && operator && Control && <Control field={field} operator={operator} params={rule.params} setParams={params => change(replaceAt(root, path, {...rule, params}))}/>}
    </div>
  )
}

const MAX_DEPTH = 3

/** Copy, group or remove one row: behind "…", shown when the row is hovered. */
function RowMenu({path, label, isGroupRow}: {path: RulePath; label: string; isGroupRow: boolean}) {
  const {operators, root, change} = useFilter()
  const items: ActionMenuItem[] = [
    {id: 'duplicate', label: 'Duplicate', icon: 'copy', group: 'edit'},
    ...(!isGroupRow && path.length < MAX_DEPTH ? [{id: 'wrap', label: 'Put in a group', icon: 'brackets', group: 'edit'}] : []),
    {id: 'remove', label: isGroupRow ? 'Remove group' : 'Remove', icon: 'trash-2', tone: 'destructive', group: 'remove'},
  ]
  return (
    <span className="rule-filter-row-menu">
      <ActionMenu
        label={label}
        align="end"
        trigger={<Button variant="ghost" size="icon-xs"/>}
        items={items}
        onAction={id => change(id === 'duplicate' ? duplicateAt(root, path) : id === 'wrap' ? wrapAt(root, path, operators) : replaceAt(root, path, null))}
      />
    </span>
  )
}

/** The second row's prefix: "and" or "or", which decides the whole group. */
function CombinatorPicker({group, path}: {group: RuleGroup; path: RulePath}) {
  const {operators, root, change} = useFilter()
  const current = combinatorById(operators, group.combinator)
  return (
    <ActionMenu
      label="Match"
      align="start"
      trigger={<Button variant="ghost" size="xs" className="rule-filter-combinator"/>}
      triggerContent={<PickerButton>{current?.sentence ?? ''}</PickerButton>}
      items={operators.combinators.map(combinator => ({id: combinator.id, label: `${combinator.label} of these (${combinator.sentence})`, icon: combinator.id === group.combinator ? 'check' : 'git-merge', checked: combinator.id === group.combinator}))}
      onAction={id => change(replaceAt(root, path, {...group, combinator: id}))}
    />
  )
}

function NotToggle({group, path}: {group: RuleGroup; path: RulePath}) {
  const {root, change} = useFilter()
  return (
    <Button
      variant={group.negate ? 'secondary' : 'ghost'}
      size="xs"
      className="rule-filter-not-toggle"
      aria-pressed={group.negate}
      title="Keep what these rules do not match"
      onClick={() => change(replaceAt(root, path, {...group, negate: !group.negate}))}
    ><NamedIcon name="circle-slash" size="xs" aria-hidden/>Not</Button>
  )
}

/** One lasting id per line, so a dragged line keeps its identity while the
 *  tree is rebuilt around it. Edits copy only the path they change, so an
 *  untouched line is the same object as before and keeps its id; a line edited
 *  in place keeps the id of the line it replaced. */
const lineId = (line: {id: string}) => line.id
let lineSerial = 0
function useStableKeys(nodes: readonly RuleNode[]): string[] {
  const previous = useRef<{nodes: readonly RuleNode[]; keys: string[]}>({nodes: [], keys: []})
  const {nodes: before, keys: beforeKeys} = previous.current
  if (before === nodes) return beforeKeys
  const used = new Set<string>()
  const keys = nodes.map(node => {
    const same = before.indexOf(node)
    const key = same >= 0 && !used.has(beforeKeys[same]!) ? beforeKeys[same]! : undefined
    if (key) used.add(key)
    return key
  })
  const filled = keys.map((key, index) => {
    if (key) return key
    const inPlace = beforeKeys[index]
    const replaced = inPlace && !used.has(inPlace) && !nodes.includes(before[index]!) ? inPlace : `line-${++lineSerial}`
    used.add(replaced)
    return replaced
  })
  previous.current = {nodes, keys: filled}
  return filled
}

function GroupEditor({group, path}: {group: RuleGroup; path: RulePath}) {
  const {operators, root, change} = useFilter()
  const combinator = combinatorById(operators, group.combinator)
  const nested = path.length > 0
  const keys = useStableKeys(group.rules)
  const lines = group.rules.map((node, index) => ({node, id: keys[index]!}))
  return (
    <div className="rule-filter-group" data-nested={nested ? 'true' : undefined} data-negated={group.negate ? 'true' : undefined} role="group" aria-label={nested ? 'Rule group' : 'Filter rules'}>
      {nested && (
        <div className="rule-filter-group-head">
          <NotToggle group={group} path={path}/>
          <span className="rule-filter-group-words">{group.negate ? 'None of these' : `${combinator?.label ?? ''} of these`}</span>
          <RowMenu path={path} label="Group options" isGroupRow/>
        </div>
      )}
      <SortableRows
        items={lines}
        getId={lineId}
        className="rule-filter-lines"
        onReorder={order => change(replaceAt(root, path, {...group, rules: order.map(id => lines.find(line => line.id === id)!.node)}))}
        renderItem={({node, id}) => {
          const index = lines.findIndex(line => line.id === id)
          return (
            <div className="rule-filter-line" data-group-row={isGroup(node) ? 'true' : undefined}>
              <span className="rule-filter-grip" data-reorder-handle aria-hidden="true" title="Drag to reorder">
                <NamedIcon name="grip-vertical" size="xs" aria-hidden/>
              </span>
              <span className="rule-filter-joiner">
                {index === 0 ? 'Where' : index === 1 ? <CombinatorPicker group={group} path={path}/> : combinator?.sentence}
              </span>
              {isGroup(node) ? <GroupEditor group={node} path={[...path, index]}/> : <RuleRow rule={node} path={[...path, index]}/>}
              {isGroup(node) ? <span/> : <RowMenu path={[...path, index]} label="Rule options" isGroupRow={false}/>}
            </div>
          )
        }}
      />
      <div className="rule-filter-group-foot">
        <Button variant="ghost" size="sm" onClick={() => change(appendAt(root, path, newRule(operators)))}>
          <NamedIcon name="plus" size="xs" aria-hidden/>Add rule
        </Button>
        {path.length + 1 < MAX_DEPTH && (
          <Button variant="ghost" size="sm" onClick={() => change(appendAt(root, path, {kind: 'group', combinator: operators.combinators[0]?.id ?? '', negate: false, rules: [newRule(operators)]}))}>
            <NamedIcon name="brackets" size="xs" aria-hidden/>Add group
          </Button>
        )}
        {!nested && <span className="rule-filter-foot-end"><NotToggle group={group} path={path}/></span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// The Filter menu: fields, and inside each its values or comparisons.

const MENU_VALUES = 60

function useFilterContext(props: RuleFilterProps): FilterContext {
  const {fields, operators, value, onChange, facets = {}} = props
  return useMemo<FilterContext>(() => ({
    fields: new Map(fields.map(field => [field.id, field])),
    fieldList: fields,
    operators,
    facets,
    root: value,
    change: onChange,
  }), [fields, operators, facets, value, onChange])
}

/** Rows (and the action behind each) for one field's submenu. */
function fieldSubmenu(context: FilterContext, field: RuleFieldView, act: Map<string, () => void>, openBuilder: () => void, hiding: {has: (fieldId: string) => boolean; set: (fieldId: string, hide: boolean) => void}): ActionMenuItem[] {
  const {operators, facets, root, change} = context
  const offered = operatorsFor(operators, field.kind)
  // A field with a checklist offers two ways to use its values: keep only
  // them, or hide them. Both are the field's own comparisons (DATA): the first
  // listing comparison, and the first one that negates it.
  const listing = offered.find(operator => operator.input === 'values' && !operator.negate)
  const hidingOperator = offered.find(operator => operator.input === 'values' && operator.negate)
  if (!listing) {
    return offered.map(operator => {
      const id = `op:${field.id}:${operator.id}`
      act.set(id, () => { change(appendAt(root, [], {kind: 'rule', field: field.id, operator: operator.id, params: {}})); if (operator.input !== 'none') openBuilder() })
      return {id, label: operator.label, icon: operator.icon || 'equal'}
    })
  }
  const counts = new Map<string, number>((facets[field.id]?.options ?? []).map(option => [option.value, option.count]))
  for (const value of Object.keys(field.values ?? {})) if (!counts.has(value)) counts.set(value, 0)
  const parentsOf = (value: string) => { const row = field.values?.[value]; return row?.parents ?? (row?.parent ? [row.parent] : []) }
  const tree = Object.keys(field.values ?? {}).some(value => parentsOf(value).length > 0)
  const held = root.rules.find(node => !isGroup(node) && node.field === field.id && (node.operator === listing.id || node.operator === hidingOperator?.id)) as Rule | undefined
  const hide = held ? held.operator === hidingOperator?.id : hiding.has(field.id)
  const operatorNow = hide && hidingOperator ? hidingOperator : listing
  const modes: ActionMenuItem[] = hidingOperator ? [false, true].map(asHide => {
    const id = `mode:${field.id}:${asHide ? 'hide' : 'show'}`
    act.set(id, () => {
      hiding.set(field.id, asHide)
      const index = held ? root.rules.indexOf(held) : -1
      if (index >= 0) change(replaceAt(root, [index], {...held!, operator: (asHide ? hidingOperator : listing).id}))
    })
    return {id, label: asHide ? 'Hide the ones I pick' : 'Show only the ones I pick', icon: asHide ? 'eye-off' : 'eye', group: 'mode', checked: hide === asHide, keepOpen: true, reorderable: false}
  }) : []
  const leaf = (value: string): ActionMenuItem => {
    const id = `value:${field.id}:${value}`
    act.set(id, () => change(toggleValue(root, operators, field, value, operatorNow.id)))
    const picked = holdsValue(root, field.id, value)
    return {id, label: valueLabel(field, value), icon: picked && hide ? 'eye-off' : field.values?.[value]?.icon || (tree ? 'folder' : fieldIcon(field)), tone: picked && hide ? 'destructive' : undefined, hint: counts.get(value) ? counts.get(value)!.toLocaleString() : undefined, checked: picked, keepOpen: true, group: 'values'}
  }
  // Only the most held values fit in a menu; the rest are one search or one
  // checklist away.
  const more = (shown: number): ActionMenuItem[] => {
    if (counts.size <= shown) return []
    const id = `pick:${field.id}`
    act.set(id, () => { if (!held) change(appendAt(root, [], {kind: 'rule', field: field.id, operator: operatorNow.id, params: {values: []}})); openBuilder() })
    return [{id, label: `All ${counts.size.toLocaleString()} ${field.label.toLocaleLowerCase()}…`, icon: 'list-checks', group: 'more'}]
  }
  if (tree) {
    const children = new Map<string, string[]>()
    const roots: string[] = []
    for (const value of counts.keys()) {
      const known = parentsOf(value).filter(parent => counts.has(parent))
      for (const parent of known) children.set(parent, [...(children.get(parent) ?? []), value])
      if (!known.length) roots.push(value)
    }
    const node = (value: string): ActionMenuItem => {
      const kids = children.get(value)
      if (!kids?.length) return leaf(value)
      return {id: `node:${field.id}:${value}`, label: valueLabel(field, value), icon: 'folder', hint: counts.get(value) ? counts.get(value)!.toLocaleString() : undefined, items: [{...leaf(value), label: `All of ${valueLabel(field, value)}`, icon: 'folder-open', group: 'self'}, ...kids.map(kid => ({...node(kid), group: 'children'}))]}
    }
    return [...modes, ...roots.map(node)]
  }
  const ranked = [...counts.keys()].sort((left, right) => (counts.get(right) ?? 0) - (counts.get(left) ?? 0) || valueLabel(field, left).localeCompare(valueLabel(field, right)))
  return [...modes, ...ranked.slice(0, MENU_VALUES).map(leaf), ...more(MENU_VALUES)]
}

export type RuleFilterMenuProps = RuleFilterProps & {
  /** The button that opens the menu (a toolbar item); a plain Filter button otherwise. */
  trigger?: React.ReactElement
  triggerContent?: React.ReactNode
  /** Open the builder, for a comparison that still needs its value. */
  onOpenBuilder: () => void
}

/** Linear's Filter menu: search, every field in the person's order, hover a
 *  field for its values (a tree nests under its parents) or comparisons. */
export function RuleFilterMenu(props: RuleFilterMenuProps) {
  const context = useFilterContext(props)
  const {trigger, triggerContent, onOpenBuilder, onFieldOrderChange} = props
  // Which fields the person set to "hide the ones I pick" before picking any.
  const [hidingFields, setHidingFields] = useState<ReadonlySet<string>>(() => new Set())
  const hiding = {
    has: (fieldId: string) => hidingFields.has(fieldId),
    set: (fieldId: string, hide: boolean) => setHidingFields(current => { const next = new Set(current); if (hide) next.add(fieldId); else next.delete(fieldId); return next }),
  }
  const act = new Map<string, () => void>()
  act.set('advanced', onOpenBuilder)
  const items: ActionMenuItem[] = [
    {id: 'advanced', label: 'Advanced filter', icon: 'brackets', group: 'advanced', reorderable: false},
    ...context.fieldList.map(field => ({id: `field:${field.id}`, label: field.label, icon: fieldIcon(field), group: 'fields', items: fieldSubmenu(context, field, act, onOpenBuilder, hiding)})),
  ]
  const count = countRules(props.value)
  return (
    <ActionMenu
      label={count ? `Filter, ${count} rule${count === 1 ? '' : 's'}` : 'Filter'}
      align="start"
      trigger={trigger ?? <Button variant="ghost" size="sm" className="rule-filter-open"/>}
      triggerContent={triggerContent ?? <><NamedIcon name="list-filter" size="xs" aria-hidden/>Filter{count > 0 && <span className="rule-filter-count">{count}</span>}</>}
      popupClassName="rule-filter-menu"
      search={{placeholder: 'Filter by…'}}
      items={items}
      onReorder={onFieldOrderChange ? ids => onFieldOrderChange(ids.filter(id => id.startsWith('field:')).map(id => id.slice(6))) : undefined}
      onAction={id => act.get(id)?.()}
    />
  )
}

// ---------------------------------------------------------------------------
// Chips and the builder they open.

function ChipSegments({field, operator, summary}: {field: RuleFieldView; operator?: RuleOperator; summary: string}) {
  return (
    <>
      <span className="rule-filter-chip-field"><NamedIcon name={fieldIcon(field)} size="xs" aria-hidden/><span className="rule-filter-chip-words">{field.label}</span></span>
      <span className="rule-filter-chip-operator">{operator?.chip ?? operator?.label}</span>
      {summary && <span className="rule-filter-chip-value"><span className="rule-filter-chip-words">{summary}</span></span>}
    </>
  )
}

function RuleChip({rule, path, open}: {rule: Rule; path: RulePath; open: () => void}) {
  const context = useFilter()
  const {fields, operators, root, change} = context
  const field = fields.get(rule.field)
  const operator = operatorById(operators, rule.operator)
  if (!field) return null
  const summary = valueSummary(field, operator, rule.params)
  const words = ruleWords(context, rule)
  return (
    <span className="rule-filter-chip" data-incomplete={operator && operator.input !== 'none' && !summary ? 'true' : undefined}>
      <Button variant="ghost" size="xs" className="rule-filter-chip-body" aria-label={`Edit filter: ${words}`} title={words} onClick={open}>
        <ChipSegments field={field} operator={operator} summary={summary}/>
      </Button>
      <Button variant="ghost" size="icon-xs" className="rule-filter-chip-remove" aria-label={`Remove filter: ${words}`} onClick={() => change(replaceAt(root, path, null))}>
        <NamedIcon name="x" size="xs" aria-hidden/>
      </Button>
    </span>
  )
}

function GroupChip({group, path, open}: {group: RuleGroup; path: RulePath; open: () => void}) {
  const context = useFilter()
  const {root, change} = context
  const words = groupWords(context, group)
  return (
    <span className="rule-filter-chip" data-group="true" data-negated={group.negate ? 'true' : undefined}>
      <Button variant="ghost" size="xs" className="rule-filter-chip-body" aria-label={`Edit filter group: ${words}`} title={words} onClick={open}>
        <span className="rule-filter-chip-field"><NamedIcon name={group.negate ? 'circle-slash' : 'brackets'} size="xs" aria-hidden/><span className="rule-filter-chip-words">{words}</span></span>
      </Button>
      <Button variant="ghost" size="icon-xs" className="rule-filter-chip-remove" aria-label={`Remove filter group: ${words}`} onClick={() => change(replaceAt(root, path, null))}>
        <NamedIcon name="x" size="xs" aria-hidden/>
      </Button>
    </span>
  )
}

export type RuleFilterChipsProps = RuleFilterProps & {
  builderOpen: boolean
  onBuilderOpenChange: (open: boolean) => void
}

/** One chip per rule or group, joined by the group's word, and the builder
 *  every chip opens, anchored under the row. */
export function RuleFilterChips(props: RuleFilterChipsProps) {
  const context = useFilterContext(props)
  const {value, onChange, operators, builderOpen, onBuilderOpenChange} = props
  const row = useRef<HTMLDivElement | null>(null)
  const combinator = combinatorById(operators, value.combinator)
  const nextCombinator = operators.combinators[(operators.combinators.findIndex(entry => entry.id === value.combinator) + 1) % Math.max(1, operators.combinators.length)]
  const open = () => onBuilderOpenChange(true)
  // The builder never opens empty: its first line is waiting for a field. A
  // line left without one is dropped when the builder closes.
  useEffect(() => {
    if (builderOpen && value.rules.length === 0) onChange(appendAt(value, [], newRule(operators)))
  }, [builderOpen, value, operators, onChange])
  const changeOpen = (next: boolean) => {
    if (!next) {
      const chosen = value.rules.filter(node => isGroup(node) || node.field !== '')
      if (chosen.length !== value.rules.length) onChange({...value, rules: chosen})
    }
    onBuilderOpenChange(next)
  }
  return (
    <Context.Provider value={context}>
      <div className="rule-filter" ref={row} data-active={countRules(value) ? 'true' : undefined}>
        {value.negate && value.rules.length > 0 && <span className="rule-filter-not">Not</span>}
        {value.rules.map((node, index) => ({node, index})).filter(({node}) => countRules(node) > 0).map(({node, index}, shown) => (
          <React.Fragment key={index}>
            {shown > 0 && (
              <Button
                variant="ghost"
                size="xs"
                className="rule-filter-join"
                title={nextCombinator ? `Match ${nextCombinator.label.toLocaleLowerCase()} instead` : undefined}
                onClick={() => nextCombinator && onChange({...value, combinator: nextCombinator.id})}
              >{combinator?.sentence}</Button>
            )}
            {isGroup(node) ? <GroupChip group={node} path={[index]} open={open}/> : <RuleChip rule={node} path={[index]} open={open}/>}
          </React.Fragment>
        ))}
        {countRules(value) > 0 && (
          <Button variant="ghost" size="xs" className="rule-filter-clear" onClick={() => onChange({...value, negate: false, rules: []})}>Clear</Button>
        )}
        <Popover open={builderOpen} onOpenChange={changeOpen}>
          <PopoverPopup className="rule-filter-popup rule-filter-builder" align="start" anchor={row} portalProps={{className: 'coss-ui'}}>
            <GroupEditor group={value} path={[]}/>
          </PopoverPopup>
        </Popover>
      </div>
    </Context.Provider>
  )
}

export type {RuleNode}
