// Who may be in a community, and what a community is, as values. Every function here takes the rows the caller read and
// answers yes or no and why. None reads or writes a store: the person's own store keeps the rows
// (workflow:keep-community-space-records), and the caller passes them in.

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
const INVITED_ONLY = [{ invited: true }];
const denial = (message, status, code) => Object.assign(new Error(message), { status, code });

/** The join rows a community's members come in by: its own rules, or invitation only. */
export const joinRows = community => (community.joined_by_rules ? community.config.join : INVITED_ONLY);

/**
 * Whether a person may be in a space by these join rows now. `holds` is what they hold and from whom
 * ([{ access, by }], by = the relay of whoever granted it). A paid row ({ access }) is met only by a grant from this space's
 * owner (`owner`, their relay): no one's purchase from one owner opens another's space.
 */
export const mayJoin = (rows, holds = [], owner = null) => rows.some(row => row.free === true
  || (typeof row.access === 'string' && holds.some(held => held?.access === row.access && held.by === owner && owner !== null)));

/** Whether people a member invites (with an invite link) may be in it, and whether that is the only way in. */
export const takesInvited = rows => rows.some(row => row.invited === true);
export const onlyInvited = rows => rows.every(row => row.invited === true);

/** The words a person reads about how to get in. */
export function joinWords(rows) {
  if (rows.some(row => row.free)) return 'Anyone can join.';
  if (onlyInvited(rows)) return 'Joining is by an invitation or an invite link from someone in it.';
  return `Joining comes with: ${rows.map(row => row.says ?? row.access ?? 'an invite link from someone in it').join(' or ')}.`;
}

/**
 * Whether people get into this space by its own rules rather than by each other's agreement. `chain` is the space's
 * membership row, then its parent's, up to the root; a missing row (null) answers false. The root's label decides
 * (labels.membership_labels[label].joined_by), so an event inside a space follows that space.
 */
export function joinedByRules(chain, labels) {
  const seen = new Set();
  for (const row of chain) {
    if (!row) return false;
    if (seen.has(row.id)) throw new Error('The membership parent chain contains a cycle.');
    seen.add(row.id);
    if (!row.parent_id) return labels.membership_labels[row.label]?.joined_by === 'rules';
  }
  throw new Error('The membership parent chain is not complete.');
}

/**
 * The community a membership row and its configuration row make. `configRow` is null when the space has no saved
 * configuration; then its label's DATA configuration is used.
 */
export function communityOf({ membership, configRow, joinedByRules: rulesJoin, labels }) {
  if (configRow && !isObject(configRow.config)) throw new Error('The community configuration record is invalid.');
  const config = configRow ? structuredClone(configRow.config) : structuredClone(labels.membership_labels[membership.label]?.configuration ?? {});
  return {
    id: membership.id, label: membership.label, joined_by_rules: rulesJoin, owner_relay: membership.created_by,
    created_at: configRow?.created_at ?? membership.created_at,
    updated_at: configRow?.updated_at ?? configRow?.created_at ?? membership.created_at,
    config: { ...config, title: membership.title, ...(membership.about ? { about: membership.about } : {}) },
  };
}

/** A current member: a member row in state member now. */
export const isMemberNow = member => member?.state === 'member';

/**
 * Whether this person came into a space by an invitation they accepted: the member row says so, or the invitation owner
 * (`acceptedInvitation(spaceId, relay)`, a current owner's read) confirms it. Anything but a boolean from that owner is
 * unavailable evidence, never a no.
 */
async function cameByInvitation(spaceId, relay, member, acceptedInvitation) {
  if (member?.admitted_by_invitation === true || member?.admitted_by_invitation === 1) return true;
  const unavailable = () => denial('The current network invitation owner could not verify accepted invitation evidence.', 503, 'accepted_invitation_evidence_unavailable');
  if (typeof acceptedInvitation !== 'function') throw unavailable();
  const accepted = await acceptedInvitation(spaceId, relay);
  if (typeof accepted !== 'boolean') throw unavailable();
  return accepted;
}

/**
 * Whether this person is an active member of the community now, with why. `holds` is what the person holds (null when
 * paid evidence is unknown). Refusals that need evidence nobody can give are unavailable (503), never a no.
 * → { allowed, reason }
 */
export async function memberDecision({ community, relay, holds = [], member, acceptedInvitation }) {
  if (!relay || !isMemberNow(member)) return { allowed: false, reason: 'not_a_member_now' };
  if (relay === community.owner_relay || !community.joined_by_rules) return { allowed: true, reason: 'open_or_owner' };
  const rows = joinRows(community);
  if (holds === null ? rows.some(row => row.free === true) : mayJoin(rows, holds, community.owner_relay)) return { allowed: true, reason: 'join_rules_met' };
  if (takesInvited(rows) && await cameByInvitation(community.id, relay, member, acceptedInvitation)) return { allowed: true, reason: 'came_by_invitation' };
  if (holds === null && rows.some(row => typeof row.access === 'string')) throw denial(
    'Current access holdings could not verify the paid membership requirement.', 503, 'access_holdings_evidence_unavailable');
  return { allowed: false, reason: 'join_rules_not_met' };
}

/** The community if this person is an active member; otherwise the refusal that says why. */
export async function checkedMemberDecision(input) {
  const decision = await memberDecision(input);
  if (!decision.allowed) throw denial(`Only members of ${input.community.config.title} can do this. ${joinWords(joinRows(input.community))}`, 403, 'community_membership_required');
  return input.community;
}

/** The space rules a rules row holds, checked. */
export function rulesOf(value) {
  if (value === null) return null;
  if (typeof value.rules !== 'string' || typeof value.changed_at !== 'string') throw new Error('The space rules record is invalid.');
  return { rules: value.rules, changed_at: value.changed_at };
}

/** The member types a space may use: its own rows, plus the copied show-rule document types not already among them. */
export function ownMemberTypesOf(rows, document) {
  const types = rows.map(row => ({ id: row.type_id, label: row.label, inherits: Array.isArray(row.inherits) ? row.inherits : JSON.parse(row.inherits ?? '[]') }));
  const copied = new Set((document?.types ?? []).map(type => type.id));
  return [...types.filter(type => !copied.has(type.id)), ...(document?.types ?? []).map(type => ({ id: type.id, label: type.label, inherits: type.inherits ?? [] }))];
}

/** The state a permission decision was made on, as stable text, so a later write can be checked against it. */
export const stateText = state => JSON.stringify(stable(state));
