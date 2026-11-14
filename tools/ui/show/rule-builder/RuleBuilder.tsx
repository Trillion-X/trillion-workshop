// parts/ui/show/rule-builder/RuleBuilder.tsx
//
// Purpose
//   Edits an ordered list of allow / don't-allow rules, each read as one sentence a person builds by pointing:
//     [Allow | Don't allow] [who ▾] to [action chips, + to add] [+ only when… fact ▾ is ▾ value ▾]
//   Every choice is a menu, a chip or a switch; the only typing is a name for a new kind of who and the optional
//   words a stopping rule says. Rules reorder by their grip, each has a ⋯ menu to copy or remove it, and the list has
//   Add rule, Put back the defaults, Save and Discard. A rule's plain meaning (`says`) is written from its choices.
//   Words the owner refused a save with show beside the rule they are about. Read-only, the rules read as sentences.
//
// Reference anatomy (inspiration only, no code copied)
//   - Notion People role menu per row and Obvious role menu with a line under each role (Mobbin
//     e78d4c10-2356-4a90-9021-f3179d6435d2, 7e43776a-22eb-433a-b8a8-66c09235280a): who is picked from a menu of kinds
//     with the types nested under one row.
//   - Twenty's role permissions (Mobbin c9759335-0e75-4bfd-9a89-a52e5e20ea0d): each thing a role may do is its own
//     named row, never a free-text list.
//   - Toggl Track access rights (Mobbin 8488b6d8-0c86-4925-8c64-d6cac7a2bfed) and 21st.dev 29811 Workspace Role
//     Select: a type is chosen from its label and one line about it.
//   - The condition line is the shared rule-filter builder (Notion / Airtable "Where / and" lines).
//
// Non-negotiable invariants
//   - Blind: no rule set, action, fact, kind of who or product name appears here. Effects, kinds of who (and the
//     options a kind needs), actions and facts (with the values each may be compared with) all arrive as DATA.
//   - Never decides anything. It edits a draft and hands the whole list to `onSave`; whoever owns the rules decides
//     and may refuse, and its words are shown as given.
//   - Values keep their type: a fact's values may be true, false, numbers or words, and a condition keeps exactly the
//     value its option carries (the filter's checklist works in keys, translated here both ways).
//   - Every control is a shared part: Button, Input, ActionMenu, RuleFilterChips, SortableRows, NamedIcon.

import React, {useEffect, useMemo, useState} from 'react'
import {Button} from '../coss/ui/button'
import {Input} from '../coss/ui/input'
import {NamedIcon} from '../icon'
import {ActionMenu, type ActionMenuItem} from '../action-menu/ActionMenu'
import {SortableRows} from '../drag-reorder-list/SortableRows'
import {RuleFilterChips, type RuleFieldView} from '../rule-filter/RuleFilter'
import type {RuleGroup, RuleNode, RuleOperatorData} from '../rule-filter/rule-tree'

import { errorWords } from 'trillion-workshop/tools/ui/show/safe-error-card/sanitize-error-text.ts';
/** One value a person can pick, carrying its own typed value. */
export type RuleBuilderOption = {value: string | number | boolean; label: string; about?: string}
/** Allow or stop, and how it reads at the start of a rule. */
export type RuleBuilderEffect = {id: string; label: string; icon: string}
/** A kind of who a rule is about. `field` names the key the chosen option is kept under (for a kind that needs one,
 *  such as a type or a person); `add` lets a person name a new option (a new type) right in the menu. */
export type RuleBuilderWhoKind = {
  kind: string
  label: string
  icon?: string
  field?: string | null
  options?: RuleBuilderOption[]
  add?: {label: string; placeholder: string; onAdd: (name: string) => Promise<void>}
}
/** A fact a condition may name, and the values it may be compared with. */
export type RuleBuilderFact = {id: string; label: string; kind: string; options: RuleBuilderOption[]}
export type RuleBuilderWho = {kind: string; [field: string]: unknown}
export type RuleBuilderRule = {id: string; effect: string; says: string; refuses?: string; who?: RuleBuilderWho; actions?: string[]; when?: RuleGroup; [extra: string]: unknown}
/** A reason a save was refused: about the rule at `index`, or the whole list when null. */
export type RuleBuilderProblem = {index: number | null; says: string}

