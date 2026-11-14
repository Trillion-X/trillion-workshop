// packages/ui/show/composition-graph/composition-node.ts
//
// The Recursive NodeRef Composition Graph — the ONE generative primitive a
// container, tab-group, layout, group, board, and archive are all configurations
// of (L069). A node is `{ ref, members? }`; a group is a node WITH members;
// members reference child NodeRefs of ANY family, recursively. The core stores
// ONLY `nodeRef.family + parts` — it NEVER asks "is this a tab/container/layout/
// drawing/board?" (L090, enum-dissolution). Adding a node family = publishing a
// new family string; zero core change.
//
// This is storage-blind and addressed: the graph is a FLAT map keyed by the
// serialized NodeRef, and recursion happens by resolving a member's `nodeRef`
// back through the map (NOT by nesting node objects). That gives:
//   • Structural sharing (P1): a mutation creates ONE new node object; every
//     unchanged node is shared BY REFERENCE, so `===` detects what changed.
//   • O(changed) fold (P2): the projection walks only the reachable members from
//     a root, and a dirty-set bounds re-fold work — never an O(total) walk.
//
// NOT the same recursion as `visual-layer-types.ts` `children` (that is visual-
// layer-only and cannot hold arbitrary nodes — Codex convergence 2026-06-25).
//
// Member contract (Codex convergence 2026-06-25):
//   { memberId, nodeRef, order?, role?, presentation? }

import type { NodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts'
import { serializeNodeRef } from 'trillion-workshop/tools/turn-frames-into-slides/read-data/node-ref.ts'

/** One membership edge: a child NodeRef placed inside a group, with optional ordering/role. */
export interface GroupMember {
  readonly memberId: string
  /** The child — ANY family. The core reads only `family + parts`. */
  readonly nodeRef: NodeRef
  /** Explicit order key; when absent, array position is the order. */
  readonly order?: number
  /** Opaque Society role (e.g. an active-member marker) — the core never interprets it. */
  readonly role?: string
  /** Opaque per-member presentation data the renderer alone interprets. */
  readonly presentation?: Record<string, unknown>
}

/** A node in the composition graph. `members` absent ⇒ a leaf. Present ⇒ a group/composite. */
export interface CompositionNode {
  readonly ref: NodeRef
  readonly members?: readonly GroupMember[]
}

/** The graph: a flat, addressed map. Key = `serializeNodeRef(node.ref)`. Unchanged nodes share by reference. */
export type CompositionGraph = ReadonlyMap<string, CompositionNode>

/** Key a NodeRef the way the graph stores it. */
export function nodeKey(ref: NodeRef): string {
  return serializeNodeRef(ref)
}

/** Read a node, or undefined when absent (callers render a safe fallback — never throw). */
export function getNode(graph: CompositionGraph, ref: NodeRef): CompositionNode | undefined {
  return graph.get(nodeKey(ref))
}

/** Members in resolved order (explicit `order` wins; ties keep insertion order). Empty for a leaf. */
export function orderedMembers(node: CompositionNode | undefined): readonly GroupMember[] {
  const members = node?.members
  if (!members || members.length === 0) return []
  return members
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ao = a.m.order ?? a.i
      const bo = b.m.order ?? b.i
      return ao === bo ? a.i - b.i : ao - bo
    })
    .map((x) => x.m)
}

// ---------------------------------------------------------------------------
// Pure mutations — each returns a NEW graph that SHARES every untouched node by
// reference. Only the one changed node is a fresh object (P1 structural sharing).
// ---------------------------------------------------------------------------

/** Replace exactly one node, sharing all others by reference. */
function withNode(graph: CompositionGraph, node: CompositionNode): CompositionGraph {
  const next = new Map(graph)
  next.set(nodeKey(node.ref), node)
  return next
}

