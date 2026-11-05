// parts/sidebar/read-data/merge-surface-collections.ts
//
// PURPOSE
//   Lay the person's saved copy of each app-provided list over that list, and
//   append the person's own lists. Pure: no I/O, no React.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A saved copy decides its rows' order and which rows are gone (a row kept
//      with presentation.removed === true); rows the app added after the copy
//      was saved still show, right after the app row they follow.
//   2. Name, icon and settings stay the app's, so a changed app list reaches
//      everyone; where a list sits (placement, attached) is the person's.
//   3. Every app list is marked `appList: { saved }`, so its first edit saves it.
//   4. A cyclic list tree terminates (each path visits a list once).
//   5. Each screen shows in one list only (showEachSurfaceOnce): where the
//      person put it (a list of their own, or a row they added to a saved copy)
//      wins over where the app puts it; otherwise the first list in the order
//      shown keeps it. A screen no list keeps is left to the uncollected
//      catalog, so nothing offered is dropped.
//   6. A row in a saved copy that the app has since moved to another of its
//      lists follows the app; a row the person put there (`placed_by_person`)
//      stays where they put it.
//   7. A list whose settings say `repeats_rows` (New: rows a rule picks out
//      again) shows rows that also sit in their own lists: it keeps every row
//      it holds and takes none from any other list, nor moves one.

import type { SurfaceCollection, SurfaceCollectionMember } from './read-surface-collections.ts'
import { isSpaceRow } from './space-row.ts'

/** Whether a list shows rows that also sit in their own lists (invariant 7). */
export const repeatsRows = (collection: SurfaceCollection) =>
  (collection.meta.settings as Record<string, unknown> | undefined)?.repeats_rows === true

/** Every list id in a tree of lists, children included. */
export function surfaceCollectionIds(collections: readonly SurfaceCollection[]): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const walk = (collection: SurfaceCollection) => {
    if (seen.has(collection.id)) return
    seen.add(collection.id)
    ids.push(collection.id)
    for (const member of collection.members) if (member.childCollection) walk(member.childCollection)
  }
  collections.forEach(walk)
  return ids
}

/**
 * The app's lists with the person's saved copy of each laid over it, then the
 * person's own lists. A saved copy decides the order of its rows and which ones
 * are gone (a row kept with `removed`); a row the app added since the copy was
 * saved still shows, right after the app row it follows. Name, icon and
 * settings stay the app's; where a list sits (placement, attached) is the
 * person's. Each app list is marked `appList`, so its first edit saves it.
 */
