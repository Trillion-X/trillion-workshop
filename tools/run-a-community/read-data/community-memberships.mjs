// Shared community membership/config reads and event-membership writes through
// the run's records door. Record types and ids are supplied by the installed
// record_model DATA; this module owns no second database or fallback cache.
import { AsyncLocalStorage } from 'node:async_hooks';

const DEFAULT_WRITE_LIMIT = 256;
const clone = value => value === undefined ? undefined : structuredClone(value);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
const stableText = value => JSON.stringify(stable(value));

function idFor(binding, fields) {
  if (!binding || typeof binding.type !== 'string' || !binding.type
      || typeof binding.id_pattern !== 'string' || !binding.id_pattern) {
    throw new TypeError('Each community record binding needs its declared type and id_pattern.');
  }
  return binding.id_pattern.replace(/\{([a-z][a-z0-9_]*)\}/g, (_whole, name) => {
    const value = fields[name];
    if (typeof value !== 'string' || !value) throw new TypeError(`The record id needs ${name}.`);
    return encodeURIComponent(value);
  });
}

export const mayJoin = (rows, holds = [], owner = null) => rows.some(row => row.free === true
  || (typeof row.access === 'string' && holds.some(held => held?.access === row.access && held.by === owner && owner !== null)));

/**
 * Bind the old community membership methods to declared record_model data.
 *
 * model provides `membership`, `member`, `community`, `rules`,
 * `own_member_type`, and `show_rule_document` bindings. Each binding has a
 * `type` and a DATA-owned `id_pattern`; membership/member/community/rule
 * bindings use the record ids that preserve the old logical identity.
 * membership_labels is the matching DATA object from the existing network
 * settings owner. `requestKey()` is the stable key admitted for this action.
 */
