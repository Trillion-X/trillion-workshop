#!/usr/bin/env node
// packages/work-breakdown/do-work/roll-up-work-completion.mjs
//
// Purpose
//   Hold a body of work as a tree of DATA, work out how much of it is actually
//   finished, and render a checkable view of it. Nesting is unbounded.
//
// Why completion is DERIVED and never written down
//   A number somebody typed is a claim. It agrees with the work on the day it
//   is typed and drifts every day after, and nothing ever catches it, because a
//   stale 70% and a true 70% are the same three characters. Here the only
//   authored facts are leaf states; every count and every share is computed
//   from them on every read. An authored `completion` or `percent` field is
//   REFUSED rather than ignored, because a field that is silently dropped looks
//   like one that is being honoured.
//
// Why `done` is not enough on its own
//   An item marked finished with nothing to point at is a claim too, and it is
//   the specific claim that destroys trust: somebody says it works, the person
//   looks, and it does not. So a leaf that says it is done and names no
//   verification is reported as `claimed`, separately and by name. It never
//   counts toward what is finished. Making that distinction structural is the
//   whole reason this exists; a convention would just be another thing to
//   remember.
//
// Non-negotiable invariants
//   - No app, product, person or project name appears in this file. The tree,
//     the state vocabulary and the labels are all inputs.
//   - States are DATA rows in the tree's own `states` map, never an enum here.
//     A state nobody has named yet is a row, and this file does not branch on
//     which state it is holding.
//   - It reads one named JSON document and reports on it. It never edits that
//     document, and it never searches a directory for work to do.
//
// Usage
//   node roll-up-work-completion.mjs --tree <path> [--as checklist|json]
//     [--only <id>] [--depth <n>]

// A state says three things: how it is written, whether it counts as finished,
// and whether an item in it still needs something pointed at. Every tree
// carries its own map; this is what stands in when it names none.
export const DEFAULT_STATES = {
  done: {label: 'done', counts_as_finished: true, needs_verification: true},
  open: {label: 'open', counts_as_finished: false, needs_verification: false},
  blocked: {label: 'blocked', counts_as_finished: false, needs_verification: false},
}

const AUTHORED_COMPLETION_FIELDS = ['completion', 'percent', 'percentage', 'progress', 'done_count']

export class TreeRefused extends Error {}

const children = node => (Array.isArray(node.children) ? node.children : [])
// A leaf is a node that never claimed to have children. Writing `children: []`
// says the opposite: this breaks down further and nothing has been written yet.
// Treating that as a leaf would quietly add an item nobody authored to the
// denominator, so an empty parent counts nothing and reports no share.
const isLeaf = node => !Array.isArray(node.children)

/** Every node of the in-memory tree, parents before children. */
export function* everyNode(node) {
  yield node
  for (const child of children(node)) yield* everyNode(child)
}

function refuseAuthoredCompletion(root) {
  const offenders = []
  for (const node of everyNode(root)) {
    for (const field of AUTHORED_COMPLETION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(node, field)) {
        offenders.push(`${node.id ?? '(unnamed)'}.${field}`)
      }
    }
  }
  if (offenders.length > 0) {
    throw new TreeRefused(
      'completion is derived from leaf states, so it cannot also be written down. ' +
        `Remove these authored fields: ${offenders.join(', ')}`,
    )
  }
}

function refuseUnknownStates(root, states) {
  const unknown = new Set()
  for (const node of everyNode(root)) {
    if (!isLeaf(node)) continue
    const state = node.state ?? 'open'
    if (!states[state]) unknown.add(`${node.id ?? '(unnamed)'}=${state}`)
  }
  if (unknown.size > 0) {
    throw new TreeRefused(
      'a leaf is in a state this tree never declared, and guessing what it means ' +
        `would be inventing a fact: ${[...unknown].join(', ')}. ` +
        `Declared states: ${Object.keys(states).join(', ')}`,
    )
  }
}

/**
 * What one subtree amounts to. Leaves carry the facts; a parent is only ever
 * the sum of what is underneath it, which is why marking a parent done cannot
 * make a branch look finished.
 */
export function measure(node, states) {
  if (isLeaf(node)) {
    const state = node.state ?? 'open'
    const declared = states[state]
    const verified = (node.verified_by ?? null) !== null
    // Finished, but nothing to point at. Counted apart so it can never pass for
    // the real thing, and named so it is visible rather than quietly dropped.
    const claimed = declared.counts_as_finished && declared.needs_verification && !verified
    return {
      leaves: 1,
      finished: declared.counts_as_finished && !claimed ? 1 : 0,
      claimed: claimed ? 1 : 0,
      blocked: !declared.counts_as_finished && node.blocked_by ? 1 : 0,
      claimed_without_verification: claimed,
    }
  }
  const parts = children(node).map(child => measure(child, states))
  const sum = key => parts.reduce((total, part) => total + part[key], 0)
  return {
    leaves: sum('leaves'),
    finished: sum('finished'),
    claimed: sum('claimed'),
    blocked: sum('blocked'),
    claimed_without_verification: false,
  }
}

/** A share, or null when there is nothing underneath to take a share of. */
export const shareFinished = totals =>
  totals.leaves === 0 ? null : Math.round((totals.finished / totals.leaves) * 1000) / 10

/**
 * The routing that governs a node: its own if it has one, otherwise the nearest
 * ancestor's. A decision like "everything in here is built on the new substrate"
 * is one fact about a branch, not the same sentence copied onto thirty leaves,
 * and copying it would mean a later change had thirty places to miss.
 */
export const routingFor = (node, inherited) => node.through ?? inherited ?? null

