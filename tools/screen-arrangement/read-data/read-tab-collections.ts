// packages/screen-arrangement/read-data/read-tab-collections.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Blind decoder for the saved layouts (arrangement presets) the empty pane and
// the Layouts menu offer, read through the ONE `group.load-graph` door. A group
// is a layout purely because its members carry an arrangement structure, never
// a collection_kind enum.
//
// The person's lists and folders are NOT decoded here: they are the sidebar's
// surface collections, read by the sidebar's own `useSurfaceCollections` so the
// empty pane can never disagree with the sidebar. `listsPresentHere` only
// narrows that shared tree to what this app's catalog can open.
//
// =============================================================================

import {
  foldGroupToLayoutState,
  type GroupSavedLayout,
} from '../do-work/save-arrangement-as-group'
import { listMadeByPerson, type SurfaceCollection } from 'trillion-workshop/tools/organize-the-sidebar/read-data/read-surface-collections.ts'

export interface NewTabCollections {
  presets: GroupSavedLayout[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array')
}

/** The live transport reply is `{ payload: Uint8Array }` — the door's JSON rides inside. */
export function decodeGraphReply(rawReply: unknown): unknown {
  const payload = isRecord(rawReply) && isBytes(rawReply.payload) ? rawReply.payload : rawReply
  if (isBytes(payload)) {
    const text = new TextDecoder().decode(payload).trim()
    if (!text) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      return null
    }
  }
  return payload
}

/**
 * Fail closed on transport-success/application-failure replies. An unavailable
 * owner is not the same state as an available owner with zero groups; callers
 * need that distinction so they can render a retry instead of a false empty
 * state.
 */
export function requireSuccessfulGroupGraphReply(rawReply: unknown): Record<string, unknown> {
  const reply = decodeGraphReply(rawReply)
  if (!isRecord(reply)) throw new Error('group.load-graph returned no structured reply')
  if (reply.ok !== true) {
    const detail = typeof reply.error === 'string' && reply.error.trim()
      ? `: ${reply.error.trim()}`
      : ''
    throw new Error(`group.load-graph failed${detail}`)
  }
  if (!isRecord(reply.graph) || !isRecord(reply.graph.groups)) {
    throw new Error('group.load-graph returned no graph')
  }
  return reply
}

/** Fold one graph reply into its saved layouts. */
export function readNewTabCollections(rawReply: unknown): NewTabCollections {
  const presets: GroupSavedLayout[] = []
  const reply = requireSuccessfulGroupGraphReply(rawReply)
  const graph = reply.graph
  if (!isRecord(graph) || !isRecord(graph.groups)) return { presets }
  for (const value of Object.values(graph.groups)) {
    const preset = foldGroupToLayoutState(value)
    if (preset) presets.push(preset)
  }
  presets.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { presets }
}

/** Every surface id a list holds, at any depth, in member order, each once. */
export function surfaceIdsInList(list: SurfaceCollection): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const visited = new Set<string>()
  const walk = (current: SurfaceCollection) => {
    if (visited.has(current.id)) return
    visited.add(current.id)
    for (const member of current.members) {
      if (member.kind === 'collection') {
        if (member.childCollection) walk(member.childCollection)
      } else if (!seen.has(member.surfaceId)) {
        seen.add(member.surfaceId)
        ids.push(member.surfaceId)
      }
    }
  }
  walk(list)
  return ids
}

/**
 * The lists this app can show, as folders. A list whose only members are other
 * lists is a heading in the sidebar, not a folder of things, so it is shown as
 * the lists inside it (at any depth). A list whose things, at every depth, are
 * all missing from this app's catalog belongs to another app's composition and
 * would only read "0 things". A top-level list holding nothing yet (just
 * created) stays, so a person can fill it; an empty list nested inside another
 * is a section the app fills with its own controls, not a folder of things.
 */
export function listsPresentHere(
  lists: readonly SurfaceCollection[],
  surfaceIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): SurfaceCollection[] {
  const shown: SurfaceCollection[] = []
  const visited = new Set<string>()
  // A list whose DATA says it leads where nothing is open (`leads_where_empty`, at any depth) comes first, as its own
  // folder, when it holds something this pane can open; the rest follow as before.
  const leads: SurfaceCollection[] = []
  const findLeads = (list: SurfaceCollection, seen: Set<string>) => {
    if (seen.has(list.id)) return
    seen.add(list.id)
    if (list.meta?.leads_where_empty === true && surfaceIdsInList(list).some((id) => surfaceIds.has(id))) leads.push(list)
    for (const member of list.members) if (member.kind === 'collection' && member.childCollection) findLeads(member.childCollection, seen)
  }
  const leadSeen = new Set<string>()
  lists.forEach((list) => findLeads(list, leadSeen))
  for (const lead of leads) { visited.add(lead.id); shown.push(lead) }
  const visit = (list: SurfaceCollection, nested: boolean) => {
    if (visited.has(list.id)) return
    visited.add(list.id)
    const children = list.members.flatMap((member) => (member.kind === 'collection' && member.childCollection ? [member.childCollection] : []))
    const holdsThings = list.members.some((member) => member.kind === 'surface')
    if (!holdsThings && children.length > 0) {
      children.forEach((child) => visit(child, true))
      return
    }
    const held = surfaceIdsInList(list)
    // An empty folder shows only when the person made it, so they can put its first thing in.
    if ((held.length === 0 && children.length === 0 && !nested && listMadeByPerson(list)) || held.some((id) => surfaceIds.has(id))) shown.push(list)
  }
  lists.forEach((list) => visit(list, false))
  return shown
}