/** Ensure a node exists (created as a leaf if absent), returning the graph + the node. */
export function ensureNode(graph: CompositionGraph, ref: NodeRef): { graph: CompositionGraph; node: CompositionNode } {
  const existing = getNode(graph, ref)
  if (existing) return { graph, node: existing }
  const node: CompositionNode = { ref }
  return { graph: withNode(graph, node), node }
}

/**
 * Add `member` to `groupRef` (idempotent on memberId — re-adding replaces in place,
 * preserving position). Rejects self-membership (a node cannot contain itself).
 */
export function addMember(graph: CompositionGraph, groupRef: NodeRef, member: GroupMember): CompositionGraph {
  if (nodeKey(member.nodeRef) === nodeKey(groupRef)) return graph // no self-membership
  const { graph: g1, node } = ensureNode(graph, groupRef)
  // Every referenced member IS a node — ensure it exists as a leaf (it may later
  // gain its own members and become a group). This keeps the graph self-consistent
  // so the fold can reach every member.
  const { graph: g2 } = ensureNode(g1, member.nodeRef)
  const members = node.members ?? []
  const idx = members.findIndex((m) => m.memberId === member.memberId)
  const nextMembers = idx >= 0 ? members.map((m, i) => (i === idx ? member : m)) : [...members, member]
  return withNode(g2, { ...node, members: nextMembers })
}

/** Remove a member by id. No-op when absent. */
export function removeMember(graph: CompositionGraph, groupRef: NodeRef, memberId: string): CompositionGraph {
  const node = getNode(graph, groupRef)
  if (!node?.members) return graph
  const nextMembers = node.members.filter((m) => m.memberId !== memberId)
  if (nextMembers.length === node.members.length) return graph
  return withNode(graph, { ...node, members: nextMembers })
}

/** Move a member to a new index (clamped). No-op when absent or already there. */
export function moveMember(graph: CompositionGraph, groupRef: NodeRef, memberId: string, toIndex: number): CompositionGraph {
  const node = getNode(graph, groupRef)
  if (!node?.members) return graph
  const from = node.members.findIndex((m) => m.memberId === memberId)
  if (from < 0) return graph
  const clamped = Math.max(0, Math.min(toIndex, node.members.length - 1))
  if (clamped === from) return graph
  const next = [...node.members]
  const [moved] = next.splice(from, 1)
  next.splice(clamped, 0, moved)
  return withNode(graph, { ...node, members: next })
}

// ---------------------------------------------------------------------------
// Fold projection — walk the reachable subtree from a root, visiting each node
// ONCE (cycle-safe). O(reachable), and with a `dirty` set the caller bounds work
// to changed nodes only (P2).
// ---------------------------------------------------------------------------

export interface FoldVisit {
  readonly node: CompositionNode
  readonly depth: number
  /** The membership edge that reached this node (undefined for the root). */
  readonly via?: GroupMember
}

/**
 * Depth-first fold from `rootRef`. `visit` is called once per reachable node.
 * Cycle-safe (a node already visited is skipped). Returns the count of nodes
 * visited so callers can assert O(changed) in tests/observability.
 */
export function foldGroup(graph: CompositionGraph, rootRef: NodeRef, visit: (v: FoldVisit) => void): number {
  const seen = new Set<string>()
  let visited = 0
  const walk = (ref: NodeRef, depth: number, via?: GroupMember): void => {
    const key = nodeKey(ref)
    if (seen.has(key)) return
    seen.add(key)
    const node = getNode(graph, ref)
    if (!node) return
    visit({ node, depth, via })
    visited += 1
    for (const m of orderedMembers(node)) walk(m.nodeRef, depth + 1, m)
  }
  walk(rootRef, 0)
  return visited
}

/** Flatten the reachable subtree (root first, depth-first) — convenience over `foldGroup`. */
export function flattenGroup(graph: CompositionGraph, rootRef: NodeRef): FoldVisit[] {
  const out: FoldVisit[] = []
  foldGroup(graph, rootRef, (v) => out.push(v))
  return out
}

/** An empty graph. */
export const EMPTY_COMPOSITION_GRAPH: CompositionGraph = new Map()
