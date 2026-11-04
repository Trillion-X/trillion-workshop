// src/kept-libraries.mjs
//
// Purpose
//   The person store's side of a kept library (parts/group/read-data/kept-library.ts): reads a library's categories,
//   Recent and one thing's category straight from the person's workspace records, and turns filing or unfiling one
//   kept thing into the group part's own record writes. Tours (src/tours.mjs) and layouts (src/layouts.mjs) each hold
//   one of these over their own DATA row; a new kind of kept thing is one more row, with no code here.
//
// Non-negotiable invariants
//   1. Blind: the library row says every family and prefix; nothing here names tours, layouts or any other kind.
//   2. The group records are the group part's own (`package::group::group::…`), written through applyGroupOp and
//      buildGroupWriteBatch, so the page reads them back with group.load-graph exactly as the store wrote them.
//   3. Pure over `current` (the person's records as { label: value }): a read never writes, a write is returned, never
//      sent; the caller writes it with its own records in one batch.
//

import { applyGroupOp } from '../../organize-the-sidebar/do-work/group-op-transitions.ts';
import { buildGroupWriteBatch } from '../../organize-the-sidebar/do-work/group-mutation-writes.ts';
import { foldGroupRecords } from '../../organize-the-sidebar/read-data/group-eeaf.ts';
import { libraryCategories, libraryFileOps, libraryRecent, libraryRemoveOps } from '../parts/group/read-data/kept-library.ts';

export const GROUP_RECORD = 'package::group::group::';

/** The group graph the person's records hold. */
export const groupGraphOf = current => foldGroupRecords(Object.entries(current)
  .filter(([label]) => label.startsWith(GROUP_RECORD))
  .map(([address, value]) => ({ address, value_json: value })));

const writesOf = (before, ops) => {
  const after = ops.reduce((graph, op) => applyGroupOp(graph, op), before);
  return buildGroupWriteBatch(before, after).payload.writes.map(write => ({ address_label: write.address_label, payload: write.payload }));
};

/** One kept library over its row (KeptLibrary). */
export function keptLibrary(library) {
  const categories = current => libraryCategories(groupGraphOf(current), library);
  return {
    categories,
    recent: items => libraryRecent(items, library),
    categoryOf: (current, id) => categories(current).find(category => category.members.includes(id))?.name ?? null,
    file: (current, id, name) => {
      const graph = groupGraphOf(current);
      return writesOf(graph, libraryFileOps(graph, library, id, name, () => crypto.randomUUID()));
    },
    unfile: (current, id) => {
      const graph = groupGraphOf(current);
      return writesOf(graph, libraryRemoveOps(graph, library, id));
    },
  };
}
