// packages/sidebar/read-data/read-surface-collections.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Blind decoder for user surface collections (plan T4, master §4.1/W12). A
// collection is a group record whose members reference placeable-surface
// catalog ids; the sidebar renders sections over the folded graph returned by
// the `group.load-graph` door. This module owns ONLY the reply→row translation
// (L098) — zero membership logic, zero group-internal knowledge beyond the
// public graph reply shape, zero catalog duplication (members are id refs the
// caller joins against its own catalog feed).
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Renderer keys off field PRESENCE (a meta member carrying a name), never a
//    collection_kind enum (enum dissolution).
// 2. Unresolvable/malformed members are skipped — never a crash, never a
//    fabricated row.
// 3. The catalog (placeable-surface-list) stays the surface SSOT; this decoder
//    returns REFERENCES (surface ids) only.
//
// =============================================================================

import {
  DEFAULT_SIDEBAR_PLACEMENT_STATE,
  decodeSidebarPlacementValue,
  type SidebarPlacementState,
} from './read-sidebar-placement.ts'

/** The address family sidebar surface-collection groups live under (Society DATA). */
export const SURFACE_COLLECTION_FAMILY = 'group.collection'

/** The default sidebar scope. A scope is just a group.index `parts.scope`
 * value, so ONE sidebar primitive renders the main shell nav (`sidebar`), a
 * settings nav (`settings-sidebar`), or any nested nav, with zero new code. */
export const DEFAULT_SIDEBAR_SCOPE = 'sidebar'

/** Build the index-group ref for a given sidebar scope (generic, L069). */
export const surfaceCollectionIndexRef = (scope: string = DEFAULT_SIDEBAR_SCOPE) => ({
  family: 'group.index',
  parts: { scope, role: 'surface-collections' },
}) as const

/** The ONE index group whose members are all sidebar surface collections
 * (default scope). Kept for callers that do not scope. */
export const SURFACE_COLLECTION_INDEX_REF = surfaceCollectionIndexRef(DEFAULT_SIDEBAR_SCOPE)

/** Whether the person made this list themselves: it carries when it was made (`made_at`, written when a list is made).
 *  Only such a list shows while it is empty, so its first row can be put in. A list Trillion offers, or a copy of one
 *  kept from an earlier sidebar, shows only while it holds something. */
export function listMadeByPerson(collection: Pick<SurfaceCollection, 'appList' | 'meta'>): boolean {
  return !collection.appList && collection.meta.made_at !== undefined
}

/** The designated member role carrying a collection's display meta. */
export const COLLECTION_META_ROLE = 'collection-meta'

export interface SurfaceCollectionMember {
  /** The member's id inside the group (needed for remove/reorder dispatch). */
  memberId: string
  /** The referenced id: a placeable-surface catalog id (leaf) OR a child collection id (branch). */
  surfaceId: string
  /**
   * Leaf vs branch, derived from the member's nodeRef.family (field-presence,
   * NOT an enum): a member pointing at another `group.collection` is a nested
   * sub-collection ('collection'); anything else is a surface leaf ('surface').
   * This is the one thing that makes the sidebar a recursive group tree instead
   * of a 2-level flat list, because group already stores the tree.
   */
  kind: 'surface' | 'collection'
  /**
   * For a branch member (kind==='collection'), the resolved child collection,
   * linked in a post-decode pass so the renderer recurses over a real tree with
   * no second lookup map. Null when the ref is unresolvable (blind tolerance).
   */
  childCollection?: SurfaceCollection | null
  /** Opaque presentation hints (icon/tint), renderer-read only. */
  presentation: Record<string, unknown>
}

export interface SurfaceCollection {
  /** The collection's group id (parts.id of its groupRef). */
  id: string
  name: string
  members: SurfaceCollectionMember[]
  /** Whether the collection is rendered inline in its parent sidebar. */
  attached: boolean
  /** Placement used when this collection is rendered in its own sidebar. */
  placement: SidebarPlacementState
  /** Collection meta other than its name (including typed placement fields). */
  meta: Record<string, unknown>
  /**
   * Present when the app provides this list and the person's edits of it are
   * kept: `saved` says whether the person already has their own copy of it.
   * The first edit of an unsaved one saves the list as shown, then applies.
   */
  appList?: { saved: boolean }
}

/** A detached collection defaults to a right-docked sidebar. */
export const DEFAULT_SURFACE_COLLECTION_PLACEMENT: SidebarPlacementState = {
  ...DEFAULT_SIDEBAR_PLACEMENT_STATE,
  position: 'right',
  floatRect: { ...DEFAULT_SIDEBAR_PLACEMENT_STATE.floatRect },
}

interface RawMember {
  memberId?: string
  role?: string
  nodeRef?: { family?: string; parts?: Record<string, string> }
  presentation?: Record<string, unknown>
}

