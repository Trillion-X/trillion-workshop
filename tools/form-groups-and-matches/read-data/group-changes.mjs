// tools/form-groups-and-matches/read-data/group-changes.mjs
//
// A change to groups is a list of operations, each one a plain object that names what to do and to what:
//
//   { kind: "add-member", groupRef, nodeRef, memberId, role?, presentation?, placement? }
//   { kind: "remove-member" | "reorder-member" | "move-member" | "set-member-fields" | "patch-member-presentation"
//          | "group-members" | "ungroup-members" | "ensure-group" | "delete-group", ... }
//
// Each kind maps to one function of group-graph.mjs; this file only hands the operation's fields to it. The
// operations of one change apply in order to one graph, and an unknown kind or a broken rule refuses the whole change.
import {
  addMember, ensureGroup, groupKey, groupMembers, hasGroup, isAddressRef, moveMember, patchMemberPresentation,
  removeMember, reorderMember, setMemberFields, ungroupMembers,
} from './group-graph.mjs';

function required(op, field) {
  const value = op[field];
  if (value === undefined || value === null) throw new Error(`group change '${op.kind}' needs '${field}'.`);
  return value;
}

// The optional fields an operation passes on only when it has them.
const given = (op, fields) => Object.fromEntries(fields.filter(field => op[field] != null).map(field => [field, op[field]]));

/** What each kind of operation does: graph and operation in, the next graph out. */
export const CHANGES = Object.freeze({
  'ensure-group': (g, op) => ensureGroup(g, op.groupRef),
  'add-member': (g, op) => addMember(g, op.groupRef, required(op, 'nodeRef'), {
    memberId: required(op, 'memberId'), ...given(op, ['role', 'presentation', 'placement']),
  }),
  'remove-member': (g, op) => removeMember(g, op.groupRef, required(op, 'memberId')),
  'reorder-member': (g, op) => reorderMember(g, op.groupRef, required(op, 'memberId'), required(op, 'placement')),
  'move-member': (g, op) => moveMember(g, required(op, 'memberId'), {
    fromGroupRef: op.groupRef, toGroupRef: required(op, 'toGroupRef'), ...given(op, ['placement']),
  }),
  'set-member-fields': (g, op) => setMemberFields(g, op.groupRef, required(op, 'memberId'), {
    role: op.role, presentation: op.presentation,
  }),
  'patch-member-presentation': (g, op) => patchMemberPresentation(g, op.groupRef, required(op, 'memberId'), required(op, 'presentation')),
  'group-members': (g, op) => groupMembers(g, op.groupRef, required(op, 'memberIds'), required(op, 'toGroupRef'), {
    wrapperMemberId: required(op, 'wrapperMemberId'), ...given(op, ['role', 'presentation']),
  }),
  'ungroup-members': (g, op) => ungroupMembers(g, op.groupRef, required(op, 'wrapperMemberId')),
  // The group leaves the graph; the change that stores the graph then removes its record.
  'delete-group': (g, op) => {
    if (!hasGroup(g, op.groupRef)) return g;
    const groups = { ...g.groups };
    delete groups[groupKey(op.groupRef)];
    return { groups };
  },
});

/** One operation applied to a graph. Refuses an unknown kind and any broken rule (a cycle, a repeated member id). */
export function applyGroupChange(graph, op, changes = CHANGES) {
  const kind = op?.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(changes, kind)) {
    throw new Error(`unknown group change '${kind}'; the kinds are ${Object.keys(changes).join(', ')}.`);
  }
  if (!isAddressRef(op.groupRef)) throw new Error(`group change '${kind}' needs groupRef as { family, parts }.`);
  return changes[kind](graph, op);
}

/** Every group address an operation touches, so a caller reads those groups (and what they hold) before applying it. */
export function changeRoots(op) {
  return [op.groupRef, op.nodeRef, op.toGroupRef].filter(isAddressRef);
}
