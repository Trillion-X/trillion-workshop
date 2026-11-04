// packages/sidebar/show/CollectionSections.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure section-builder for sidebar surface collections (plan T4). Joins the
// folded collection rows (group records — membership SSOT) against the
// placeable-surface catalog feed (surface SSOT) into the NavSectionData shape
// the existing SidebarContent renderer already draws — the renderer itself
// stays 100% blind. Show-all vs per-list filtering is applied here from the
// ONE preference record's DATA value.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure functions — no I/O, no React; unit-testable with plain data.
// 2. Members are joined by surface id; unresolvable refs are skipped (blind
//    tolerance — a member whose surface left the catalog renders nothing).
// 3. No collection_kind enum: everything here keys off data presence.
// 4. Catalog rows are never copied into collections — join at render time.
//
// =============================================================================

import type { NavItemData, NavSectionData } from './SidebarContent'
import { mergeSidebarSettings, readSidebarSettings } from '../read-data/sidebar-settings'
import type { SurfaceCollection } from '../read-data/read-surface-collections'
import type { CollectionViewState } from '../do-work/collection-view-preference'
import { isSpaceRow, SPACE_ROW_ID, SPACE_ROW_LOOK, SPACE_ROW_WORDS } from '../read-data/space-row'
import { repeatsRows } from '../read-data/merge-surface-collections'

/**
 * Build collection sections from the membership rows + the catalog items the
 * sidebar already decoded. `catalogById` is the join index (surface id →
 * NavItemData). Sections honor the view preference: 'show-all' renders every
 * collection section + the full catalog section; any other mode value renders
 * ONLY the collection whose id matches (the value is data, not an enum).
 */
export function buildCollectionSections(
  collections: readonly SurfaceCollection[],
  catalogById: ReadonlyMap<string, NavItemData>,
  view: CollectionViewState,
  allowEditing: boolean = true,
): NavSectionData[] {
  const visible = view.mode === 'show-all'
    ? collections
    : collections.filter((collection) => collection.id === view.mode)

  const sections = visible.map((collection) =>
    buildOneSection(collection, catalogById, view, new Set([collection.id]), allowEditing),
  )
  // A collection whose every member left the catalog is not an empty list, it
  // is a heading for nothing. The member join above already skips a surface
  // the installed packages do not publish, which is what lets one app install
  // fewer packages and get a smaller sidebar with no DATA change. Without this,
  // that app instead gets its FULL set of headings with almost nothing under
  // them, and the fewer packages it installs the more empty headings it shows.
  //
  // While editing they stay: an empty collection is a place to put something,
  // and the picker needs somewhere to put it. A person who cannot edit has no
  // use for a heading with nothing under it and no way to fill it.
  return allowEditing
    ? sections
    : sections.filter((section) => section.items.length > 0 || (section.sections?.length ?? 0) > 0)
}

/**
 * Collect only placeable-surface leaves from the full collection tree. Branch
 * ids never enter the result, and a visited set makes shared or cyclic group
 * graphs safe. The flat catalog uses this set to keep only uncollected leaves.
 */
export function collectSurfaceIds(
  collections: readonly SurfaceCollection[],
  includeRepeating = true,
): Set<string> {
  const surfaceIds = new Set<string>()
  const visitedCollectionIds = new Set<string>()

  const collectOne = (collection: SurfaceCollection): void => {
    if (visitedCollectionIds.has(collection.id)) return
    visitedCollectionIds.add(collection.id)
    for (const member of collection.members) {
      if (member.kind === 'surface' && (includeRepeating || !repeatsRows(collection))) {
        surfaceIds.add(member.surfaceId)
      } else if (member.childCollection) {
        collectOne(member.childCollection)
      }
    }
  }

  for (const collection of collections) collectOne(collection)
  return surfaceIds
}

/** The empty space row as a list row: it opens nothing and pushes the rows apart on a thin bar. */
const SPACE_ITEM: NavItemData = { id: SPACE_ROW_ID, label: SPACE_ROW_WORDS.label, icon: SPACE_ROW_WORDS.icon, look: SPACE_ROW_LOOK }

/**
 * Build ONE collection into a nav section, recursing into branch members
 * (kind==='collection') so a collection tree of ANY depth renders from group
 * DATA with zero per-level code. A leaf member (surface) becomes a NavItem row;
 * a branch member becomes a nested NavSection under `sections`. `visited` guards
 * against a cyclic group graph (a collection referencing itself/an ancestor).
 */
