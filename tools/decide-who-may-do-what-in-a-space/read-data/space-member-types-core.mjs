// Exact source-first adaptation of src/space-member-types.mjs78–96,136–140,148–185 at b6ae0eb.
// All own types remain in the graph; creation limits never truncate authorization evidence.
import memberTypes from '../../space-member-types/src/space-member-types.json' with { type: 'json' };
import permissions from '../../space-permission-rules/src/space-permission-rules.json' with { type: 'json' };
const setupOf = label => memberTypes.labels[label] ?? memberTypes.default;
export const SPACE_ACTIONS = permissions.actions.filter(action => action.offered_on === 'space').map(action => action.id);
/** The named type and every type it inherits, in parent-first order, once each. */
export function inheritedMemberTypes(types, held) {
  if (!Array.isArray(types) || types.some(type => !type || typeof type.id !== 'string' || !type.id || type.inherits !== undefined && (!Array.isArray(type.inherits) || type.inherits.some(id => typeof id !== 'string' || !id))) || new Set(types.map(type => type.id)).size !== types.length) throw new Error('The member type graph is malformed.');
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

export const spaceMemberTypeMethods = {
  /** The label and pursuit-owned rows before community overlays; validate only once the entire graph is assembled. */
  async baseMemberTypesOf(space) {
    const own = await this.records.ownMemberTypes(space.id);
    if (!Array.isArray(own)) throw new Error('The complete member type graph is unavailable.');
    return [...setupOf(space.label).types.map(type => ({ ...type, own: false })), ...own.map(type => ({ ...type, own: true }))];
  },
  /** A space's member types in the order they are offered: its label's, then its own. */
  async memberTypesOf(space, communityConfigOverride) {
    const types = await this.baseMemberTypesOf(space);
    // Community roles are types under the same rule owner. A role may inherit another role's permissions.
    const config = communityConfigOverride === undefined ? await this.communityConfig(space.id) : communityConfigOverride;
    if (config) {
      const roles = config.roles ?? {};
      for (const [id, role] of Object.entries(roles)) {
        const index = types.findIndex(type => type.id === id);
        const row = { id, label: role.label ?? id, inherits: role.inherits ?? [], may: role.may ?? [], source: 'community', own: index >= 0 && types[index].own };
        if (index < 0) types.push(row);
        else types[index] = { ...types[index], ...row };
      }
    }
    // Malformed/cyclic stored inheritance fails closed instead of granting ambiguous access.
    for (const type of types) inheritedMemberTypes(types, type.id);
    return types;
  },

  /** Effective member type ids, including every inherited parent, for the common permission evaluator. */
  async memberTypeIdsOf(space, typeId, override) {
    const types = override ?? await this.memberTypesOf(space);
    // A legacy role already stored on a member stays an exact leaf until an owner maps it to a declared type.
    if (typeId && !types.some(type => type.id === typeId)) types.push({ id: typeId, label: typeId, inherits: [] });
    return inheritedMemberTypes(types, typeId);
  },

  // Which of `ids` the person may do in the space, to `thing` when named; asked of the space's own rules.
  async mayIn(space, relay, ids, thing) {
    const decided = await Promise.all(ids.map(async id => [id, (await this.decideInSpace(space, relay, id, thing)).allowed]));
    return Object.fromEntries(decided);
  },

  /** What the reader may do in the space itself: the actions offered on the space. */
  async mayInSpace(space, relay) {
    return this.mayIn(space, relay, SPACE_ACTIONS);
  },
};
