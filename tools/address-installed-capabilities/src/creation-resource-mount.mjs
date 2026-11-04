// Compose creation behavior into existing hosts from callable supplies. The
// mount selects no storage vendor, tool product, renderer kind or file backend.
import { makeCreationResourceOwner } from './creation-resource-owner.mjs';

// Dependency roles are installed DATA, including the current native supplies.
const validRole = role => typeof role === 'string' && role.length > 0;

/**
 * Each role is an independently installed address resolver. A resolver returns
 * executable behavior, not a provider descriptor. A host can add or replace
 * supplies without changing this mount or introducing a kind-specific CRUD API.
 */
export function makeCreationResourceMount({ resource, store, authority, placement, policy, supplies, now } = {}) {
  const roles = Object.keys(supplies ?? {});
  if (!roles.length || roles.some(role => !validRole(role) || typeof supplies[role]?.resolve !== 'function'))
    throw new TypeError('Independent callable storage, tool, renderer and file supplies are required; each installed role must resolve an executable address.');
  const installed = async (address, context) => {
    if (context?.capability_role && roles.includes(context.capability_role)) {
      const behavior = await supplies[context.capability_role].resolve(address, context);
      return behavior ?? null;
    }
    const matches = [];
    for (const role of roles) {
      const behavior = await supplies[role].resolve(address, context);
      if (behavior != null) matches.push(behavior);
    }
    if (matches.length > 1) throw Object.assign(new Error('An installed address resolved to more than one supplied behavior.'),
      { code: 'creation_resource_ambiguous_address', status: 409 });
    return matches[0] ?? null;
  };
  const owner = makeCreationResourceOwner({ resource, store, authority, placement, policy, installed, now });
  const invoke = async (role, envelope, context) => {
    if (!roles.includes(role)) throw new TypeError('An installed creation dependency role is required.');
    const behavior = await supplies[role].resolve(envelope?.address, context);
    if (typeof behavior?.invoke !== 'function') throw Object.assign(new Error(`No executable ${role} behavior is installed at this address.`),
      { code: 'creation_resource_not_found', status: 404 });
    if (!Object.hasOwn(owner, envelope.operation) || typeof owner[envelope.operation] !== 'function') throw Object.assign(new Error('This creation lifecycle operation is not installed.'), { status: 404 });
    return owner[envelope.operation]({ id: envelope.creation_id, request_key: envelope.request_key, capability: { ...envelope.capability, address: envelope.address, role },
      dependencies: envelope.dependencies ?? [], requirements: envelope.requirements ?? {}, budget: envelope.budget ?? {}, lifetime: envelope.lifetime ?? {},
      input: envelope.input ?? {}, command_context: context });
  };
  return Object.freeze({ owner, resource, invoke, supplies: Object.freeze(Object.fromEntries(roles.map(role => [role, supplies[role]]))) });
}
