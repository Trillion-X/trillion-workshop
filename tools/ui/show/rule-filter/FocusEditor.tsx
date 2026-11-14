// packages/ui/show/rule-filter/FocusEditor.tsx
//
// Purpose
//   The person's focus for a whole level (the app, an arrangement), at the top of the sidebar like a workspace's name:
//   it names what the whole workspace is about now (everything, or one space or pursuit), and its menu switches to
//   any value of any fact a focus can name, with a check on the current one, after Notion's workspace switcher (Mobbin
//   https://mobbin.com/screens/fa0f3ae6-c4cc-432f-87ba-77e66f63146e). A focus that names more than one value is
//   built with the same rule filter every list uses (its chips and builder), writing that level's rule into the one
//   chain (./focus-chain.ts). Every list under the level narrows at once.
//
// Non-negotiable invariants
//   1. Blind: which facts a focus can name (pursuit, space), their values and every word are the caller's DATA; this
//      file knows no scope.
//   2. One editor: switching writes the same rule the rule filter writes (one has_any_of rule), never a second form.
//   3. Mounted into a host the caller names (a sidebar section's shared panel host), so the sidebar's own code is never
//      touched.

import React, {useEffect, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {Button} from '../coss/ui/button'
import {NamedIcon} from '../icon'
import {ActionMenu, type ActionMenuItem} from '../action-menu'
import {RuleFilterChips, type RuleFacet, type RuleFieldView} from './RuleFilter'
import {countRules, emptyGroup, type RuleGroup, type RuleNode, type RuleOperatorData} from './rule-tree'
import {type NodeRuleStore} from './focus-chain'

export type FocusEditorWords = {
  /** The name shown when nothing is chosen: the whole workspace. */
  everything: string
  /** The name shown when several values are chosen ({count}). */
  several: string
  /** The name for a rule over a fact with no named values, such as text. */
  filtered: string
  /** The menu row that opens the builder, for a focus on more than one thing. */
  more: string
  /** The menu's own name, read aloud. */
  label: string
  /** The search box's placeholder. */
  search: string
}

export type FocusEditorProps = {
  /** The level this editor sets ("app"). */
  nodeId: string
  /** The facts a focus can name, with their values. */
  fields: RuleFieldView[]
  facets?: Record<string, RuleFacet>
  operators: RuleOperatorData
  /** Where this level's rule is kept (the app's saved focus). */
  store: NodeRuleStore
  words: FocusEditorWords
  /** Rows after the values that open something instead of switching (the app's list of every value). */
  opens?: {id: string; label: string; icon: string; open: () => void}[]
}

/** The one comparison a switch writes: a field holds any of these values. */
const ONE_OF = 'has_any_of'
const valuesIn = (node: RuleNode, into: {field: string; id: string}[] = []): {field: string; id: string}[] => {
  if (node.kind === 'group') for (const child of node.rules) valuesIn(child, into)
  else for (const value of [node.params.values ?? node.params.value].flat()) if (typeof value === 'string' && value) into.push({field: node.field, id: value})
  return into
}

export function FocusEditor({nodeId, fields, facets, operators, store, words, opens = []}: FocusEditorProps) {
  const [rules, setRules] = useState(() => store.read())
  useEffect(() => {
    setRules(store.read())
    return store.subscribe(() => setRules(store.read()))
  }, [store])
  const [builderOpen, setBuilderOpen] = useState(false)
  const value: RuleGroup = rules[nodeId] ?? emptyGroup(operators)
  const change = (next: RuleGroup) => store.write(nodeId, next)
  const on = countRules(value) > 0
  const chosen = valuesIn(value)
  const labelOf = (field: string, id: string) => fields.find(row => row.id === field)?.values?.[id]?.label ?? id
  const name = !on ? words.everything : chosen.length === 1 ? labelOf(chosen[0].field, chosen[0].id) : chosen.length ? words.several.replace('{count}', String(chosen.length)) : words.filtered
  const only = chosen.length === 1 ? chosen[0] : null
  const items: ActionMenuItem[] = [
    {id: 'everything', label: words.everything, icon: 'layers', group: 'everything', checked: !on},
    ...fields.flatMap(field => Object.entries(field.values ?? {}).map(([id, row]) => ({
      id: `value:${field.id}:${id}`, label: row.label ?? id, icon: row.icon ?? field.icon ?? 'crosshair', group: field.id, groupLabel: field.label,
      checked: only?.field === field.id && only.id === id,
    }))),
    {id: 'more', label: words.more, icon: 'list-filter', group: 'more'},
    ...opens.map(row => ({id: `open:${row.id}`, label: row.label, icon: row.icon, group: 'opens'})),
  ]
  const act = (id: string) => {
    if (id === 'everything') return store.write(nodeId, null)
    if (id === 'more') return setTimeout(() => setBuilderOpen(true))
    const opened = opens.find(row => `open:${row.id}` === id)
    if (opened) return opened.open()
    const [, field, ...rest] = id.split(':')
    store.write(nodeId, {...emptyGroup(operators), rules: [{kind: 'rule', field, operator: ONE_OF, params: {values: [rest.join(':')]}}]})
  }
  return (
    <div className="focus-editor" data-focused={on ? 'true' : undefined}>
      <div className="focus-editor-row">
        <ActionMenu
          label={words.label}
          align="start"
          showGroupLabels
          search={{placeholder: words.search}}
          trigger={<Button variant="outline" size="default" className="focus-editor-trigger" data-focus-name={name}/>}
          triggerContent={<><NamedIcon name={on ? 'crosshair' : 'layers'} size="xs" aria-hidden/><span className="focus-editor-name">{name}</span><NamedIcon name="chevrons-up-down" size="xs" aria-hidden/></>}
          items={items}
          onAction={act}
        />
      </div>
      {(builderOpen || chosen.length > 1) && <RuleFilterChips fields={fields} operators={operators} value={value} onChange={change} facets={facets} builderOpen={builderOpen} onBuilderOpenChange={setBuilderOpen}/>}
    </div>
  )
}

/** Keep the editor mounted in whichever element carries
 *  `data-sidebar-content-host="<hostId>"` (a sidebar section's shared panel),
 *  following it as the sidebar redraws, collapses or moves the section. */
export function mountFocusEditorInto(hostId: string, props: FocusEditorProps) {
  let current = props
  let held: {host: HTMLElement; editor: ReturnType<typeof mountFocusEditor>} | null = null
  const place = () => {
    const host = document.querySelector<HTMLElement>(`[data-sidebar-content-host="${CSS.escape(hostId)}"]`)
    if (host === held?.host) return
    held?.editor.destroy()
    held = host ? {host, editor: mountFocusEditor(host, current)} : null
  }
  const watcher = new MutationObserver(place)
  watcher.observe(document.body, {childList: true, subtree: true})
  place()
  return {
    update: (next: Partial<FocusEditorProps>) => { current = {...current, ...next}; held?.editor.update(current) },
    destroy: () => { watcher.disconnect(); held?.editor.destroy(); held = null },
  }
}

/** Mount the editor into a host; returns an update and a teardown. */
export function mountFocusEditor(host: HTMLElement, props: FocusEditorProps) {
  const root = createRoot(host)
  const draw = (next: FocusEditorProps) => root.render(<FocusEditor {...next}/>)
  draw(props)
  return {update: (next: Partial<FocusEditorProps>) => draw({...props, ...next}), destroy: () => root.unmount()}
}
