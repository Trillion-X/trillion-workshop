// tools/form-groups-and-matches/read-data/group-graph.mjs
//
// The membership graph of groups. A group holds ordered members, and each member is an address of anything: a record,
// a page, a person, or another group. A member whose address is a group's own address nests that group, so groups
// inside groups need no special case. Every function is pure and returns a new graph; groups that did not change are
// the same objects as before, so a caller can tell what changed by comparing them.
//
// The one rule that is never data: a group can never contain itself, directly or through other groups.
//
//   address  { family: "<any word>", parts: { "<name>": "<text>", ... } }
//   graph    { groups: { "<group key>": { groupRef, memberOrder: [memberId], members: { memberId: member } } } }
//   member   { memberId, nodeRef, role?, presentation? }   role and presentation are the caller's own words, never read
//
// The order of a group is the order of memberOrder. Member ids are always the caller's: nothing here invents one.

export class GroupGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GroupGraphError';
  }
}

/** The same address always gives the same key: the family and the parts sorted by name. */
export function groupKey(ref) {
  const parts = ref?.parts ?? {};
  const sorted = {};
  for (const key of Object.keys(parts).sort()) sorted[key] = parts[key];
  return JSON.stringify({ family: ref?.family, parts: sorted });
}

export function emptyGraph() {
  return { groups: {} };
}

export function getGroup(graph, groupRef) {
  return graph.groups[groupKey(groupRef)] ?? null;
}

export function hasGroup(graph, groupRef) {
  return Object.hasOwn(graph.groups, groupKey(groupRef));
}

/** The members of a group in order; none when the group is absent. */
export function membersOf(graph, groupRef) {
  const group = getGroup(graph, groupRef);
  if (!group) return [];
  return group.memberOrder.map(id => group.members[id]).filter(Boolean);
}

export function memberById(graph, groupRef, memberId) {
  const group = getGroup(graph, groupRef);
  return group && Object.hasOwn(group.members, memberId) ? group.members[memberId] : null;
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Where a placement puts a member: { index }, { before: id }, { after: id }, { at: "start" | "end" }; none is the end.
function resolveIndex(order, placement) {
  if (!placement || placement.at === 'end') return order.length;
  if ('at' in placement) return placement.at === 'start' ? 0 : order.length;
  if ('index' in placement) return clamp(placement.index, 0, order.length);
  if ('before' in placement) {
    const i = order.indexOf(placement.before);
    return i < 0 ? order.length : i;
  }
  const i = order.indexOf(placement.after);
  return i < 0 ? order.length : i + 1;
}

function withGroup(graph, group) {
  return { groups: { ...graph.groups, [groupKey(group.groupRef)]: group } };
}

function withoutGroup(graph, groupRef) {
  const groups = { ...graph.groups };
  delete groups[groupKey(groupRef)];
  return { groups };
}

// Members keep only the fields they have, so a stored member never carries an empty field.
function pruneUndefined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

const has = (group, memberId) => Object.hasOwn(group.members, memberId);

/** Remove a group whose members were moved out or kept elsewhere. */
export function removeGroup(graph, groupRef) {
  return withoutGroup(graph, groupRef);
}

/** Does `candidate` contain `target` at any depth, or is it `target`? */
export function reaches(graph, candidate, target) {
  const targetKey = groupKey(target);
  const seen = new Set();
  const stack = [groupKey(candidate)];
  while (stack.length) {
    const key = stack.pop();
    if (key === targetKey) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    const group = Object.hasOwn(graph.groups, key) ? graph.groups[key] : null;
    if (!group) continue;
    for (const id of group.memberOrder) if (has(group, id)) stack.push(groupKey(group.members[id].nodeRef));
  }
  return false;
}

/** The group, made empty when it is not there yet. */
export function ensureGroup(graph, groupRef) {
  if (hasGroup(graph, groupRef)) return graph;
  return withGroup(graph, { groupRef, memberOrder: [], members: {} });
}

/** Add `nodeRef` to `groupRef` at `placement` (the end when none). Makes the group if needed. */
export function addMember(graph, groupRef, nodeRef, { memberId, role, presentation, placement } = {}) {
  if (reaches(graph, nodeRef, groupRef)) {
    throw new GroupGraphError(`cycle: ${groupKey(nodeRef)} already contains (or is) ${groupKey(groupRef)}`);
  }
  const base = getGroup(graph, groupRef) ?? { groupRef, memberOrder: [], members: {} };
  if (has(base, memberId)) throw new GroupGraphError(`duplicate memberId ${memberId} in group ${groupKey(groupRef)}`);
  const member = pruneUndefined({ memberId, nodeRef, role, presentation });
  const at = resolveIndex(base.memberOrder, placement);
  const memberOrder = [...base.memberOrder.slice(0, at), memberId, ...base.memberOrder.slice(at)];
  return withGroup(graph, { groupRef, memberOrder, members: { ...base.members, [memberId]: member } });
}

/** Take a member out of a group; the group stays. Nothing changes when the member is not there. */
export function removeMember(graph, groupRef, memberId) {
  const group = getGroup(graph, groupRef);
  if (!group || !has(group, memberId)) return graph;
  const members = { ...group.members };
  delete members[memberId];
  return withGroup(graph, { groupRef, memberOrder: group.memberOrder.filter(id => id !== memberId), members });
}

/** Move a member to another place in its own group. */
export function reorderMember(graph, groupRef, memberId, placement) {
  const group = getGroup(graph, groupRef);
  if (!group || !has(group, memberId)) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(groupRef)}`);
  const without = group.memberOrder.filter(id => id !== memberId);
  const at = resolveIndex(without, placement);
  return withGroup(graph, { ...group, memberOrder: [...without.slice(0, at), memberId, ...without.slice(at)] });
}

/** Move a member from one group to another, keeping its id, address, role and presentation. */
export function moveMember(graph, memberId, { fromGroupRef, toGroupRef, placement }) {
  if (groupKey(fromGroupRef) === groupKey(toGroupRef)) {
    return reorderMember(graph, fromGroupRef, memberId, placement ?? { at: 'end' });
  }
  const member = memberById(graph, fromGroupRef, memberId);
  if (!member) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(fromGroupRef)}`);
  return addMember(removeMember(graph, fromGroupRef, memberId), toGroupRef, member.nodeRef, {
    memberId, role: member.role, presentation: member.presentation, placement,
  });
}