interface RawGroup {
  groupRef?: { family?: string; parts?: Record<string, string> }
  memberOrder?: string[]
  members?: Record<string, RawMember>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Decode ONE group value into a collection row, or null (blind tolerance). */
export function decodeSurfaceCollection(value: unknown): SurfaceCollection | null {
  if (!isRecord(value)) return null
  const group = value as RawGroup
  if (group.groupRef?.family !== SURFACE_COLLECTION_FAMILY) return null
  const id = group.groupRef?.parts?.id
  if (!id) return null
  const order = Array.isArray(group.memberOrder) ? group.memberOrder : []
  const rawMembers: Record<string, RawMember> = isRecord(group.members)
    ? group.members as Record<string, RawMember>
    : {}

  let name: string | null = null
  let meta: Record<string, unknown> = {}
  const members: SurfaceCollectionMember[] = []
  for (const memberId of order) {
    const rawMember: unknown = rawMembers[memberId]
    if (!isRecord(rawMember)) continue
    const member = rawMember as RawMember
    if (member.role === COLLECTION_META_ROLE) {
      const presentation = isRecord(member.presentation) ? member.presentation : {}
      const { name: rawName, ...rest } = presentation
      if (typeof rawName === 'string' && rawName.trim().length > 0) name = rawName.trim()
      meta = rest
      continue
    }
    const surfaceId = member.nodeRef?.parts?.id
    if (typeof member.memberId !== 'string' || !surfaceId) continue
    // Branch vs leaf by nodeRef.family presence: a member pointing at another
    // group.collection is a nested sub-collection; anything else is a surface leaf.
    const kind: 'surface' | 'collection' =
      member.nodeRef?.family === SURFACE_COLLECTION_FAMILY ? 'collection' : 'surface'
    members.push({
      memberId: member.memberId,
      surfaceId,
      kind,
      presentation: isRecord(member.presentation) ? member.presentation : {},
    })
  }
  // Field-presence gate: a group WITHOUT a named meta member is not a sidebar
  // collection (it may be a layout preset or any other group configuration).
  if (!name) return null
  const placement = meta.placement === undefined
    ? DEFAULT_SURFACE_COLLECTION_PLACEMENT
    : decodeSidebarPlacementValue(meta.placement)
  const attached = typeof meta.attached === 'boolean' ? meta.attached : true
  return { id, name, members, attached, placement, meta }
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array || (ArrayBuffer.isView(value) && value.constructor.name === 'Uint8Array')
}

/**
 * The live transport returns `{ payload: Uint8Array }` (BitfieldTargetReply);
 * the door's JSON rides inside those bytes. Decode that envelope first —
 * handing the raw reply to the graph reader silently yields zero collections
 * (the exact bug that hid every list from the sidebar).
 */
export function decodeGraphReply(reply: unknown): unknown {
  const payload = isRecord(reply) && isBytes(reply.payload) ? reply.payload : reply
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
 * Is this raw group the ONE surface-collection index group (Society DATA)? Its
 * `memberOrder` is the authored section order.
 */
function isIndexGroup(value: unknown): value is RawGroup {
  if (!isRecord(value)) return false
  const ref = (value as RawGroup).groupRef
  // Scope-agnostic: a graph is loaded from ONE index root, so any group with the
  // index family + surface-collections role IS this scope's index (whether the
  // scope is `sidebar`, `settings-sidebar`, or any nested scope). Comparing the
  // scope here would wrongly reject every non-default sidebar (L069).
  return (
    ref?.family === SURFACE_COLLECTION_INDEX_REF.family &&
    ref?.parts?.role === SURFACE_COLLECTION_INDEX_REF.parts.role
  )
}

/**
 * Decode the whole `group.load-graph` reply into ordered collection rows.
 *
 * Section order is DATA: it honors the index group's `memberOrder` (each index
 * member's `nodeRef.parts.id` names a collection), NEVER an alphabetical
 * name sort. Any decoded collection the index does not reference (defensive)
 * follows in stable graph order so nothing is dropped.
 */
export function readSurfaceCollections(rawReply: unknown): SurfaceCollection[] {
  const reply = decodeGraphReply(rawReply)
  if (!isRecord(reply)) return []
  const graph = reply.graph
  if (!isRecord(graph) || !isRecord(graph.groups)) return []

  const byId = new Map<string, SurfaceCollection>()
  let indexGroup: RawGroup | null = null
  for (const value of Object.values(graph.groups)) {
    if (isIndexGroup(value)) {
      indexGroup = value
      continue
    }
    const collection = decodeSurfaceCollection(value)
    if (collection) byId.set(collection.id, collection)
  }

  const ordered: SurfaceCollection[] = []
  const placed = new Set<string>()
  if (indexGroup) {
    const order = Array.isArray(indexGroup.memberOrder) ? indexGroup.memberOrder : []
    const rawMembers: Record<string, RawMember> = isRecord(indexGroup.members)
      ? indexGroup.members as Record<string, RawMember>
      : {}
    for (const memberId of order) {
      const member = rawMembers[memberId]
      const collectionId = isRecord(member) ? (member as RawMember).nodeRef?.parts?.id : undefined
      if (!collectionId || placed.has(collectionId)) continue
      const collection = byId.get(collectionId)
      if (collection) {
        ordered.push(collection)
        placed.add(collectionId)
      }
    }
  }
  // Link branch members to their child collection so the renderer recurses over
  // a real tree with no second lookup map, and collect child ids so children
  // render ONLY nested under their parent, never as a top-level orphan section.
  // (Cycle safety is the renderer's job via a visited set; the linker only sets
  // references.)
  const childIds = new Set<string>()
  for (const collection of byId.values()) {
    for (const member of collection.members) {
      if (member.kind !== 'collection') continue
      childIds.add(member.surfaceId)
      member.childCollection = byId.get(member.surfaceId) ?? null
    }
  }
  for (const [id, collection] of byId) {
    if (!placed.has(id) && !childIds.has(id)) ordered.push(collection)
  }
  return ordered
}
