// packages/sidebar/show/ProjectedCollectionNav.ts
//
// A projection is a caller-owned graph in the same group.collection shape the
// sidebar already owns. It lets a live owner join its SSOT rows to the sidebar
// without forking a second sidebar shell or copying rows into this package.

import type { NavItemActionData, NavItemData } from './SidebarContent.tsx';

export interface ProjectedNavItem {
  id: string;
  label: string;
  icon?: string;
  badge?: string;
  actions?: readonly NavItemActionData[];
  disabled?: boolean;
  listed?: boolean;
  /** Generic placeable capability carried through the shared catalog projection. */
  placeableSurface?: boolean;
  packageEntry?: NavItemData['packageEntry'];
  surfaceInput?: NavItemData['surfaceInput'];
  /** Caller-owned activation routing; `local` preserves this sidebar's onNavigate click path. */
  navigation?: NavItemData['navigation'];
}

function assertUniqueItemIdentities(items: readonly ProjectedNavItem[]): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error('Duplicate item identity in sidebar navigation.');
    ids.add(item.id);
  }
}

export function projectedNavItemsToCatalogItems(
  items: readonly ProjectedNavItem[],
): NavItemData[] {
  return items.map((item) => ({
    id: item.id,
    // Sidebar list membership namespaces rendered ids. Keep the owner identity
    // in viewId so click and active-state routing still address the source row.
    viewId: item.id,
    label: item.label,
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.badge ? { badge: item.badge } : {}),
    ...(item.actions ? { actions: [...item.actions] } : {}),
    ...(item.disabled === true ? { disabled: true } : {}),
    ...(item.listed === false ? { listed: false } : {}),
    ...(item.placeableSurface === true ? { placeableSurface: true } : {}),
    ...(item.packageEntry ? { packageEntry: item.packageEntry } : {}),
    ...(item.surfaceInput ? { surfaceInput: item.surfaceInput } : {}),
    ...(item.navigation ? { navigation: item.navigation } : {}),
  }));
}

export interface ProjectedCollectionInput {
  id: string;
  name: string;
  /** The list's own icon (a Lucide name): what a collapsed rail shows for it instead of the default folder. */
  icon?: string;
  /** The list level of the sidebar's settings (named true/false switches such as `add_to_list`). */
  settings?: Readonly<Record<string, boolean>>;
  /** How many rows the list shows before a Show more row, so a long list stays short. */
  showAtMost?: number;
  itemFamily?: string;
  items: readonly ProjectedNavItem[];
  /** The caller renders useful controls in this collection's content host. */
  hasContentHost?: boolean;
  /** An empty pane offers this list first, open, before every other list (the same list the sidebar shows). */
  leadsWhereEmpty?: boolean;
  /**
   * Lists inside this list, to any depth.
   *
   * The sidebar has always drawn an arbitrarily deep tree: a collection member
   * that points at another collection becomes a nested section, one recursive
   * component draws every level, and a parent collapse hides the whole subtree.
   * This projection was the only flat thing in the chain, so every caller
   * arriving through it had its tree crushed to one level before the sidebar
   * ever saw it, and the depth the sidebar owns looked like it did not exist.
   */
  collections?: readonly ProjectedCollectionInput[];
}

/** A list is worth drawing when something is in it, at any depth. A list whose
 * every descendant is empty is chrome telling the reader nothing. */
function collectionHoldsAnything(collection: ProjectedCollectionInput): boolean {
  if (collection.items.length > 0 || collection.hasContentHost) return true;
  return (collection.collections ?? []).some(collectionHoldsAnything);
}

/**
 * The same projection for callers whose rows arrive in NAMED GROUPS rather than
 * one flat list. Every caller that used to hand a hand-rolled sidebar a
 * `groups` array uses this: each group becomes a real collection the owned
 * sidebar renders, so grouping stops being a private feature of a second
 * sidebar and becomes the collection model the platform already has.
 *
 * Empty groups are dropped, because a titled group with nothing under it is
 * chrome telling the reader nothing.
 */
