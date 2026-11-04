// parts/group/do-work/kept-library-writes.ts
//
// The kept-library ops (read-data/kept-library.ts) as record writes: the group graph read from a person's records
// (every `package::group::group::` record), and the writes that take it from before to after a list of group ops, in
// the `{ address_label, payload }` shape a person store writes. Used by every store-side owner of a kept library
// (src/tours.mjs, src/layouts.mjs). Pure.

import type { GroupGraph } from '../../ui/show/group/group-graph';
import { foldGroupRecords } from '../read-data/group-eeaf';
import type { LibraryOp } from '../read-data/kept-library';
import { buildGroupWriteBatch } from './group-mutation-writes';
import { applyGroupOp } from './group-op-transitions';

const GROUP_RECORD = 'package::group::group::';

/** The group graph kept in a person's records ({ address label: value }). */
export function groupGraphOfRecords(current: Readonly<Record<string, unknown>>): GroupGraph {
  return foldGroupRecords(Object.entries(current)
    .filter(([label]) => label.startsWith(GROUP_RECORD))
    .map(([address, value]) => ({ address, value_json: value })) as Parameters<typeof foldGroupRecords>[0]);
}

/** The record writes that apply `ops` to `before`; none when the ops change nothing. */
export function groupWritesFor(before: GroupGraph, ops: readonly LibraryOp[]): { address_label: string; payload: unknown }[] {
  if (!ops.length) return [];
  const after = ops.reduce((graph, op) => applyGroupOp(graph, op as Parameters<typeof applyGroupOp>[1]), before);
  return buildGroupWriteBatch(before, after).payload.writes.map((write) => ({ address_label: write.address_label, payload: write.payload }));
}
