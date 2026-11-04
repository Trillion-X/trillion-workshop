// parts/group/read-data/kept-library.ts
//
// PURPOSE
//   A kept library: things a person keeps (tours, layouts, anything) filed in named categories and found again by
//   Recent, kept as group records. One index group lists the categories in order; each category is a group whose
//   members are the kept things. Which families and ids a library uses is one DATA row (KeptLibrary) its owner keeps
//   beside its own DATA (parts/guided-overlay/tour-library.json, parts/screen-arrangement/layout-library.json), so a
//   new kind of kept thing gets categories and Recent by adding a row, with no code here.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Blind: nothing here names what is kept; every family and id prefix comes from the row.
//   2. Pure: a graph in, rows or ops out. The store that writes (applyGroupOp + buildGroupWriteBatch) and the page that
//      reads (group.load-graph) both go through these, so they always agree.
//   3. A thing sits in at most one category: filing it removes it from any other first. A category is matched by its
//      name without regard to case, and made (in the index, last) the first time it is named.
//   4. A category whose group is gone is left out; an emptied category stays, in its place, until removed.

import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getGroup, membersOf, type GroupGraph } from '../../ui/show/group/group-graph';
import type { AddressRef } from '../../../../turn-frames-into-slides/read-data/visual-layer-types';
import type { GroupMutationOp } from '../../../../organize-the-sidebar/do-work/group-op-transitions';

/** One library's row: where its index group is and how its categories and members are addressed. */
export interface KeptLibrary {
  readonly index_ref: AddressRef;
  readonly category_family: string;
  readonly member_family: string;
  readonly member_id_prefix: string;
  readonly category_id_prefix: string;
  readonly recent_count: number;
}

export interface LibraryCategory {
  readonly category_id: string;
  readonly name: string;
  /** The kept things' own ids, in the category's order. */
  readonly members: readonly string[];
}

const words = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
// Slugs lose punctuation and suffixes. Hash the complete normalized name into a bounded BLAKE3 identity.
// JSON preserves distinct UTF-16 strings, including unmatched surrogate code units.
const categoryIdentity = (name: string): string =>
  `category-1f:${bytesToHex(blake3(new TextEncoder().encode(JSON.stringify(name))))}`;

export const libraryCategoryRef = (library: KeptLibrary, id: string): AddressRef => ({ family: library.category_family, parts: { id } });
export const libraryMemberRef = (library: KeptLibrary, id: string): AddressRef => ({ family: library.member_family, parts: { id } });
const memberIdOf = (library: KeptLibrary, id: string): string => `${library.member_id_prefix}${id}`;
const categoryMemberIdOf = (library: KeptLibrary, id: string): string => `${library.category_id_prefix}${id}`;

/** The categories in the index's order, each with its kept things in order (invariant 4). */
export function libraryCategories(graph: GroupGraph, library: KeptLibrary): LibraryCategory[] {
  return membersOf(graph, library.index_ref).flatMap((member) => {
    if (!getGroup(graph, member.nodeRef)) return [];
    const id = words(member.nodeRef.parts?.id);
    return [{
      category_id: id,
      name: words(member.presentation?.name) || id,
      members: membersOf(graph, member.nodeRef).map((one) => words(one.nodeRef.parts?.id)).filter(Boolean),
    }];
  });
}

/** The ids of the newest kept things by when each was saved, newest first. */
export function libraryRecent(items: readonly { id: string; saved_at?: unknown }[], library: KeptLibrary): string[] {
  return [...items]
    .sort((a, b) => String(b.saved_at ?? '').localeCompare(String(a.saved_at ?? '')))
    .slice(0, library.recent_count)
    .map((item) => item.id);
}

/** The ops that file one kept thing under the named category (invariant 3). `newId` names a category made here. */
export function libraryFileOps(graph: GroupGraph, library: KeptLibrary, id: string, name: string, newId: () => string): GroupMutationOp[] {
  const ops: GroupMutationOp[] = [];
  const categories = libraryCategories(graph, library);
  const foldedName = words(name).toLowerCase();
  const same = (category: LibraryCategory) => category.name.toLowerCase() === foldedName;
  for (const category of categories) {
    if (category.members.includes(id) && !same(category))
      ops.push({ kind: 'remove-member', groupRef: libraryCategoryRef(library, category.category_id), memberId: memberIdOf(library, id) });
  }
  let category = categories.find(same);
  if (!category) {
    const identity = foldedName ? categoryIdentity(foldedName) : newId();
    const idExists = (id: string) => categories.some(existing => existing.category_id === id)
      || Boolean(getGroup(graph, libraryCategoryRef(library, id)));
    let categoryId = identity;
    if (idExists(categoryId)) {
      do { categoryId = newId(); } while (!categoryId || idExists(categoryId));
    }
    const ref = libraryCategoryRef(library, categoryId);
    ops.push({ kind: 'ensure-group', groupRef: library.index_ref });
    ops.push({ kind: 'ensure-group', groupRef: ref });
    ops.push({ kind: 'add-member', groupRef: library.index_ref, nodeRef: ref, memberId: categoryMemberIdOf(library, categoryId), presentation: { name } });
    category = { category_id: categoryId, name, members: [] };
  }
  if (!category.members.includes(id))
    ops.push({ kind: 'add-member', groupRef: libraryCategoryRef(library, category.category_id), nodeRef: libraryMemberRef(library, id), memberId: memberIdOf(library, id), placement: { at: 'start' } });
  return ops;
}

/** The ops that take one kept thing out of every category. */
export function libraryRemoveOps(graph: GroupGraph, library: KeptLibrary, id: string): GroupMutationOp[] {
  return libraryCategories(graph, library)
    .filter((category) => category.members.includes(id))
    .map((category) => ({ kind: 'remove-member', groupRef: libraryCategoryRef(library, category.category_id), memberId: memberIdOf(library, id) }));
}
