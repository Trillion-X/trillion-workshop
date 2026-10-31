// tools/form-groups-and-matches/read-data/group-records.mjs
//
// How groups are kept in a person's records: one record of type `group` per group, its value the group itself
// ({ groupRef, memberOrder, members }). The record id comes from the group's address alone, so the same group always
// lands on the same record:
//
//   group:<family>:<name>=<text>&<name>=<text>     every piece percent-encoded, parts in name order
//
// Reading folds records into a graph and drops any record whose id is not its own group's id (a record cannot speak
// for another group). Writing compares two graphs and gives only the records that changed: a changed or new group is
// written, a group that is gone is removed (value null), and an unchanged group is not written at all.
import { groupKey, isGroup } from './group-graph.mjs';

export const GROUP_RECORD_TYPE = 'group';

/** The record id of a group address. */
export function groupRecordId(ref) {
  const parts = Object.keys(ref.parts).sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(ref.parts[name])}`);
  return `group:${encodeURIComponent(ref.family)}:${parts.join('&')}`;
}

/** Records in, graph out: records in the order they were kept, malformed or misplaced ones left out and named. */
export function foldGroupRecords(records) {
  const byId = new Map();
  const skipped = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== 'object') continue;
    const value = record.value;
    // A removed record (value null) removes what an earlier record of the same id said.
    if (value === null || value === undefined) {
      byId.delete(record.id);
      continue;
    }
    if (!isGroup(value) || groupRecordId(value.groupRef) !== record.id) {
      skipped.push(String(record.id));
      continue;
    }
    byId.set(record.id, { groupRef: value.groupRef, memberOrder: value.memberOrder, members: value.members });
  }
  const groups = Object.fromEntries([...byId.values()].map(group => [groupKey(group.groupRef), group]));
  const sorted = {};
  for (const key of Object.keys(groups).sort()) sorted[key] = groups[key];
  return { graph: { groups: sorted }, skipped };
}

function sameGroup(a, b) {
  return a.memberOrder.length === b.memberOrder.length
    && a.memberOrder.every((id, i) => id === b.memberOrder[i])
    && JSON.stringify(a.members) === JSON.stringify(b.members);
}

/** The records to write so that what is kept matches `after`: { id, type, value } with value null for a removed group. */
export function groupRecordWrites(before, after) {
  const writes = [];
  for (const [key, group] of Object.entries(after.groups)) {
    const prev = Object.hasOwn(before.groups, key) ? before.groups[key] : null;
    if (prev === group || (prev && sameGroup(prev, group))) continue;
    writes.push({ id: groupRecordId(group.groupRef), type: GROUP_RECORD_TYPE, value: group });
  }
  for (const [key, group] of Object.entries(before.groups)) {
    if (!Object.hasOwn(after.groups, key)) writes.push({ id: groupRecordId(group.groupRef), type: GROUP_RECORD_TYPE, value: null });
  }
  return writes;
}