export type RuleBuilderWords = {
  to: string; onlyWhen: string; everything: string; addAction: string; addRule: string; restore: string; restoreConfirm: string
  save: string; discard: string; duplicate: string; remove: string; refusedWords: string; refusedPlaceholder: string; add: string
  ruleOptions: string; drag: string; newRuleSays: string
}
const WORDS: RuleBuilderWords = {
  to: 'to', onlyWhen: 'Only when…', everything: 'Everything', addAction: 'Add what they can do', addRule: 'Add rule',
  restore: 'Put back the defaults', restoreConfirm: 'Put back the defaults? Your changes to these rules are replaced.',
  save: 'Save changes', discard: 'Discard', duplicate: 'Duplicate', remove: 'Remove', refusedWords: 'What they are told',
  refusedPlaceholder: 'Words shown to someone this stops (optional)', add: 'Add', ruleOptions: 'Rule options', drag: 'Drag to reorder',
  newRuleSays: 'A new rule',
}

export type RuleBuilderProps = {
  rules: RuleBuilderRule[]
  effects: RuleBuilderEffect[]
  whoKinds: RuleBuilderWhoKind[]
  actions: RuleBuilderOption[]
  facts: RuleBuilderFact[]
  operators: RuleOperatorData
  readOnly?: boolean
  /** Why the last save was refused, from whoever owns the rules. */
  problems?: RuleBuilderProblem[]
  /** Saves the whole list; a rejection's words are shown above the list. */
  onSave: (rules: RuleBuilderRule[]) => Promise<void>
  onRestore?: () => Promise<void>
  words?: Partial<RuleBuilderWords>
}

// ---------------------------------------------------------------------------
// Values: the filter works in string keys; a rule keeps typed values.

const keyOf = (value: unknown) => JSON.stringify(value)
const valueOfKey = (key: unknown) => { if (typeof key !== 'string') return key; try { return JSON.parse(key) } catch { return key } }
const mapValues = (node: RuleNode, map: (value: unknown) => unknown): RuleNode => node.kind === 'group'
  ? {...node, negate: Boolean(node.negate), rules: node.rules.map(child => mapValues(child, map))}
  : {...node, params: Array.isArray(node.params?.values) ? {...node.params, values: (node.params.values as unknown[]).map(map)} : node.params ?? {}}
const emptyWhen = (operators: RuleOperatorData): RuleGroup => ({kind: 'group', combinator: operators.combinators[0]?.id ?? 'and', negate: false, rules: []})
const countLines = (node: RuleNode): number => node.kind === 'group' ? node.rules.reduce((sum, child) => sum + countLines(child), 0) : node.field ? 1 : 0

// ---------------------------------------------------------------------------
// A rule's plain meaning, from its choices.