function renderNode(node, states, depth, maxDepth, lines, inherited = null) {
  if (maxDepth !== null && depth > maxDepth) return
  const totals = measure(node, states)
  const leaf = isLeaf(node)
  const indent = '  '.repeat(depth)
  const mark = leaf
    ? totals.claimed_without_verification
      ? '[~]'
      : totals.finished === 1
        ? '[x]'
        : '[ ]'
    : totals.leaves > 0 && totals.leaves === totals.finished
      ? '[x]'
      : '[ ]'
  const tail = []
  if (!leaf) tail.push(`${totals.finished}/${totals.leaves}, ${shareFinished(totals)}%`)
  if (totals.claimed > 0) tail.push(`${totals.claimed} said done with nothing to point at`)
  if (totals.blocked > 0) tail.push(`${totals.blocked} blocked`)
  if (leaf && node.verified_by) tail.push(`proof: ${node.verified_by}`)
  if (leaf && node.blocked_by) tail.push(`wall: ${node.blocked_by}`)
  // A later decision can change how an earlier item must be built. That is the
  // opposite of a detail: building it the old way is a defect even though the
  // old request came first, so it belongs on the line rather than in the data.
  const routing = routingFor(node, inherited)
  if (node.through) tail.push(`build it through: ${node.through}`)
  else if (leaf && routing) tail.push(`build it through: ${routing}`)
  if (leaf && Array.isArray(node.said) && node.said.length > 0) {
    tail.push(`asked: ${node.said.map(row => `${row.session}#${row.ordinal}`).join(', ')}`)
  }
  lines.push(`${indent}- ${mark} ${node.title ?? node.id}${tail.length ? `  (${tail.join('; ')})` : ''}`)
  for (const child of children(node)) renderNode(child, states, depth + 1, maxDepth, lines, routing)
}

export function renderChecklist(root, states, maxDepth = null) {
  const lines = []
  for (const child of children(root)) renderNode(child, states, 0, maxDepth, lines)
  return lines.join('\n')
}

const findById = (root, id) => {
  for (const node of everyNode(root)) if (node.id === id) return node
  return null
}

/** One tree document read as a root plus its states, refused when it writes down completion or uses an undeclared state. */
export function readTree(document) {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new TreeRefused('the work tree must be a JSON object')
  const states = {...DEFAULT_STATES, ...(document.states || {})}
  const root = {
    id: document.id ?? 'root',
    title: document.title ?? 'Work',
    children: document.children || [],
  }
  refuseAuthoredCompletion(root)
  refuseUnknownStates(root, states)
  return {document, root, states}
}

/**
 * What one tree (or the subtree `only` names) amounts to. `as: "checklist"` also renders the checkable view, to
 * `depth` levels when given; otherwise the report names what was said done with nothing to point at, what is
 * blocked and by what, and which open items nobody has decided how to build.
 */
export function rollUpWork(treeDocument, {as = 'json', only = null, depth = null} = {}) {
  const {document, root, states} = readTree(treeDocument)
  const subject = only ? findById(root, only) : root
  if (!subject) throw new TreeRefused(`no item in this tree has the id ${only}`)
  const totals = measure(subject, states)
  const stateCounts = Object.fromEntries(Object.keys(states).map(state => [state, 0]))
  for (const node of everyNode(subject)) {
    if (!isLeaf(node)) continue
    const state = node.state ?? 'open'
    stateCounts[state] += 1
  }
  if (as === 'checklist') {
    const checklist = renderChecklist(subject, states, depth)
    const summary =
      `${totals.finished} of ${totals.leaves} finished, ${shareFinished(totals)}%` +
      (totals.claimed > 0 ? `, ${totals.claimed} said done with nothing to point at` : '') +
      (totals.blocked > 0 ? `, ${totals.blocked} blocked` : '')
    return {
      checklist,
      summary,
      totals: {...totals, share_finished: shareFinished(totals)},
      state_counts: stateCounts,
    }
  }
  const unverified = []
  const blocked = []
  // An open item with no routing is the one nobody has decided how to build
  // yet. That is worth naming, because it is indistinguishable on a checklist
  // from an item whose routing was settled weeks ago.
  const unrouted = []
  const routings = new Map()
  const collect = (node, inherited) => {
    const routing = routingFor(node, inherited)
    if (isLeaf(node)) {
      const one = measure(node, states)
      if (one.claimed_without_verification) unverified.push(node.id)
      if (node.blocked_by) blocked.push({id: node.id, wall: node.blocked_by})
      if (routing === null) {
        if (one.finished === 0) unrouted.push(node.id)
      } else {
        routings.set(routing, (routings.get(routing) ?? 0) + 1)
      }
      return
    }
    for (const child of children(node)) collect(child, routing)
  }
  collect(subject, null)
  return {
    title: document.title ?? null,
    leaves: totals.leaves,
    finished: totals.finished,
    claimed_without_verification: totals.claimed,
    blocked: totals.blocked,
    share_finished: shareFinished(totals),
    state_counts: stateCounts,
    unverified_ids: unverified,
    blocked_items: blocked,
    routed_leaves: [...routings.values()].reduce((total, count) => total + count, 0),
    routings: [...routings.entries()]
      .map(([through, leaves]) => ({through, leaves}))
      .sort((a, b) => b.leaves - a.leaves),
    unrouted_open_ids: unrouted,
  }
}

// argv[2] is one JSON input: { tree, as?, only?, depth? }. Prints one JSON line.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const {tree, ...options} = JSON.parse(process.argv[2] ?? '{}')
    process.stdout.write(`${JSON.stringify(rollUpWork(tree, options))}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = error instanceof TreeRefused ? 2 : 1
  }
}
