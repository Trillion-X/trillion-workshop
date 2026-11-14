// tools/space-members/read-data/member-types.mjs
//
// The kinds of member a space has: the types its label starts with and the type a joiner gets (DATA, tools/space-member-
// types), the space's own types and roles kept on its row (`config.own_types`, `config.roles`), and what each type
// inherits. A member's type is the `member_type` of their member row. Pure: no door, no clock.
//
// A type that inherits a type the space does not have, or a chain that loops, is refused outright, never read as a type
// with fewer permissions: an ambiguous graph must not grant.
import memberTypes from '../../space-member-types/src/space-member-types.json' with { type: 'json' };

export const LIMITS = memberTypes.own_types;

/** What the space's label starts with, or the default profile for a label the DATA does not name. */
export const setupOf = label => memberTypes.labels[label] ?? memberTypes.default;

/** The type a person gets when they join: the space's own choice (`config.joins_as`), else its label's. */
export const joinsAs = space => space.config?.joins_as ?? setupOf(space.label).joins_as;

/** A type id written before types existed, read as the type it is now. */
export const currentTypeId = (space, typeId) => setupOf(space.label).earlier_roles?.[typeId] ?? typeId;

/** The member types in the order they are offered: the label's, then the space's own, then configured roles. */
export function memberTypesOf(space) {
  const types = [
    ...setupOf(space.label).types.map(type => ({ ...type, own: false })),
    ...(space.config?.own_types ?? []).map(type => ({ ...type, own: true })),
  ];
  for (const [id, role] of Object.entries(space.config?.roles ?? {})) {
    const at = types.findIndex(type => type.id === id);
    const row = { id, label: role.label ?? id, inherits: role.inherits ?? [], may: role.may ?? [], source: 'roles', own: at >= 0 && types[at].own };
    if (at < 0) types.push(row);
    else types[at] = { ...types[at], ...row };
  }
  for (const type of types) inheritedMemberTypes(types, type.id);
  return types;
}

/** The named type and every type it inherits, parent first, once each; a missing parent or a cycle is an error. */
export function inheritedMemberTypes(types, held) {
  const byId = new Map(types.map(type => [type.id, type]));
  const active = new Set();
  const included = new Set();
  const result = [];
  const visit = id => {
    if (!byId.has(id)) throw new Error(`Member type ${id} inherits a type that is not in this space.`);
    if (active.has(id)) throw new Error(`Member type inheritance contains a cycle at ${id}.`);
    if (included.has(id)) return;
    active.add(id);
    for (const parent of byId.get(id).inherits ?? []) visit(parent);
    active.delete(id);
    included.add(id);
    result.push(id);
  };
  for (const id of Array.isArray(held) ? held : [held]) if (id) visit(id);
  return result;
}

/**
 * The effective type ids of a member, inheritance included. A role stored on a member that the space no longer declares
 * stays an exact leaf until a host maps it to a declared type.
 */
export function memberTypeIdsOf(space, typeId, types = memberTypesOf(space)) {
  const known = types.some(type => type.id === typeId) || !typeId ? types : [...types, { id: typeId, label: typeId, inherits: [] }];
  return inheritedMemberTypes(known, typeId);
}