export function mergeSurfaceCollections(
  projected: SurfaceCollection[],
  durable: SurfaceCollection[],
): SurfaceCollection[] {
  const saved = new Map<string, SurfaceCollection>()
  const collect = (collection: SurfaceCollection) => {
    if (saved.has(collection.id)) return
    saved.set(collection.id, collection)
    for (const member of collection.members) if (member.childCollection) collect(member.childCollection)
  }
  durable.forEach(collect)
  const appIds = new Set(surfaceCollectionIds(projected))
  // Each empty space is its own row (space-row.ts), so it goes by its member id; every other row by its screen.
  const key = (member: SurfaceCollectionMember) => isSpaceRow(member.surfaceId) ? `space:${member.memberId}` : `${member.kind}:${member.surfaceId}`
  // Rows the person put where they are: every row of a list of their own, and a row in their saved copy of an app
  // list that the app's own list does not hold. A saved copy holds every row the list showed when it was first
  // edited, so a row the app has since moved to another of its lists follows the app, unless the person put it
  // there themselves (`placed_by_person`, written by addRowOps).
  const appListsHolding = new Map<string, Set<string>>()
  const gatherAppRows = (collection: SurfaceCollection, path: ReadonlySet<string>) => {
    for (const member of collection.members) {
      if (member.kind === 'surface' && !repeatsRows(collection)) {
        const lists = appListsHolding.get(key(member)) ?? new Set<string>()
        lists.add(collection.id)
        appListsHolding.set(key(member), lists)
      }
      if (member.childCollection && !path.has(member.childCollection.id)) gatherAppRows(member.childCollection, new Set(path).add(member.childCollection.id))
    }
  }
  projected.forEach((collection) => gatherAppRows(collection, new Set([collection.id])))
  const movedByApp = (listId: string, member: SurfaceCollectionMember) =>
    member.kind === 'surface' && member.presentation.placed_by_person !== true
    && [...(appListsHolding.get(key(member)) ?? [])].some((id) => id !== listId)
  const placedByPerson = new Set<string>()
  const placed = (listId: string, member: SurfaceCollectionMember) => `${listId}\n${member.memberId}`

  const overlay = (app: SurfaceCollection, path: ReadonlySet<string>): SurfaceCollection => {
    const own = saved.get(app.id)
    const child = (member: SurfaceCollectionMember): SurfaceCollectionMember => {
      const appChild = member.childCollection && appIds.has(member.childCollection.id) ? member.childCollection : null
      return appChild && !path.has(appChild.id)
        ? { ...member, childCollection: overlay(appChild, new Set(path).add(appChild.id)) }
        : member
    }
    if (!own) return { ...app, members: app.members.map(child), appList: { saved: false } }
    const known = new Set(own.members.map(key))
    const nestedKeys = new Set<string>()
    const collectNestedKeys = (member: SurfaceCollectionMember) => {
      if (!member.childCollection) return
      for (const child of member.childCollection.members) {
        nestedKeys.add(key(child))
        collectNestedKeys(child)
      }
    }
    app.members.forEach(collectNestedKeys)
    const byKey = new Map(app.members.map((member) => [key(member), member]))
    const members = own.members.filter((member) => member.presentation.removed !== true
      && !(member.kind === 'surface' && nestedKeys.has(key(member)))
      && !(!byKey.has(key(member)) && movedByApp(app.id, member))
      // A list a rule fills keeps a row its rule no longer picks only when the person put it there.
      && !(repeatsRows(app) && member.kind === 'surface' && !byKey.has(key(member)) && member.presentation.placed_by_person !== true))
    for (const member of members) if (member.kind === 'surface' && !byKey.has(key(member))) placedByPerson.add(placed(app.id, member))
    // Rows the app added after the copy was saved go right after the app row before them.
    app.members.forEach((member, index) => {
      if (known.has(key(member))) return
      const before = app.members.slice(0, index).reverse().find((candidate) => members.some((shown) => key(shown) === key(candidate)))
      const at = before ? members.findIndex((shown) => key(shown) === key(before)) + 1 : 0
      members.splice(at, 0, member)
      known.add(key(member))
    })
    return {
      ...app,
      attached: own.meta.attached !== undefined ? own.attached : app.attached,
      placement: own.meta.placement !== undefined ? own.placement : app.placement,
      meta: { ...app.meta, ...(own.meta.placement !== undefined ? { placement: own.meta.placement } : {}), ...(own.meta.attached !== undefined ? { attached: own.meta.attached } : {}) },
      members: members.map((member) => child(byKey.get(key(member)) ?? member)),
      appList: { saved: true },
    }
  }

  const own = durable.filter((collection) => !appIds.has(collection.id))
  for (const collection of own) {
    for (const id of surfaceCollectionIds([collection])) {
      const list = saved.get(id)
      if (list && !appIds.has(id)) for (const member of list.members) if (member.kind === 'surface') placedByPerson.add(placed(id, member))
    }
  }
  return showEachSurfaceOnce(
    [...projected.map((collection) => overlay(collection, new Set([collection.id]))), ...own],
    (list, member) => placedByPerson.has(placed(list.id, member)),
  )
}

/**
 * The lists with each screen in one of them only. `placedByPerson` says which
 * rows the person put where they are; such a row wins over a row the app placed,
 * and among equals the first in the order shown (each list's rows, then the
 * lists inside it) keeps the screen. A list shown in more than one place, or
 * inside itself, is read once.
 */
export function showEachSurfaceOnce(
  collections: SurfaceCollection[],
  placedByPerson: (list: SurfaceCollection, member: SurfaceCollectionMember) => boolean = () => false,
): SurfaceCollection[] {
  const keeper = new Map<string, { listId: string; memberId: string; person: boolean }>()
  const read = new Set<string>()
  const walk = (list: SurfaceCollection) => {
    if (read.has(list.id)) return
    read.add(list.id)
    for (const member of list.members) {
      if (member.kind !== 'surface' || repeatsRows(list) || isSpaceRow(member.surfaceId)) continue
      const person = placedByPerson(list, member)
      const kept = keeper.get(member.surfaceId)
      if (!kept || (person && !kept.person)) keeper.set(member.surfaceId, { listId: list.id, memberId: member.memberId, person })
    }
    for (const member of list.members) if (member.childCollection) walk(member.childCollection)
  }
  collections.forEach(walk)
  const keep = (list: SurfaceCollection, path: ReadonlySet<string>): SurfaceCollection => {
    const shownHere = new Set<string>()
    return {
      ...list,
      members: list.members.flatMap((member) => {
        if (member.kind === 'surface') {
          // An empty space is no screen: every one stays where it stands.
          if (isSpaceRow(member.surfaceId)) return [member]
          if (shownHere.has(member.surfaceId)) return []
          if (repeatsRows(list)) {
            shownHere.add(member.surfaceId)
            return [member]
          }
          const kept = keeper.get(member.surfaceId)
          if (!kept || kept.listId !== list.id || kept.memberId !== member.memberId) return []
          shownHere.add(member.surfaceId)
          return [member]
        }
        const child = member.childCollection
        return [child && !path.has(child.id) ? { ...member, childCollection: keep(child, new Set(path).add(child.id)) } : member]
      }),
    }
  }
  return collections.map((list) => keep(list, new Set([list.id])))
}