const lower = (words: string) => words.charAt(0).toLowerCase() + words.slice(1)
const listWords = (items: string[], joiner: string) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${joiner} ${items.at(-1)}`

function whoWords(who: RuleBuilderWho | undefined, kinds: RuleBuilderWhoKind[]): string {
  const kind = kinds.find(one => one.kind === (who?.kind ?? kinds[0]?.kind))
  if (!kind) return ''
  if (kind.field) return kind.options?.find(option => option.value === who?.[kind.field!])?.label ?? kind.label
  return lower(kind.label)
}

/** How the chosen who reads on its own button: the option's label, or the kind's. */
const whoLabel = (who: RuleBuilderWho | undefined, kinds: RuleBuilderWhoKind[]) => {
  const words = whoWords(who, kinds)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function conditionWords(node: RuleNode, facts: Map<string, RuleBuilderFact>, operators: RuleOperatorData): string {
  if (node.kind === 'group') {
    const joiner = operators.combinators.find(one => one.id === node.combinator)?.sentence ?? 'and'
    const parts = node.rules.map(child => conditionWords(child, facts, operators)).filter(Boolean)
    return node.negate && parts.length ? `not (${listWords(parts, joiner)})` : listWords(parts, joiner)
  }
  const fact = facts.get(node.field)
  if (!fact) return ''
  const operator = operators.operators.find(one => one.id === node.operator)
  const values = ((node.params?.values as unknown[]) ?? []).map(value => fact.options.find(option => option.value === value)?.label ?? String(value))
  return `${lower(fact.label)} ${operator?.chip ?? operator?.label ?? ''} ${listWords(values, 'or')}`.trim()
}

/** A rule's plain meaning from its choices: "Allow viewer to read the space, only when …". */
export function ruleSays(rule: RuleBuilderRule, props: Pick<RuleBuilderProps, 'effects' | 'whoKinds' | 'actions' | 'facts' | 'operators' | 'words'>): string {
  const words = {...WORDS, ...props.words}
  const effect = props.effects.find(one => one.id === rule.effect)?.label ?? rule.effect
  const actionLabels = rule.actions?.map(id => lower(props.actions.find(action => action.value === id)?.label ?? id))
  const doing = actionLabels?.length ? listWords(actionLabels, 'and') : lower(words.everything)
  const facts = new Map(props.facts.map(fact => [fact.id, fact]))
  const when = rule.when && countLines(rule.when) ? `, ${lower(words.onlyWhen.replace(/…$/, ''))} ${conditionWords(rule.when, facts, props.operators)}` : ''
  return `${effect} ${whoWords(rule.who, props.whoKinds)} ${words.to} ${doing}${when}.`.slice(0, 300)
}
const saysOf = ruleSays

// ---------------------------------------------------------------------------

type Draft = {rule: RuleBuilderRule; key: string; edited: boolean}
const draftsOf = (rules: RuleBuilderRule[]): Draft[] => rules.map((rule, index) => ({rule, key: `${index}:${rule.id}`, edited: false}))
const newId = (taken: Set<string>) => { let id = ''; do { id = `rule-${Math.random().toString(36).slice(2, 8)}` } while (taken.has(id)); return id }

export function RuleBuilder(props: RuleBuilderProps) {
  const words = {...WORDS, ...props.words}
  const {rules, effects, whoKinds, actions, facts, operators, readOnly = false, problems = [], onSave, onRestore} = props
  const [drafts, setDrafts] = useState<Draft[]>(() => draftsOf(rules))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [conditionsOpen, setConditionsOpen] = useState<string | null>(null)
  const [naming, setNaming] = useState<{key: string; kind: string; name: string} | null>(null)
  const rulesKey = JSON.stringify(rules)
  useEffect(() => { setDrafts(draftsOf(rules)); setFailure(null) }, [rulesKey])
  const dirty = JSON.stringify(drafts.map(draft => draft.rule)) !== rulesKey

  const fields = useMemo<RuleFieldView[]>(() => facts.map(fact => ({
    id: fact.id, label: fact.label, kind: fact.kind,
    values: Object.fromEntries(fact.options.map(option => [keyOf(option.value), {label: option.label}])),
  })), [facts])

  const change = (key: string, patch: Partial<RuleBuilderRule>) => setDrafts(current => current.map(draft => {
    if (draft.key !== key) return draft
    const rule = {...draft.rule, ...patch}
    for (const [field, value] of Object.entries(patch)) if (value === undefined) delete (rule as Record<string, unknown>)[field]
    return {...draft, edited: true, rule: {...rule, says: saysOf(rule, props)}}
  }))
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setFailure(null)
    try { await work() } catch (error) { setFailure(errorWords(error)) } finally { setBusy(false) }
  }
  const taken = () => new Set(drafts.map(draft => draft.rule.id))
  const addRule = () => {
    const rule: RuleBuilderRule = {id: newId(taken()), effect: effects[0]?.id ?? 'allow', says: '', who: {kind: whoKinds[0]?.kind ?? ''}, actions: actions[0] ? [String(actions[0].value)] : undefined}
    setDrafts(current => [...current, {key: `new:${rule.id}`, edited: true, rule: {...rule, says: saysOf(rule, props)}}])
  }
  const duplicate = (draft: Draft) => {
    const rule = {...structuredClone(draft.rule), id: newId(taken())}
    setDrafts(current => current.flatMap(one => one.key === draft.key ? [one, {key: `new:${rule.id}`, edited: true, rule}] : [one]))
  }

  const listProblems = problems.filter(problem => problem.index === null).map(problem => problem.says)
  const shown = failure && !problems.length ? [failure, ...listProblems] : failure ? [failure] : listProblems

  if (readOnly) {
    return (
      <div className="flex flex-col gap-2" data-rule-builder="read">
        {rules.map(rule => (
          <div key={rule.id} className="flex items-start gap-2 rounded-lg border border-[var(--border-primary)] px-3 py-2 text-sm">
            <NamedIcon name={effects.find(effect => effect.id === rule.effect)?.icon ?? 'circle'} size="xs" aria-hidden/>
            <span>{rule.says}</span>
          </div>
        ))}
      </div>
    )
  }

  const whoItems = (draft: Draft): ActionMenuItem[] => whoKinds.map(kind => kind.field
    ? {
      id: `kind:${kind.kind}`, label: kind.label, icon: kind.icon ?? 'users',
      items: [
        ...(kind.options ?? []).map(option => ({id: `pick:${kind.kind}:${keyOf(option.value)}`, label: option.label, icon: kind.icon ?? 'user', checked: draft.rule.who?.kind === kind.kind && draft.rule.who?.[kind.field!] === option.value})),
        ...(kind.add ? [{id: `name:${kind.kind}`, label: kind.add.label, icon: 'plus', group: 'add'}] : []),
      ],
    }
    : {id: `pick:${kind.kind}`, label: kind.label, icon: kind.icon ?? 'users', checked: draft.rule.who?.kind === kind.kind})
  const pickWho = (draft: Draft, id: string) => {
    if (id.startsWith('name:')) { setNaming({key: draft.key, kind: id.slice(5), name: ''}); return }
    const rest = id.slice('pick:'.length)
    const kind = whoKinds.find(one => (one.field ? rest.startsWith(`${one.kind}:`) : rest === one.kind))
    if (!kind) return
    change(draft.key, {who: kind.field ? {kind: kind.kind, [kind.field]: valueOfKey(rest.slice(kind.kind.length + 1))} : {kind: kind.kind}})
  }

  return (
    <div className="flex flex-col gap-3" data-rule-builder="edit">
      <SortableRows
        items={drafts}
        getId={draft => draft.key}
        className="gap-2"
        onReorder={order => setDrafts(current => order.map(key => current.find(draft => draft.key === key)!))}
        renderItem={draft => {
          const index = drafts.findIndex(one => one.key === draft.key)
          const {rule} = draft
          const effect = effects.find(one => one.id === rule.effect)
          const chosen = rule.actions ?? []
          const whenView = mapValues(rule.when ?? emptyWhen(operators), keyOf) as RuleGroup
          const lines = countLines(whenView)
          const mine = problems.filter(problem => problem.index === index && !draft.edited)
          const kindForNaming = naming?.key === draft.key ? whoKinds.find(one => one.kind === naming.kind) : undefined
          return (
            <div className="flex items-start gap-2 rounded-xl border border-[var(--border-primary)] bg-[var(--glass-bg-subtle)] px-2 py-2" data-rule={rule.id}>
              <span className="mt-1 cursor-grab text-[var(--text-muted)]" data-reorder-handle aria-hidden="true" title={words.drag}>
                <NamedIcon name="grip-vertical" size="xs" aria-hidden/>
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <ActionMenu
                    label={effect?.label ?? rule.effect}
                    trigger={<Button variant={rule.effect === effects[0]?.id ? 'outline' : 'destructive-outline'} size="xs" className="min-w-16 shrink-0"/>}
                    triggerContent={<>{effect ? <NamedIcon name={effect.icon} size="xs" aria-hidden/> : null}{effect?.label ?? rule.effect}<NamedIcon name="chevron-down" size="xs" aria-hidden/></>}
                    items={effects.map(one => ({id: one.id, label: one.label, icon: one.icon, checked: one.id === rule.effect}))}
                    onAction={id => change(draft.key, {effect: id})}
                  />
                  <ActionMenu
                    label={whoLabel(rule.who, whoKinds)}
                    trigger={<Button variant="outline" size="xs" className="min-w-16 max-w-full shrink-0"/>}
                    triggerContent={<>{whoLabel(rule.who, whoKinds)}<NamedIcon name="chevron-down" size="xs" aria-hidden/></>}
                    items={whoItems(draft)}
                    onAction={id => pickWho(draft, id)}
                  />
                  <span className="text-[var(--text-muted)]">{words.to}</span>
                  {chosen.length ? chosen.map(id => (
                    <Button key={id} variant="secondary" size="xs" disabled={chosen.length === 1} aria-label={`${words.remove}: ${actions.find(action => action.value === id)?.label ?? id}`}
                      onClick={() => change(draft.key, {actions: chosen.filter(one => one !== id)})}>
                      {actions.find(action => action.value === id)?.label ?? id}<NamedIcon name="x" size="xs" aria-hidden/>
                    </Button>
                  )) : <Button variant="secondary" size="xs" disabled>{words.everything}</Button>}
                  <ActionMenu
                    label={words.addAction}
                    trigger={<Button variant="ghost" size="icon-xs" aria-label={words.addAction}/>}
                    triggerContent={<NamedIcon name="plus" size="xs" aria-hidden/>}
                    search={{placeholder: words.addAction}}
                    items={[
                      {id: '*', label: words.everything, icon: 'asterisk', checked: !rule.actions, group: 'all'},
                      ...actions.map(action => ({id: `a:${String(action.value)}`, label: action.label, icon: 'check', checked: chosen.includes(String(action.value)), keepOpen: true, group: 'one'})),
                    ]}
                    onAction={id => {
                      if (id === '*') { change(draft.key, {actions: undefined}); return }
                      const value = id.slice(2)
                      const next = chosen.includes(value) ? chosen.filter(one => one !== value) : [...chosen, value]
                      if (next.length) change(draft.key, {actions: next})
                    }}
                  />
                </div>
                {kindForNaming?.add ? (
                  <div className="flex items-center gap-1.5">
                    <Input size="sm" autoFocus value={naming!.name} placeholder={kindForNaming.add.placeholder} aria-label={kindForNaming.add.label}
                      onChange={event => setNaming({...naming!, name: event.target.value})}
                      onKeyDown={event => { if (event.key === 'Escape') setNaming(null) }}/>
                    <Button size="xs" disabled={!naming!.name.trim() || busy} onClick={() => run(async () => {
                      await kindForNaming.add!.onAdd(naming!.name.trim())
                      setNaming(null)
                    })}>{words.add}</Button>
                    <Button size="xs" variant="ghost" onClick={() => setNaming(null)}>{words.discard}</Button>
                  </div>
                ) : null}
                {lines || conditionsOpen === draft.key ? (
                  <RuleFilterChips
                    fields={fields}
                    operators={operators}
                    value={whenView}
                    onChange={next => change(draft.key, {when: countLines(next) || conditionsOpen === draft.key ? mapValues(next, valueOfKey) as RuleGroup : undefined})}
                    builderOpen={conditionsOpen === draft.key}
                    onBuilderOpenChange={open => setConditionsOpen(open ? draft.key : null)}
                  />
                ) : (
                  <div className="flex justify-start">
                    <Button variant="ghost" size="xs" onClick={() => setConditionsOpen(draft.key)}><NamedIcon name="plus" size="xs" aria-hidden/>{words.onlyWhen}</Button>
                  </div>
                )}
                {rule.effect !== effects[0]?.id ? (
                  <Input size="sm" value={rule.refuses ?? ''} placeholder={words.refusedPlaceholder} aria-label={words.refusedWords}
                    onChange={event => change(draft.key, {refuses: event.target.value.trim() ? event.target.value : undefined})}/>
                ) : null}
                <span className="text-xs text-[var(--text-muted)]">{rule.says}</span>
                {mine.map(problem => <span key={problem.says} role="alert" className="text-xs text-destructive-foreground">{problem.says}</span>)}
              </div>
              <ActionMenu
                label={words.ruleOptions}
                items={[
                  {id: 'duplicate', label: words.duplicate, icon: 'copy'},
                  {id: 'remove', label: words.remove, icon: 'trash-2', tone: 'destructive'},
                ]}
                onAction={id => id === 'duplicate' ? duplicate(draft) : setDrafts(current => current.filter(one => one.key !== draft.key))}
              />
            </div>
          )
        }}
      />
      {/* The owner's refusal, beside Save where the change was asked for. */}
      {shown.map(line => <div key={line} role="alert" className="rounded-lg bg-destructive/8 px-3 py-2 text-sm text-destructive-foreground">{line}</div>)}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={addRule}><NamedIcon name="plus" size="xs" aria-hidden/>{words.addRule}</Button>
        {onRestore ? (
          <ActionMenu
            label={words.restore}
            trigger={<Button variant="ghost" size="sm"/>}
            triggerContent={<><NamedIcon name="rotate-ccw" size="xs" aria-hidden/>{words.restore}</>}
            items={[{id: 'restore', label: words.restore, icon: 'rotate-ccw', tone: 'destructive', confirm: words.restoreConfirm}]}
            onAction={() => void run(onRestore)}
          />
        ) : null}
        <span className="flex-1"/>
        {dirty ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDrafts(draftsOf(rules))}>{words.discard}</Button> : null}
        <Button size="sm" disabled={!dirty || busy} onClick={() => run(() => onSave(drafts.map(({rule}) => {
          // A condition line opened and left without a fact says nothing, so it is not sent.
          if (!rule.when || countLines(rule.when)) return rule
          const {when: _unused, ...rest} = rule
          return rest
        })))}>{words.save}</Button>
      </div>
    </div>
  )
}
