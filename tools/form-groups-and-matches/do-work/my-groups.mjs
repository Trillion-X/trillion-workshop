// tools/form-groups-and-matches/do-work/my-groups.mjs
//
// tool:read-my-groups and tool:change-my-groups: the person's groups kept as `group` records. The caller's AI reads the
// group records it needs from its own store and hands them in as `records` ([{ id, type, value }]); neither command reads
// or writes a store. A read starts at the groups the caller names and follows every member that is itself a group, so the
// answer holds those groups and everything inside them. A change folds the records it was handed into a graph, applies its
// operations (read-data/group-changes.mjs) and, when given, a tree (read-data/tree-to-groups.mjs), and answers `keep`: the
// group records that changed ({ id, type, value, expected }: value null removes one, expected is the record as it was handed
// in, null for a new one) for the AI to put in the store. A store refuses a keep whose expected record has moved.
import { groupKey, isAddressRef } from '../read-data/group-graph.mjs';
import { changeRoots, applyGroupChange } from '../read-data/group-changes.mjs';
import { foldGroupRecords, GROUP_RECORD_TYPE, groupRecordId, groupRecordWrites } from '../read-data/group-records.mjs';
import { treeToGroups } from '../read-data/tree-to-groups.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// The group records handed in (none when left out), each checked to be { id, type, value }, held by id: a later record
// with a null value removes an earlier one, as it would in a store.
function heldOf(input) {
  const records = input?.records ?? [];
  if (!Array.isArray(records) || !records.every(record => object(record) && typeof record.id === 'string' && typeof record.type === 'string')) {
    throw new Error('records must be the group records read from the person\'s records, each { id, type, value }.');
  }
  const held = new Map();
  for (const record of records) {
    if (record.type !== GROUP_RECORD_TYPE) continue;
    if (record.value === null || record.value === undefined) held.delete(record.id);
    else held.set(record.id, record.value);
  }
  return held;
}

/** Every group reachable from `roots`, looked up record by record in what was handed in, folded into a graph. */
function loadGroups(held, roots) {
  const records = [];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const ref = queue.shift();
    const key = groupKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const id = groupRecordId(ref);
    if (!held.has(id)) continue;
    const value = held.get(id);
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

export async function readMyGroups(input) {
  const roots = addressList(input?.roots, 'roots');
  const { graph, skipped } = loadGroups(heldOf(input), roots);
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

export async function changeMyGroups(input) {
  const changes = input?.changes ?? [];
  if (!Array.isArray(changes)) throw new Error('changes must be a list of group changes.');
  const tree = treeOf(input ?? {});
  if (changes.length === 0 && !tree) throw new Error('Give changes, a tree, or both.');
  const held = heldOf(input);
  const treeRoots = tree
    ? tree.records.flatMap(record => [record.role === 'group' ? record.node_id : null, record.parent_id])
      .filter(id => typeof id === 'string').map(id => ({ family: tree.family, parts: { node_id: id } }))
    : [];
  const { graph: before } = loadGroups(held, [...changes.flatMap(changeRoots), ...treeRoots]);
  let after = changes.reduce((graph, op) => applyGroupChange(graph, op), before);
  let unplaced = [];
  if (tree) ({ graph: after, unplaced } = treeToGroups(tree.records, tree.family, after));
  const writes = groupRecordWrites(before, after);
  const keep = writes.map(write => ({
    ...write,
    expected: held.has(write.id) ? { type: GROUP_RECORD_TYPE, value: held.get(write.id) } : null,
  }));
  return {
    groups: Object.values(after.groups),
    removed: writes.filter(write => write.value === null).map(write => write.id),
    written: writes.length,
    unplaced,
    keep,
  };
}
