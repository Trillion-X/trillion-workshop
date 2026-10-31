// tools/form-groups-and-matches/do-work/regroup-a-tree.mjs
//
// tool:regroup-a-tree. One request, two operations over a tree given as flat records (read-data/tree-to-groups.mjs):
//
//   { operation: "nest-by-intent", records, intent: { nest: [{ parent_title, child_titles }], scope?, materialize_missing_parents? },
//     new_parent_ids?: { "<parent title>": "<id>" } }
//   { operation: "tree-to-groups", records, family }
//
// A parent the intent makes takes its id from new_parent_ids when given, so the same request gives the same answer;
// otherwise a fresh random id.
import { randomUUID } from 'node:crypto';
import { nestByIntent, treeToGroups } from '../read-data/tree-to-groups.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function recordsOf(input) {
  const records = input.records;
  const ok = Array.isArray(records) && records.every(record => object(record) && typeof record.node_id === 'string'
    && (record.parent_id === null || typeof record.parent_id === 'string'));
  if (!ok) throw new Error('records must be a list of { node_id, parent_id (text or null), ordinal, role, title, external_identity, attributes }.');
  return records.map(record => ({ attributes: {}, title: '', ordinal: null, role: null, external_identity: null, ...record }));
}

export function regroupATree(input) {
  if (!object(input)) throw new Error('Send { operation, records, ... }.');
  if (input.operation === 'tree-to-groups') {
    if (typeof input.family !== 'string' || !input.family) throw new Error('tree-to-groups needs family: the address family of every node of this tree.');
    const { graph, unplaced, groupCount, memberCount } = treeToGroups(recordsOf(input), input.family);
    return { groups: Object.values(graph.groups), unplaced, group_count: groupCount, member_count: memberCount };
  }
  if (input.operation === 'nest-by-intent') {
    const intent = input.intent;
    if (!object(intent) || !Array.isArray(intent.nest) || !intent.nest.every(row => object(row) && typeof row.parent_title === 'string' && Array.isArray(row.child_titles))) {
      throw new Error('nest-by-intent needs intent: { nest: [{ parent_title, child_titles: [titles] }], scope?, materialize_missing_parents? }.');
    }
    const named = object(input.new_parent_ids) ? input.new_parent_ids : {};
    const mint = title => (typeof named[title] === 'string' && named[title] ? named[title] : randomUUID());
    return nestByIntent(recordsOf(input), intent, mint);
  }
  throw new Error('operation must be nest-by-intent or tree-to-groups.');
}