/** Set a member's role or presentation; null clears the field. */
export function setMemberFields(graph, groupRef, memberId, fields) {
  const group = getGroup(graph, groupRef);
  const current = group && has(group, memberId) ? group.members[memberId] : null;
  if (!current) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(groupRef)}`);
  const next = pruneUndefined({
    memberId: current.memberId,
    nodeRef: current.nodeRef,
    role: fields.role === null ? undefined : fields.role ?? current.role,
    presentation: fields.presentation === null ? undefined : fields.presentation ?? current.presentation,
  });
  return withGroup(graph, { ...group, members: { ...group.members, [memberId]: next } });
}

/** Merge named presentation fields into the member's current presentation in the same change. */
export function patchMemberPresentation(graph, groupRef, memberId, patch) {
  const current = memberById(graph, groupRef, memberId);
  if (!current) throw new GroupGraphError(`no member ${memberId} in group ${groupKey(groupRef)}`);
  return setMemberFields(graph, groupRef, memberId, { presentation: { ...current.presentation, ...patch } });
}

/** Put selected members of a group into a new group, which takes the place of the first one selected. */
export function groupMembers(graph, parentGroupRef, memberIds, newGroupRef, { wrapperMemberId, role, presentation }) {
  const parent = getGroup(graph, parentGroupRef);
  if (!parent) throw new GroupGraphError(`no group ${groupKey(parentGroupRef)}`);
  const selected = memberIds.filter(id => has(parent, id));
  if (selected.length === 0) throw new GroupGraphError('groupMembers: no selected members exist');
  if (reaches(graph, newGroupRef, parentGroupRef) || hasGroup(graph, newGroupRef)) {
    throw new GroupGraphError(`newGroupRef ${groupKey(newGroupRef)} already exists or would cycle`);
  }
  const insertAt = parent.memberOrder.findIndex(id => selected.includes(id));
  const orderedSelected = parent.memberOrder.filter(id => selected.includes(id));
  const subMembers = {};
  for (const id of orderedSelected) subMembers[id] = parent.members[id];
  const remainingMembers = { ...parent.members };
  for (const id of selected) delete remainingMembers[id];
  remainingMembers[wrapperMemberId] = pruneUndefined({ memberId: wrapperMemberId, nodeRef: newGroupRef, role, presentation });
  const remainingOrder = parent.memberOrder.filter(id => !selected.includes(id));
  const at = clamp(insertAt, 0, remainingOrder.length);
  const parentOrder = [...remainingOrder.slice(0, at), wrapperMemberId, ...remainingOrder.slice(at)];
  const next = withGroup(graph, { groupRef: parentGroupRef, memberOrder: parentOrder, members: remainingMembers });
  return withGroup(next, { groupRef: newGroupRef, memberOrder: orderedSelected, members: subMembers });
}

/** Undo groupMembers: the inner group's members go back where its member stood, and the inner group goes away. */
export function ungroupMembers(graph, parentGroupRef, wrapperMemberId) {
  const parent = getGroup(graph, parentGroupRef);
  const wrapper = parent && has(parent, wrapperMemberId) ? parent.members[wrapperMemberId] : null;
  if (!wrapper) throw new GroupGraphError(`no member ${wrapperMemberId} in ${groupKey(parentGroupRef)}`);
  const subGroup = getGroup(graph, wrapper.nodeRef);
  if (!subGroup) throw new GroupGraphError(`member ${wrapperMemberId} does not address a group`);
  const at = parent.memberOrder.indexOf(wrapperMemberId);
  const members = { ...parent.members };
  delete members[wrapperMemberId];
  for (const id of subGroup.memberOrder) members[id] = subGroup.members[id];
  const memberOrder = [...parent.memberOrder.slice(0, at), ...subGroup.memberOrder, ...parent.memberOrder.slice(at + 1)];
  return withoutGroup(withGroup(graph, { groupRef: parentGroupRef, memberOrder, members }), wrapper.nodeRef);
}

const isObject = value => value !== null && typeof value === 'object';

export function isAddressRef(value) {
  return isObject(value) && typeof value.family === 'string' && isObject(value.parts) && !Array.isArray(value.parts)
    && Object.values(value.parts).every(part => typeof part === 'string');
}

function isMember(value) {
  return isObject(value) && typeof value.memberId === 'string' && isAddressRef(value.nodeRef);
}

export function isGroup(value) {
  return isObject(value) && isAddressRef(value.groupRef)
    && Array.isArray(value.memberOrder) && value.memberOrder.every(id => typeof id === 'string')
    && isObject(value.members) && Object.values(value.members).every(isMember);
}

/** True when `value` is a well-formed graph. */
export function isGroupGraph(value) {
  return isObject(value) && isObject(value.groups) && Object.values(value.groups).every(isGroup);
}
