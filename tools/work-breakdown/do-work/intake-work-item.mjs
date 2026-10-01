#!/usr/bin/env node
// Add a founder-authored, source-attributed item to an existing work tree.
// The caller supplies the interpreted title and checks; this generic owner
// validates provenance, deduplicates retries, and hands back the tree with the
// item in it (the Workshop tool "Add a requested item to a work tree").

import {DEFAULT_STATES} from './roll-up-work-completion.mjs'

export class IntakeRefused extends Error {}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const children = node => Array.isArray(node.children) ? node.children : []

export function* everyNode(node) {
  yield node
  for (const child of children(node)) yield* everyNode(child)
}

function validateSource(source) {
  if (!Array.isArray(source) || source.length === 0) {
    throw new IntakeRefused('source attribution is required (said: [{session, ordinal}])')
  }
  for (const row of source) {
    if (!isRecord(row) || typeof row.session !== 'string' || !row.session.trim() ||
        !Number.isSafeInteger(row.ordinal) || row.ordinal < 1) {
      throw new IntakeRefused('each source attribution needs a non-empty session and positive integer ordinal')
    }
  }
  const keys = source.map(row => `${row.session}\0${row.ordinal}`)
  if (new Set(keys).size !== keys.length) throw new IntakeRefused('the same source message was listed more than once')
}

function validateTree(tree) {
  if (!isRecord(tree)) throw new IntakeRefused('the work tree must be a JSON object')
  const ids = new Map()
  for (const node of everyNode(tree)) {
    if (typeof node.id !== 'string' || !node.id.trim()) throw new IntakeRefused('every existing tree node needs an id')
    if (ids.has(node.id)) throw new IntakeRefused(`duplicate tree id: ${node.id}`)
    ids.set(node.id, node)
  }
  return ids
}

function validateItem(item) {
  if (!isRecord(item)) throw new IntakeRefused('the intake item must be a JSON object')
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(item.id)) {
    throw new IntakeRefused('item id must be a stable lowercase id using letters, numbers, dots, underscores, or hyphens')
  }
  if (typeof item.title !== 'string' || !item.title.trim()) throw new IntakeRefused('item title is required')
  validateSource(item.said)
  if (item.checks !== undefined && (!Array.isArray(item.checks) || item.checks.some(check => typeof check !== 'string' || !check.trim()))) {
    throw new IntakeRefused('checks must be an array of non-empty strings')
  }
  if (item.attach_to !== undefined && (typeof item.attach_to !== 'string' || !item.attach_to.trim())) {
    throw new IntakeRefused('attach_to must name an existing node id')
  }
  if (item.state !== undefined && (typeof item.state !== 'string' || !item.state.trim())) {
    throw new IntakeRefused('state must be a non-empty state name')
  }
  if (item.correction !== undefined && typeof item.correction !== 'boolean') {
    throw new IntakeRefused('correction must be true or false')
  }
}

const sourceKey = row => `${row.session}\0${row.ordinal}`

/**
 * Apply one interpreted founder message to a tree. Retries with the same id
 * and source are idempotent. `attach_to` records another request on an existing
 * owner when the new message refines the same underlying capability. Marking
 * that message as a correction replaces the current title and checks while
 * preserving every prior source attribution.
 */
export function intakeWorkItem(tree, item) {
  validateItem(item)
  const ids = validateTree(tree)
  const states = tree.states ?? DEFAULT_STATES
  const state = item.state ?? 'open'
  if (!states[state]) throw new IntakeRefused(`undeclared state: ${state}`)
  const allSources = new Map()
  for (const node of ids.values()) {
    for (const source of node.said ?? []) allSources.set(sourceKey(source), node)
  }

  const destination = item.attach_to ? ids.get(item.attach_to) : null
  if (item.attach_to && !destination) throw new IntakeRefused(`unknown attach_to id: ${item.attach_to}`)
  if (destination && Array.isArray(destination.children)) throw new IntakeRefused('attach_to must identify a leaf, not a branch')
  if (item.attach_to && item.attach_to === item.id) throw new IntakeRefused('an item cannot attach to itself')

  for (const source of item.said) {
    const existing = allSources.get(sourceKey(source))
    if (existing && (!destination || existing.id !== destination.id) && existing.id !== item.id) {
      throw new IntakeRefused(`source message ${source.session}#${source.ordinal} already belongs to ${existing.id}`)
    }
  }

  if (destination) {
    const existingSources = new Set((destination.said ?? []).map(sourceKey))
    const fresh = item.said.filter(source => !existingSources.has(sourceKey(source)))
    if (fresh.length === 0) {
      if (item.correction && (destination.title !== item.title.trim() ||
          JSON.stringify(destination.checks ?? []) !== JSON.stringify(item.checks ?? []))) {
        throw new IntakeRefused('a source message was replayed with different correction content')
      }
      return {tree, changed: false, item: destination}
    }
    destination.said = [...(destination.said ?? []), ...fresh]
    if (item.correction) {
      destination.title = item.title.trim()
      destination.checks = [...(item.checks ?? [])]
    } else {
      destination.checks ??= item.checks ?? []
      if (item.checks?.length) destination.checks = [...new Set([...destination.checks, ...item.checks])]
    }
    return {tree, changed: true, item: destination}
  }

  const existingById = ids.get(item.id)
  if (existingById) {
    const existingSources = new Set((existingById.said ?? []).map(sourceKey))
    const fresh = item.said.filter(source => !existingSources.has(sourceKey(source)))
    if (fresh.length === 0 && existingById.title === item.title) return {tree, changed: false, item: existingById}
    throw new IntakeRefused(`item id already exists with different content: ${item.id}`)
  }

  const parent = item.parent_id ? ids.get(item.parent_id) : tree
  if (!parent) throw new IntakeRefused(`unknown parent_id: ${item.parent_id}`)
  if (!Array.isArray(parent.children)) throw new IntakeRefused(`parent_id must name a branch: ${item.parent_id ?? '(root)'}`)

  const leaf = {
    id: item.id,
    title: item.title.trim(),
    state,
    said: item.said.map(row => ({session: row.session.trim(), ordinal: row.ordinal})),
  }
  if (item.checks?.length) leaf.checks = [...item.checks]
  if (item.through) leaf.through = item.through
  if (item.source) leaf.source = item.source
  parent.children.push(leaf)
  return {tree, changed: true, item: leaf}
}

// argv[2] is one JSON input: { tree, item }. Prints one JSON line: the tree with the item in it, whether it changed,
// and the item as recorded.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const {tree, item} = JSON.parse(process.argv[2] ?? '{}')
    const result = intakeWorkItem(tree, item)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = error instanceof IntakeRefused ? 2 : 1
  }
}