export function buildProjectedCollectionsNav(input: {
  scope: string;
  collections: readonly ProjectedCollectionInput[];
}): unknown {
  // Collection identity owns the graph key, at every depth. Reject ambiguous
  // input before dropping empty groups, otherwise a source refresh can silently
  // replace another collection. Shared item identities across collections remain
  // valid. A collection that contains itself, however deep the ring, is refused
  // here rather than drawn until the renderer runs out of stack.
  const collectionIds = new Set<string>();
  const assertCollection = (collection: ProjectedCollectionInput, ancestors: readonly string[]) => {
    if (ancestors.includes(collection.id)) {
      throw new Error('A list in sidebar navigation contains itself.');
    }
    if (collectionIds.has(collection.id)) throw new Error('Duplicate collection identity in sidebar navigation.');
    collectionIds.add(collection.id);
    assertUniqueItemIdentities(collection.items);
    for (const child of collection.collections ?? []) {
      assertCollection(child, [...ancestors, collection.id]);
    }
  };
  for (const collection of input.collections) assertCollection(collection, []);

  const collections = input.collections.filter(collectionHoldsAnything);
  const collectionGroups: Record<string, unknown> = Object.create(null);
  const indexMembers: Record<string, unknown> = {};
  const indexOrder: string[] = [];

  // One collection becomes one group, and a list inside it becomes a member
  // pointing at that list's own group. The sections builder follows exactly that
  // pointer to recurse, so depth costs nothing here beyond registering the group.
  const registerCollection = (collection: ProjectedCollectionInput) => {
    const itemFamily = collection.itemFamily ?? 'sidebar.item';
    const itemMembers = collection.items.map((item) => [
      `item:${item.id}`,
      {
        memberId: `item:${item.id}`,
        nodeRef: { family: itemFamily, parts: { id: item.id } },
        presentation: {},
      },
    ] as const);

    const children = (collection.collections ?? []).filter(collectionHoldsAnything);
    const childMembers = children.map((child) => [
      `collection:${child.id}`,
      {
        memberId: `collection:${child.id}`,
        nodeRef: { family: 'group.collection', parts: { id: child.id } },
      },
    ] as const);

    collectionGroups[`collection:${collection.id}`] = {
      groupRef: { family: 'group.collection', parts: { id: collection.id } },
      memberOrder: [
        'meta',
        ...itemMembers.map(([id]) => id),
        ...childMembers.map(([id]) => id),
      ],
      members: {
        meta: {
          memberId: 'meta',
          role: 'collection-meta',
          nodeRef: { family: 'sidebar.collection-meta', parts: { id: collection.id } },
          presentation: { name: collection.name, ...(collection.leadsWhereEmpty ? { leads_where_empty: true } : {}), ...(collection.icon ? { icon: collection.icon } : {}), ...(collection.settings ? { settings: collection.settings } : {}), ...(collection.showAtMost ? { show_at_most: collection.showAtMost } : {}) },
        },
        ...Object.fromEntries(itemMembers),
        ...Object.fromEntries(childMembers),
      },
    };

    for (const child of children) registerCollection(child);
  };

  for (const collection of collections) {
    const memberId = `collection:${collection.id}`;
    indexOrder.push(memberId);
    indexMembers[memberId] = {
      memberId,
      nodeRef: { family: 'group.collection', parts: { id: collection.id } },
    };
    registerCollection(collection);
  }

  return {
    graph: {
      groups: {
        index: {
          groupRef: { family: 'group.index', parts: { scope: input.scope, role: 'surface-collections' } },
          memberOrder: indexOrder,
          members: indexMembers,
        },
        ...collectionGroups,
      },
    },
  };
}

/** Catalog rows for every item across every projected collection, at every
 * depth. A row the catalog does not carry cannot be resolved, so walking only
 * the top level would draw a deep tree whose deeper rows do nothing when
 * clicked. */
export function projectedCollectionsToCatalogItems(
  collections: readonly ProjectedCollectionInput[],
): NavItemData[] {
  return collections.flatMap((collection) => [
    ...projectedNavItemsToCatalogItems(collection.items),
    ...projectedCollectionsToCatalogItems(collection.collections ?? []),
  ]);
}
