// tools/form-groups-and-matches/read-data/tree-to-groups.mjs
//
// A tree from anywhere (folders, a bookmark list, an outline) arrives as flat records, one per node:
//
//   { node_id, parent_id | null, ordinal | null, role | null, title, external_identity | null, attributes: {} }
//
// A node whose role is "group" holds other nodes; every other role is carried as it is and never read. Two jobs:
//
// - treeToGroups: the tree becomes a group graph. Each node's own id is its member id and its address
//   { family, parts: { node_id } }, so regrouping later does not change any identity. Members are placed parents first,
//   then by ordinal. A node the graph refuses (a cycle, a repeated id) or a node with no parent is listed with why,
//   never dropped.
// - nestByIntent: a person says in their own words which groups belong under which ("put 'Bread' and 'Cakes' under
//   'Baking'"). Titles are matched without case or outer spaces. Two nodes with one title is a refusal for that row,
//   not a guess; a missing parent is made only when the intent says so; only the named nodes move; a row that would
//   put a group inside itself is refused. Every other row still applies.
import { addMember, emptyGraph, ensureGroup, GroupGraphError } from './group-graph.mjs';

const CONTAINING_ROLE = 'group';

const refFor = (family, nodeId) => ({ family, parts: { node_id: nodeId } });

// The human and source facts of a node, carried as the member's presentation.
function presentationFor(record) {
  const presentation = { ...record.attributes };
  if (record.title) presentation.title = record.title;
  if (record.external_identity) presentation.external_identity = record.external_identity;
  return Object.keys(presentation).length > 0 ? presentation : undefined;
}

function depthIn(parentOf, nodeId) {
  let depth = 0;
  let cursor = parentOf.get(nodeId) ?? null;
  const seen = new Set([nodeId]);
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    depth += 1;
    cursor = parentOf.get(cursor) ?? null;
  }
  return depth;
}

/** The tree's records as groups, on top of `base` when given. */
export function treeToGroups(records, family, base = emptyGraph()) {
  const unplaced = [];
  let graph = base;
  for (const record of records) if (record.role === CONTAINING_ROLE) graph = ensureGroup(graph, refFor(family, record.node_id));

  const parentOf = new Map(records.map(record => [record.node_id, record.parent_id]));
  const placeable = records
    .filter(record => record.parent_id !== null)
    .map(record => ({ record, depth: depthIn(parentOf, record.node_id) }))
    .sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      const leftOrdinal = left.record.ordinal ?? Number.MAX_SAFE_INTEGER;
      const rightOrdinal = right.record.ordinal ?? Number.MAX_SAFE_INTEGER;
      if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
      return left.record.node_id < right.record.node_id ? -1 : 1;
    });

  for (const { record } of placeable) {
    try {
      graph = addMember(graph, refFor(family, record.parent_id), refFor(family, record.node_id), {
        memberId: record.node_id,
        role: record.role ?? undefined,
        presentation: presentationFor(record),
      });
    } catch (error) {
      if (!(error instanceof GroupGraphError)) throw error;
      unplaced.push({ node_id: record.node_id, reason: /cycle/.test(error.message) ? 'cycle' : 'duplicate_member', detail: error.message });
    }
  }
  for (const record of records) {
    if (record.parent_id === null) unplaced.push({ node_id: record.node_id, reason: 'no_parent', detail: 'record has no parent, so it is a root or an orphan of this tree' });
  }
  const groupCount = Object.keys(graph.groups).length;
  const memberCount = Object.values(graph.groups).reduce((total, group) => total + group.memberOrder.length, 0);
  return { graph, unplaced, groupCount, memberCount };
}

const normalize = title => title.trim().toLowerCase();

function rootOf(nodeId, byId) {
  let cursor = nodeId;
  const seen = new Set([nodeId]);
  let parent = byId.get(cursor)?.parent_id ?? null;
  while (parent !== null && byId.has(parent) && !seen.has(parent)) {
    seen.add(parent);
    cursor = parent;
    parent = byId.get(cursor)?.parent_id ?? null;
  }
  return cursor;
}

// Would putting childId under parentId close a loop, counting the moves the intent already asks for?
function createsCycle(childId, parentId, byId, desiredParent) {
  let cursor = parentId;
  const seen = new Set();
  while (cursor !== null && cursor !== undefined && !seen.has(cursor)) {
    if (cursor === childId) return true;
    seen.add(cursor);
    cursor = desiredParent.get(cursor) ?? byId.get(cursor)?.parent_id ?? null;
  }
  return false;
}

