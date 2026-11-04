// parts/sidebar/do-work/surface-collection-ops.ts
//
// PURPOSE
//   Every change to a person's sidebar lists as the group ops it is: make a list, name it, place it, delete it, and
//   add, take out, order or move a row. Pure: these build op lists and never send them, so the page's sidebar
//   (edit-surface-collections.ts, through the group door) and the Worker (src/sidebar.mjs, for the person's AIs)
//   change lists the same way.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A list the app provides becomes the person's own the first time it changes: it is saved exactly as shown (its
//      name and every row in order) in the same batch as the change (saveAsShownFirst).
//   2. A row taken out of an app list stays in the person's copy marked removed, so the app's row does not come back;
//      putting it back clears that mark first.
//   3. Nothing here names a list, a row or a screen.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import {
  COLLECTION_META_ROLE,
  DEFAULT_SIDEBAR_SCOPE,
  SURFACE_COLLECTION_FAMILY,
  surfaceCollectionIndexRef,
  type SurfaceCollection,
} from '../read-data/read-surface-collections.ts'
import { isSpaceRow, spaceMemberId } from '../read-data/space-row.ts'

export type SurfaceCollectionOp = Record<string, unknown>
export type RowPlacement = { index: number } | { before: string } | { after: string } | { at: 'start' | 'end' }

export const collectionRef = (collectionId: string) => ({
  family: SURFACE_COLLECTION_FAMILY,
  parts: { id: collectionId },
})

export const surfaceRef = (surfaceId: string) => ({
  family: 'placeable-surface',
  parts: { id: surfaceId },
})

/** The member id a row has in any list. */
export const rowMemberId = (surfaceId: string) => `surface:${surfaceId}`

/** The ops that save an app list as shown, before its first change (invariant 1); none for a list already saved. */
export function saveAsShownFirst(list: SurfaceCollection | undefined): SurfaceCollectionOp[] {
  if (!list?.appList || list.appList.saved) return []
  const groupRef = collectionRef(list.id)
  return [
    { kind: 'ensure-group', groupRef },
    {
      kind: 'add-member',
      groupRef,
      memberId: 'meta',
      nodeRef: { family: 'sidebar.collection-meta', parts: { id: list.id } },
      role: COLLECTION_META_ROLE,
      presentation: { name: list.name },
    },
    ...list.members.map((member) => ({
      kind: 'add-member',
      groupRef,
      memberId: member.memberId,
      nodeRef: member.kind === 'collection' ? collectionRef(member.surfaceId) : surfaceRef(member.surfaceId),
      ...(Object.keys(member.presentation).length > 0 ? { presentation: member.presentation } : {}),
    })),
  ]
}

/** Make a list: its group, its name (with any more of its own meta, such as when it was made and a rule it holds or
 * shows by, read-data/apply-list-rules.ts) and its place in the index. */
export function createListOps(collectionId: string, name: string, scope = DEFAULT_SIDEBAR_SCOPE, meta: Record<string, unknown> = {}): SurfaceCollectionOp[] {
  const groupRef = collectionRef(collectionId)
  return [
    { kind: 'ensure-group', groupRef },
    {
      kind: 'add-member',
      groupRef,
      memberId: 'meta',
      nodeRef: { family: 'sidebar.collection-meta', parts: { id: collectionId } },
      role: COLLECTION_META_ROLE,
      presentation: { ...meta, name },
    },
    { kind: 'add-member', groupRef: surfaceCollectionIndexRef(scope), memberId: `collection:${collectionId}`, nodeRef: groupRef },
  ]
}

/** Change a list's name, or where it sits, on its saved copy. */
export function patchListOps(collection: SurfaceCollection, presentation: Record<string, unknown>): SurfaceCollectionOp[] {
  return [
    ...saveAsShownFirst(collection),
    { kind: 'patch-member-presentation', groupRef: collectionRef(collection.id), memberId: 'meta', presentation },
  ]
}

/** Delete a list: tombstone its group and take it out of the index. */
export function deleteListOps(collectionId: string, scope = DEFAULT_SIDEBAR_SCOPE): SurfaceCollectionOp[] {
  return [
    { kind: 'delete-group', groupRef: collectionRef(collectionId) },
    { kind: 'remove-member', groupRef: surfaceCollectionIndexRef(scope), memberId: `collection:${collectionId}` },
  ]
}

/** Add a row to a list (other lists untouched); `list` is the list as shown, needed when the app provides it. */
export function addRowOps(collectionId: string, surfaceId: string, list?: SurfaceCollection, placement?: RowPlacement): SurfaceCollectionOp[] {
  const groupRef = collectionRef(collectionId)
  // An empty space may stand in a list any number of times, so each one added is a new row (read-data/space-row.ts).
  const space = isSpaceRow(surfaceId)
  const memberId = space ? spaceMemberId() : rowMemberId(surfaceId)
  return [
    ...saveAsShownFirst(list),
    // Invariant 2: a row the person took out of an app list is put back by clearing its removed mark first.
    ...(list?.appList && !space ? [{ kind: 'remove-member', groupRef, memberId }] : []),
    // The person put this row here, so it stays here even when the app later places the same screen in another list.
    { kind: 'add-member', groupRef, memberId, nodeRef: surfaceRef(surfaceId), presentation: { placed_by_person: true }, ...(placement ? { placement } : {}) },
  ]
}

/** Take a row out of a list; from an app list it stays in the person's copy marked removed (invariant 2). */
export function removeRowOps(collectionId: string, memberId: string, list?: SurfaceCollection): SurfaceCollectionOp[] {
  const groupRef = collectionRef(collectionId)
  return [
    ...saveAsShownFirst(list),
    list?.appList
      ? { kind: 'patch-member-presentation', groupRef, memberId, presentation: { removed: true } }
      : { kind: 'remove-member', groupRef, memberId },
  ]
}

/** Change what a row's place in a list carries (the rule it shows by), on the list's saved copy. */
export function patchRowOps(collectionId: string, memberId: string, presentation: Record<string, unknown>, list?: SurfaceCollection): SurfaceCollectionOp[] {
  return [
    ...saveAsShownFirst(list),
    { kind: 'patch-member-presentation', groupRef: collectionRef(collectionId), memberId, presentation },
  ]
}

/** Move a row to another place in its list. */
export function reorderRowOps(collectionId: string, memberId: string, placement: RowPlacement, list?: SurfaceCollection): SurfaceCollectionOp[] {
  return [
    ...saveAsShownFirst(list),
    { kind: 'reorder-member', groupRef: collectionRef(collectionId), memberId, placement },
  ]
}
