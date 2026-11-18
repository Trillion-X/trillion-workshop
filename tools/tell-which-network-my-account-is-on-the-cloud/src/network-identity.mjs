// src/network-identity.mjs
//
// Purpose: which network a person's Trillion is on (Trillion's cloud, their own server or storage, or only this
// computer), as one explicit fact derived from DATA (src/network-identity.json), and which features that need other
// people to reach it are offered there. Screens and tools read it before offering a share link, an email share, the
// network or a space, so a Trillion nobody else can reach says so up front instead of handing out a link that fails
// when someone opens it. The sharing sheet carries it (src/record-sharing.mjs sharingSheet `network_reach`) and an
// email share is refused with its reason before anything is sent (sendRecordShare); both read their facts through
// record-sharing networkFacts: the serving address and the storage origins the person attached to their Namespace.
//
// Non-Negotiable Invariants:
//   1. No identity, host or feature is named in code: each is a row of src/network-identity.json.
//   2. An unknown fact decides nothing: an empty host is in no group and outside none, so the fallback row answers.
//   3. A feature that does not need others is always available; one that does is available only where others can
//      reach, and where they cannot it is refused only when its row says `refuse` (the rest are made and said).
//
//   networkIdentityOf({ origin, attached_storage }) → { id, label, reachable_by_others }
//   featureReach(identity, featureId) → { feature, available, refused, reason }
//   networkReach(facts) → { identity, features: { [id]: { available, refused, reason } } }
import rules from '../../shared-code/src/network-identity.json' with { type: 'json' };

export const NETWORK_IDENTITY = rules;
const GROUPS = new Map(rules.host_groups.map(group => [group.id, group]));
const FEATURES = new Map(rules.features.map(feature => [feature.id, feature]));

const hostOf = origin => {
  try { return typeof origin === 'string' && origin ? new URL(origin).host.toLowerCase().replace(/:\d+$/, '') : ''; } catch { return ''; }
};
const inGroup = (host, id) => {
  const group = GROUPS.get(id);
  if (!group) throw new Error(`No host group ${id} in src/network-identity.json.`);
  return group.hosts.includes(host) || group.suffixes.some(suffix => host === suffix.replace(/^\./, '') || host.endsWith(suffix.startsWith('.') ? suffix : `.${suffix}`));
};
const holds = (condition, facts) => {
  const value = facts[condition.fact];
  if ('equals' in condition) return value === condition.equals;
  if (!value) return false; // invariant 2
  if ('in_group' in condition) return inGroup(value, condition.in_group);
  if ('outside_group' in condition) return !inGroup(value, condition.outside_group);
  throw new Error(`A network identity condition names equals, in_group or outside_group: ${JSON.stringify(condition)}.`);
};

/** The identity of a Trillion served at `origin`, with `attached_storage` true when its files are in storage the person
 *  attached. */
export function networkIdentityOf({ origin = '', attached_storage: attachedStorage = false } = {}) {
  const facts = { host: hostOf(origin), attached_storage: attachedStorage === true };
  const row = rules.identities.find(identity => !identity.when || identity.when.some(condition => holds(condition, facts)));
  return { id: row.id, label: row.label, reachable_by_others: row.reachable_by_others };
}

/** Whether one feature is offered under an identity, and the reason when it is not. */
export function featureReach(identity, featureId) {
  const feature = FEATURES.get(featureId);
  if (!feature) throw new Error(`No feature ${featureId} in src/network-identity.json.`);
  const available = !feature.needs_others || identity.reachable_by_others === true;
  const row = rules.identities.find(candidate => candidate.id === identity.id);
  return { feature: featureId, available, refused: !available && feature.when_unreachable === 'refuse', reason: available ? null : row.unavailable.replace('{feature}', feature.label) };
}

/** The identity and every feature's availability, as one answer a screen or tool reads. */
export function networkReach(facts) {
  const identity = networkIdentityOf(facts);
  return {
    identity,
    features: Object.fromEntries(rules.features.map(feature => {
      const { available, refused, reason } = featureReach(identity, feature.id);
      return [feature.id, { available, refused, reason }];
    })),
  };
}