function buildOneSection(
  collection: SurfaceCollection,
  catalogById: ReadonlyMap<string, NavItemData>,
  view: CollectionViewState,
  visited: ReadonlySet<string>,
  allowEditing: boolean,
): NavSectionData {
  const items: NavItemData[] = []
  const subsections: NavSectionData[] = []
  const directSurfaceIds = new Set(
    collection.members
      .filter((member) => member.kind === 'surface')
      .map((member) => member.surfaceId),
  )
  for (const member of collection.members) {
    if (member.kind === 'collection') {
      const child = member.childCollection
      if (!child || visited.has(child.id)) continue // unresolved ref or cycle → skipped
      subsections.push(
        buildOneSection(child, catalogById, view, new Set(visited).add(child.id), allowEditing),
      )
      continue
    }
    // An empty space is the sidebar's own row: it needs no screen in the catalog (read-data/space-row.ts).
    const catalogItem = isSpaceRow(member.surfaceId) ? SPACE_ITEM : catalogById.get(member.surfaceId)
    if (!catalogItem) continue // unresolvable ref → skipped, never fabricated
    items.push({
      ...catalogItem,
      // Unique per-section id so the same surface in N lists renders N rows.
      id: `${collection.id}:${member.memberId}`,
      surfaceId: member.surfaceId,
      // A row's list membership is what the remove action and a drag between
      // lists act on. A list its reader cannot edit carries none, so neither is
      // offered: in a shared list, one reader removing a row removes it for all.
      ...(allowEditing ? { collectionId: collection.id, collectionMemberId: member.memberId } : {}),
      // Member presentation overrides (icon/tint/name) ride on top of catalog
      // data. A package names its surface for everyone; a list names it for the
      // people reading that list, which is how one shared surface reads as
      // "Community" here and keeps its own name everywhere else.
      ...(typeof member.presentation.icon === 'string' ? { icon: member.presentation.icon } : {}),
      ...(typeof member.presentation.name === 'string' && member.presentation.name.trim()
        ? { label: member.presentation.name.trim() }
        : {}),
      // The row level of the sidebar's settings: the screen's own switches, then
      // this list member's, the narrower one winning.
      ...(() => {
        const memberSettings = readSidebarSettings(member.presentation.settings)
        return memberSettings ? { settings: mergeSidebarSettings(catalogItem.settings, memberSettings) } : {}
      })(),
    })
  }
  return {
    id: `collection:${collection.id}`,
    title: collection.name,
    icon: typeof collection.meta.icon === 'string' ? collection.meta.icon : 'Folder',
    ...(() => { const settings = readSidebarSettings(collection.meta.settings); return settings ? { settings } : {} })(),
    // A long list shows its first rows and a Show more row (list DATA `show_at_most`).
    ...(typeof collection.meta.show_at_most === 'number' && collection.meta.show_at_most > 0 ? { showAtMost: collection.meta.show_at_most } : {}),
    items,
    collection,
    attached: collection.attached,
    placement: collection.placement,
    ...(allowEditing ? {
      // Unlisted surfaces (listed === false) are never OFFERED by the picker;
      // an existing explicit member still renders through the join above.
      // An empty space can be added any number of times, so it is always offered, last.
      addableItems: [...Array.from(catalogById.values())
        .filter((item) => !directSurfaceIds.has(item.id) && item.listed !== false), SPACE_ITEM],
    } : {}),
    ...(subsections.length > 0 ? { sections: subsections } : {}),
    collapsible: true,
    defaultCollapsed: view.collapsed[collection.id] === true,
  }
}

/** True when the full catalog section should render (per-list mode hides it). */
export function shouldShowFullCatalog(view: CollectionViewState): boolean {
  return view.mode === 'show-all'
}

/** The toggle cycle for the header control: show-all → each collection → show-all. */
export function nextViewMode(
  current: CollectionViewState,
  collections: readonly SurfaceCollection[],
): string {
  if (collections.length === 0) return 'show-all'
  if (current.mode === 'show-all') return collections[0].id
  const index = collections.findIndex((collection) => collection.id === current.mode)
  if (index < 0 || index === collections.length - 1) return 'show-all'
  return collections[index + 1].id
}
