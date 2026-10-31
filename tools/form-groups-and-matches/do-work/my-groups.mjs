// tools/form-groups-and-matches/do-work/my-groups.mjs
//
// tool:read-my-groups and tool:change-my-groups: the person's groups kept as `group` records, read and changed through
// the run's records door (tools/records-door). A read starts at the groups the caller names and follows every member
// that is itself a group, so the answer holds those groups and everything inside them. A change reads the groups it
// touches, applies its operations (read-data/group-changes.mjs) and, when given, a tree (read-data/tree-to-groups.mjs)
// to that graph, and writes only the records that changed.
import { groupKey, isAddressRef } from '../read-data/group-graph.mjs';
import { changeRoots, applyGroupChange } from '../read-data/group-changes.mjs';
import { foldGroupRecords, GROUP_RECORD_TYPE, groupRecordId, groupRecordWrites } from '../read-data/group-records.mjs';
import { treeToGroups } from '../read-data/tree-to-groups.mjs';

// The door takes at most this many records in one write (the engine's cap when a row declares no most_writes).
const MOST_WRITES = 256;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Every group reachable from `roots`, read record by record. */
async function loadGroups(door, roots) {
  const records = [];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const ref = queue.shift();
    const key = groupKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = groupRecordId(ref);
    const value = await door.read(GROUP_RECORD_TYPE, id);
    if (value === null) continue;
    records.push({ id, value });
    if (!object(value) || !object(value.members) || !Array.isArray(value.memberOrder)) continue;
    for (const memberId of value.memberOrder) {
      const nodeRef = Object.hasOwn(value.members, memberId) ? value.members[memberId]?.nodeRef : null;
      if (isAddressRef(nodeRef)) queue.push(nodeRef);
    }
  }
  return foldGroupRecords(records);
}

function addressList(value, field) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isAddressRef)) {
    throw new Error(`${field} must be a list of group addresses, each { family, parts: { name: text } }.`);
  }
  return value;
}

export async function readMyGroups(input, { door }) {
  const roots = addressList(input?.roots, 'roots');
  const { graph, skipped } = await loadGroups(door, roots);
  const groups = Object.values(graph.groups);
  return { groups, count: groups.length, skipped };
}

function treeOf(input) {
  const tree = input.tree;
  if (tree === undefined) return null;
  if (!object(tree) || typeof tree.family !== 'string' || !tree.family || !Array.isArray(tree.records)) {
    throw new Error('tree must be { family, records: [{ node_id, parent_id, ordinal, role, title, external_identity, attributes }] }.');
  }
  return tree;
}

export async function changeMyGroups(input, { door }) {
  const changes = input?.changes ?? [];
  if (!Array.isArray(changes)) throw new Error('changes must be a list of group changes.');
  const tree = treeOf(input ?? {});
  if (changes.length === 0 && !tree) throw new Error('Give changes, a tree, or both.');
  const treeRoots = tree
    ? tree.records.flatMap(record => [record.role === 'group' ? record.node_id : null, record.parent_id])
      .filter(id => typeof id === 'string').map(id => ({ family: tree.family, parts: { node_id: id } }))
    : [];
  const { graph: before } = await loadGroups(door, [...changes.flatMap(changeRoots), ...treeRoots]);
  let after = changes.reduce((graph, op) => applyGroupChange(graph, op), before);
  let unplaced = [];
  if (tree) ({ graph: after, unplaced } = treeToGroups(tree.records, tree.family, after));
  const writes = groupRecordWrites(before, after);
  for (let at = 0; at < writes.length; at += MOST_WRITES) await door.write(writes.slice(at, at + MOST_WRITES));
  return {
    groups: Object.values(after.groups),
    removed: writes.filter(write => write.value === null).map(write => write.id),
    written: writes.length,
    unplaced,
  };
}