/**
 * The tree after the intent: { records, moved, created, refusals, untouched }. `mintIdentity(title)` gives the id of a
 * parent the intent makes; it is the caller's, so the same call can always give the same answer.
 */
export function nestByIntent(records, intent, mintIdentity) {
  const byId = new Map(records.map(record => [record.node_id, record]));
  const parentOf = new Map(records.map(record => [record.node_id, record.parent_id]));
  const refusals = [];
  const byTitle = new Map();
  for (const record of records) {
    const key = normalize(record.title ?? '');
    if (key.length === 0) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(record);
  }
  const scope = intent.scope;
  const inScope = record => {
    if (!scope) return true;
    if (scope.applies_to_role != null && record.role !== scope.applies_to_role) return false;
    if (scope.root_node_id != null && rootOf(record.node_id, byId) !== scope.root_node_id) return false;
    if (scope.depth != null && depthIn(parentOf, record.node_id) !== scope.depth) return false;
    return true;
  };

  const desiredParent = new Map();
  const created = [];
  for (const row of intent.nest) {
    const label = row.parent_title;
    const parentMatches = (byTitle.get(normalize(label)) ?? []).filter(record => record.role === CONTAINING_ROLE);
    let parentId;
    if (parentMatches.length > 1) {
      refusals.push({ row: label, reason: 'parent_title_is_ambiguous', detail: `${parentMatches.length} groups are titled ${JSON.stringify(label)}: ${parentMatches.map(record => record.node_id).join(', ')}` });
      continue;
    }
    if (parentMatches.length === 1) {
      parentId = parentMatches[0].node_id;
    } else {
      const spec = intent.materialize_missing_parents;
      if (!spec) {
        refusals.push({ row: label, reason: 'parent_absent_and_creation_not_declared', detail: `no group is titled ${JSON.stringify(label)} and the intent does not declare materialize_missing_parents` });
        continue;
      }
      parentId = mintIdentity(label);
      created.push({
        node_id: parentId, parent_id: scope?.root_node_id ?? null, ordinal: null, role: CONTAINING_ROLE, title: label,
        external_identity: null, attributes: {}, materialize: { kind: spec.kind },
      });
    }
    for (const childTitle of row.child_titles) {
      const matches = byTitle.get(normalize(childTitle)) ?? [];
      const at = `${label} <- ${childTitle}`;
      if (matches.length === 0) {
        refusals.push({ row: at, reason: 'child_title_not_found', detail: `nothing is titled ${JSON.stringify(childTitle)}` });
        continue;
      }
      const scoped = matches.filter(inScope);
      if (scoped.length === 0) {
        refusals.push({ row: at, reason: 'child_is_not_in_scope', detail: `${matches.length} match(es) exist but none is in the declared scope` });
        continue;
      }
      if (scoped.length > 1) {
        refusals.push({ row: at, reason: 'child_title_is_ambiguous', detail: `${scoped.length} in-scope nodes are titled ${JSON.stringify(childTitle)}: ${scoped.map(record => record.node_id).join(', ')}` });
        continue;
      }
      if (scoped[0].node_id !== parentId) desiredParent.set(scoped[0].node_id, parentId);
    }
  }

  for (const [childId, parentId] of [...desiredParent.entries()]) {
    if (createsCycle(childId, parentId, byId, desiredParent)) {
      refusals.push({ row: childId, reason: 'would_create_a_cycle', detail: `${childId} cannot sit under ${parentId}, which is inside it` });
      desiredParent.delete(childId);
    }
  }
  const usedParents = new Set(desiredParent.values());
  const survivingCreated = created.filter(record => usedParents.has(record.node_id));
  const moved = [];
  const next = records.map(record => {
    const parentId = desiredParent.get(record.node_id);
    if (parentId === undefined || parentId === record.parent_id) return record;
    moved.push(record.node_id);
    return { ...record, parent_id: parentId };
  });
  return {
    records: [...next, ...survivingCreated],
    moved,
    created: survivingCreated.map(record => record.node_id),
    refusals,
    untouched: records.length - moved.length,
  };
}