export function createCommunityMemberships({ door, model, membership_labels: membershipLabels, requestKey, acceptedInvitation, maxWrites = DEFAULT_WRITE_LIMIT } = {}) {
  const scopes = new AsyncLocalStorage();
  if (!door || typeof door.readRecord !== 'function' || typeof door.list !== 'function' || typeof door.write !== 'function') {
    throw new TypeError('Community membership storage needs the run records door.');
  }
  for (const name of ['membership', 'member', 'community', 'rules', 'own_member_type', 'show_rule_document']) {
    if (!model?.[name] || typeof model[name].type !== 'string' || typeof model[name].id_pattern !== 'string') {
      throw new TypeError(`The record_model DATA binding ${name} is required.`);
    }
  }
  if (!isObject(membershipLabels) || typeof requestKey !== 'function' || !Number.isInteger(maxWrites) || maxWrites < 1 || maxWrites > DEFAULT_WRITE_LIMIT) {
    throw new TypeError('Membership labels DATA, a stable request key, and a bounded write limit are required.');
  }
  const labels = { membership_labels: membershipLabels };

  const keyOf = (type, id) => `${type}\u0000${id}`;
  const commandKey = (scope = null) => {
    const key = requestKey();
    if (typeof key !== 'string' || !key.trim()) throw new Error('The admitted action has no stable records request key.');
    return scope === null ? key : JSON.stringify([key, scope]);
  };
  const readRaw = async (type, id) => {
    const record = await door.readRecord(type, id);
    if (record === null) return null;
    if (!isObject(record) || record.type !== type || !isObject(record.value)) {
      throw new Error(`The records door returned an invalid ${type} record.`);
    }
    return {
      type,
      value: clone(record.value),
      ...(typeof record.identity === 'string' && record.identity.length ? { identity: record.identity } : {}),
    };
  };

  async function get(binding, fields, { fresh = false, guard = false } = {}) {
    const id = idFor(binding, fields), tx = scopes.getStore(), key = keyOf(binding.type, id);
    if (tx?.writes.has(key)) return clone(tx.writes.get(key).value);
    if (tx && !fresh && tx.reads.has(key)) {
      if (guard) tx.guards.add(key);
      const cached = tx.reads.get(key);
      return cached ? clone(cached.value) : null;
    }
    const record = await readRaw(binding.type, id);
    if (tx) {
      if (!tx.reads.has(key)) tx.reads.set(key, clone(record));
      if (guard) tx.guards.add(key);
    }
    return record ? clone(record.value) : null;
  }

  async function list(binding, where, { guard = false } = {}) {
    const result = [];
    const tx = scopes.getStore();
    // Point-row conditions cannot prove that no new row joined this query.
    // Record the dependency even for an empty collection; only the native
    // source/transaction owner can supply a complete atomic query witness.
    if (guard && tx) tx.unfencedCollections.add(stableText({ type: binding.type, where }));
    for await (const record of door.list({ type: binding.type, where })) {
      if (!isObject(record) || record.type !== binding.type || typeof record.id !== 'string' || !isObject(record.value)) {
        throw new Error(`The records door returned an invalid ${binding.type} list row.`);
      }
      if (binding === model.membership && (typeof record.value.id !== 'string'
          || idFor(binding, { id: record.value.id }) !== record.id)) {
        throw new Error('A membership list row does not match its declared record identity.');
      }
      if (binding === model.member && (typeof record.value.membership_id !== 'string' || typeof record.value.relay !== 'string'
          || idFor(binding, { membership_id: record.value.membership_id, relay: record.value.relay }) !== record.id)) {
        throw new Error('A member list row does not match its declared composite identity.');
      }
      const snapshot = {
        type: binding.type,
        value: clone(record.value),
        ...(typeof record.identity === 'string' && record.identity.length ? { identity: record.identity } : {}),
      };
      const key = keyOf(binding.type, record.id);
      if (tx) {
        if (!tx.reads.has(key)) tx.reads.set(key, snapshot);
        if (guard) tx.guards.add(key);
      }
      result.push(clone(record.value));
    }
    return result;
  }

  function write(binding, fields, value) {
    const tx = scopes.getStore();
    if (!tx) throw new Error('Membership writes require one atomic transaction.');
    const id = idFor(binding, fields), key = keyOf(binding.type, id);
    const expected = tx.reads.has(key) ? tx.reads.get(key) : undefined;
    if (expected === undefined) throw new Error(`Read ${binding.type} ${id} before writing it.`);
    tx.writes.set(key, { id, type: binding.type, value: clone(value), expected: clone(expected) });
  }

  async function readMembership(id, options = {}) {
    const value = await get(model.membership, { id }, options);
    if (!value) return null;
    if (value.id !== id) throw new Error('A membership record does not match its stored identity.');
    return value;
  }
  async function readMember(membershipId, relay, options = {}) {
    const value = await get(model.member, { membership_id: membershipId, relay }, { guard: true, ...options });
    if (!value) return null;
    if (value.membership_id !== membershipId || value.relay !== relay) throw new Error('A member record does not match its stored identity.');
    return value;
  }
  async function readConfig(spaceId, options = {}) {
    const value = await get(model.community, { id: spaceId }, { guard: true, ...options });
    if (value && value.id !== spaceId) throw new Error('A community configuration record does not match its stored identity.');
    return value;
  }
  // Whether people get into this space by its own rules rather than by each other's agreement: its label's DATA row
  // (src/network-settings.json membership_labels joined_by) decides, and an event inside a space follows that space.
  async function joinedByRules(spaceId, { fresh = false, seen = new Set() } = {}) {
    if (seen.has(spaceId)) throw new Error('The membership parent chain contains a cycle.');
    seen.add(spaceId);
    const row = await readMembership(spaceId, { fresh, guard: true });
    if (!row) return false;
    return row.parent_id ? joinedByRules(row.parent_id, { fresh, seen }) : labels.membership_labels[row.label]?.joined_by === 'rules';
  }
  async function readCommunity(spaceId, options = {}) {
    const membership = await readMembership(spaceId, { guard: true, ...options });
    if (!membership) {
      const error = new Error('No pursuit with that id.');
      Object.assign(error, { status: 404, code: 'community_not_found' });
      throw error;
    }
    const stored = await readConfig(spaceId, options);
    if (stored !== null && !isObject(stored.config)) throw new Error('The community configuration record is invalid.');
    const row = {
      ...membership,
      config: stored === null ? null : JSON.stringify(stored.config),
      configured_at: stored?.created_at ?? null,
      config_updated_at: stored?.updated_at ?? null,
    };
    const config = row.config ? JSON.parse(row.config) : structuredClone(labels.membership_labels[row.label]?.configuration ?? {});
    return { id: row.id, label: row.label, joined_by_rules: await joinedByRules(row.id, options), owner_relay: row.created_by, created_at: row.configured_at ?? row.created_at, updated_at: row.config_updated_at ?? row.configured_at ?? row.created_at, config: { ...config, title: row.title, ...(row.about ? { about: row.about } : {}) } };
  }
  // Who may be in a space: its join rows when it is joined by its own rules, and only people let in by invitation
  // otherwise.
  const INVITED_ONLY = [{ invited: true }];
  const joinRows = community => (community.joined_by_rules ? community.config.join : INVITED_ONLY);
  /**
   * Whether a person may be in a space by these join rows now. `holds` is what they hold and from whom
   * ([{ access, by }], by = the relay of whoever granted it: src/person-store.mjs holdings). A paid row ({ access }) is
   * met only by a grant from this space's owner (`owner`, their relay): what the owner sold them on the owner's own
   * payment connection, or, in a space run by the account that runs this service, its own plans. So a member of a
   * business's space is never asked to hold Trillion's plan, and no one's purchase from one owner opens another's space.
   */
  /** Whether people a member invites (with an invite link) may be in it, and whether that is the only way in. */
  const takesInvited = rows => rows.some(row => row.invited === true);
  const onlyInvited = rows => rows.every(row => row.invited === true);
  function joinWords(rows) {
    if (rows.some(row => row.free)) return 'Anyone can join.';
    if (onlyInvited(rows)) return 'Joining is by an invitation or an invite link from someone in it.';
    return `Joining comes with: ${rows.map(row => row.says ?? row.access ?? 'an invite link from someone in it').join(' or ')}.`;
  }

  // Whether this person came into a space by an invitation they accepted (an invite link, or a member inviting them):
  // what keeps them in a community that takes invited people (src/community.mjs accessChanged).
  async function cameByInvitation(spaceId, relay, { fresh = false } = {}) {
    const member = await readMember(spaceId, relay, { fresh });
    if (member?.admitted_by_invitation === true || member?.admitted_by_invitation === 1) return true;
    if (typeof acceptedInvitation !== 'function') throw Object.assign(
      new Error('The current network invitation owner could not verify accepted invitation evidence.'),
      { status: 503, code: 'accepted_invitation_evidence_unavailable' },
    );
    const accepted = await acceptedInvitation(spaceId, relay);
    if (typeof accepted !== 'boolean') throw Object.assign(
      new Error('The current network invitation owner could not verify accepted invitation evidence.'),
      { status: 503, code: 'accepted_invitation_evidence_unavailable' },
    );
    return accepted;
  }
  // A current member: in the record now. In a space joined by its own rules, a member whose plan stopped letting them
  // in is lapsed, not a member; everyone let into a space joined by invitation is a member while they stay.
  async function isMemberNow(membershipId, relay) {
    return (await readMember(membershipId, relay))?.state === 'member';
  }
  async function activeMember(community, relay, holds = [], options = {}) {
    if (!relay || !await isMemberNow(community.id, relay)) return false;
    if (relay === community.owner_relay || !community.joined_by_rules) return true;
    const rows = joinRows(community);
    if (holds === null ? rows.some(row => row.free === true) : mayJoin(rows, holds, community.owner_relay)) return true;
    if (takesInvited(rows) && await cameByInvitation(community.id, relay, options)) return true;
    if (holds === null && rows.some(row => typeof row.access === 'string')) throw Object.assign(
      new Error('Current access holdings could not verify the paid membership requirement.'),
      { status: 503, code: 'access_holdings_evidence_unavailable' },
    );
    return false;
  }
  async function checkedMember(id, relay, holds = [], options = {}) {
    const community = await readCommunity(id, options);
    if (!await activeMember(community, relay, holds, options)) throw Object.assign(
      new Error(`Only members of ${community.config.title} can do this. ${joinWords(joinRows(community))}`),
      { status: 403, code: 'community_membership_required' },
    );
    return community;
  }

  async function rules(spaceId, options = {}) {
    const value = await get(model.rules, { id: spaceId }, { guard: true, ...options });
    if (value === null) return null;
    if (typeof value.rules !== 'string' || typeof value.changed_at !== 'string') throw new Error('The space rules record is invalid.');
    return { rules: value.rules, changed_at: value.changed_at };
  }
  async function ensureRules(spaceId, startingRow) {
    if (!isObject(startingRow) || typeof startingRow.rules !== 'string' || typeof startingRow.changed_at !== 'string') {
      throw new TypeError('Starting space rules need JSON text and a changed_at timestamp.');
    }
    const value = { id: spaceId, rules: startingRow.rules, changed_at: startingRow.changed_at };
    const seedIfAbsent = async () => {
      const current = await get(model.rules, { id: spaceId }, { fresh: true, guard: true });
      if (current !== null) return rules(spaceId, { fresh: true });
      write(model.rules, { id: spaceId }, value);
      return { rules: value.rules, changed_at: value.changed_at };
    };

    if (scopes.getStore()) return seedIfAbsent();
    const current = await rules(spaceId, { fresh: true });
    if (current !== null) return current;
    try {
      // Independent defaults in one collection read are distinct writes. A
      // default inside a domain transaction remains staged with that command.
      await door.write([{ id: idFor(model.rules, { id: spaceId }), type: model.rules.type, value, expected: null }],
        { key: commandKey(['space-rules-default', idFor(model.rules, { id: spaceId })]) });
    } catch (error) {
      if (error?.code !== 'original_command_conflict') throw error;
      const winner = await rules(spaceId, { fresh: true });
      if (winner !== null) return winner;
      throw error;
    }
    // Read through the canonical validator after the insert. This reports the
    // actual row and never treats malformed stored policy as missing policy.
    return rules(spaceId, { fresh: true });
  }
  async function ownMemberTypes(spaceId, options = {}) {
    const rows = await list(model.own_member_type, { space_id: spaceId }, { guard: true });
    const document = await get(model.show_rule_document, { id: spaceId }, { guard: true, ...options });
    const types = rows.map(row => ({ id: row.type_id, label: row.label, inherits: Array.isArray(row.inherits) ? row.inherits : JSON.parse(row.inherits ?? '[]') }));
    const copied = new Set((document?.types ?? []).map(type => type.id));
    return [...types.filter(type => !copied.has(type.id)), ...(document?.types ?? []).map(type => ({ id: type.id, label: type.label, inherits: type.inherits ?? [] }))];
  }
  async function accessState(spaceId, relay, thing = null) {
    // Force every auth read fresh. The first values remain in the transaction's
    // guard set so a later CAS batch covers changes after this comparison too.
    const community = await readCommunity(spaceId, { fresh: true });
    const membership = await readMembership(spaceId, { fresh: true, guard: true });
    const actor = relay ? await readMember(spaceId, relay, { fresh: true, guard: true }) : null;
    const maker = thing?.by ? await readMember(spaceId, thing.by, { fresh: true, guard: true }) : null;
    const communityRecord = await readConfig(spaceId, { fresh: true });
    const rulesRecord = await get(model.rules, { id: spaceId }, { fresh: true, guard: true });
    const ownTypeRecords = await list(model.own_member_type, { space_id: spaceId }, { guard: true });
    const showRuleDocument = await get(model.show_rule_document, { id: spaceId }, { fresh: true, guard: true });
    const state = { membership, actor, maker, communityRecord, rulesRecord, ownTypeRecords, showRuleDocument };
    return stableText(state);
  }

  const api = {
    async read(id) { return readMembership(id); },
    async events(parentId) { return list(model.membership, { parent_id: parentId, label: 'event' }); },
    async member(eventId, relay) { return readMember(eventId, relay); },
    async members(membershipId) { return list(model.member, { membership_id: membershipId }); },
    async putEvents(rows) {
      if (!Array.isArray(rows)) throw new TypeError('Event rows are a list.');
      for (const row of rows) {
        if (!isObject(row) || typeof row.id !== 'string' || !row.id || row.label !== 'event') throw new TypeError('An event keeps its event membership id and label.');
        const before = await readMembership(row.id);
        const revision = before === null ? 1 : Number.isSafeInteger(before.revision) ? before.revision + 1 : 1;
        write(model.membership, { id: row.id }, { ...clone(row), revision });
      }
    },
    async putMember(row) {
      if (!isObject(row) || typeof row.membership_id !== 'string' || typeof row.relay !== 'string') throw new TypeError('An RSVP keeps its membership and relay identity.');
      const event = await readMembership(row.membership_id);
      if (!event || event.label !== 'event') throw new Error('The RSVP event is no longer available.');
      const before = await readMember(row.membership_id, row.relay);
      const revision = before === null ? 1 : Number.isSafeInteger(before.revision) ? before.revision + 1 : 1;
      write(model.membership, { id: event.id }, { ...event, revision: (Number.isSafeInteger(event.revision) ? event.revision : 0) + 1 });
      write(model.member, { membership_id: row.membership_id, relay: row.relay }, { ...clone(row), revision });
    },
    async removeEvent(id) {
      const event = await readMembership(id);
      if (!event || event.label !== 'event') return;
      const attendees = await list(model.member, { membership_id: id });
      const totalWrites = 1 + attendees.length;
      if (totalWrites > maxWrites) throw new Error(`Removing this event needs ${totalWrites} atomic record writes; the declared limit is ${maxWrites}.`);
      write(model.membership, { id }, null);
      for (const member of attendees) write(model.member, { membership_id: id, relay: member.relay }, null);
    },
    async transaction(fn) {
      if (typeof fn !== 'function') throw new TypeError('A membership transaction needs a function.');
      if (scopes.getStore()) return fn();
      const tx = { reads: new Map(), guards: new Set(), writes: new Map(), unfencedCollections: new Set() };
      const result = await scopes.run(tx, fn);
      if (!tx.writes.size) return result;
      if (tx.unfencedCollections.size) throw Object.assign(
        new Error('The current records owner cannot validate the complete permission collection atomically with this change.'),
        { status: 503, code: 'community_collection_snapshot_unavailable' },
      );
      const writes = new Map(tx.writes);
      // Include no-op guarded rows in the same conditional write so an auth
      // revocation cannot slip between the fresh decision and event commit.
      for (const key of tx.guards) {
        if (writes.has(key)) continue;
        const before = tx.reads.get(key);
        if (before === undefined) throw new Error('An authorization row was not captured for the transaction.');
        writes.set(key, {
          id: key.slice(key.indexOf('\u0000') + 1),
          type: before?.type ?? key.slice(0, key.indexOf('\u0000')),
          value: before === null ? null : clone(before.value),
          expected: clone(before),
        });
      }
      if (writes.size > maxWrites) throw new Error(`The operation needs ${writes.size} atomic record writes; the declared limit is ${maxWrites}.`);
      if (writes.size) {
        const key = commandKey();
        await door.write([...writes.values()].map(({ id, type, value, expected }) => ({
          id, type, value,
          expected: expected === null ? null : {
            type: expected.type,
            value: expected.value,
            ...(typeof expected.identity === 'string' && expected.identity.length ? { identity: expected.identity } : {}),
          },
        })), { key });
      }
      return result;
    },
  };

  return Object.assign(api, {
    readCommunity, activeMember, checkedMember,
    isMemberNow: async (id, relay) => (await readMember(id, relay))?.state === 'member',
    rules,
    community: async id => (await readMembership(id)) ? { config: (await readCommunity(id)).config } : null,
    ownMemberTypes, accessState, joinedByRules,
    ensureRules,
  });
}
