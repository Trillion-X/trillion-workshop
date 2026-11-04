// src/space-member-types.mjs
//
// Purpose: the kinds of member a space has, and what the person reading a space may do in it. A member's
// type is the `role` of their membership row in that space (src/network.mjs `members`), which the space's rules
// (src/space-permissions.mjs) read as the fact `member_type`. The types each label of space starts with, the type a
// joiner gets and the roles written before types existed are DATA (src/space-member-types.json); a space adds its own
// types by name, kept in `space_member_types`.
//
// Non-Negotiable Invariants:
//   1. Every change here is decided by the space's own rules through allowedInSpace: giving a member a type is
//      `set_member_type`, adding or removing a space's own type is `change_rules`, hiding or showing a thing is
//      `hide_item`. Nothing here compares members, makers or labels to decide.
//   2. A member is only ever given a type the space has (its label's types plus its own), and a change that would
//      leave nobody in the space able to change who may do what is undone and refused.
//   3. A space's own type is removed only while no member holds it and no rule names it, so no rule silently stops
//      meaning anything.
//   4. `may` lists what the reader may do, asked of the same rules for the actions whose `offered_on` says where they
//      are offered (src/space-permission-rules.json), so a screen offers exactly what the store would allow. For
//      things, one decision is made per distinct maker and origin on the page, not per thing.
//   5. A hidden thing keeps its words; they are sent only to readers the rules let hide or show it, so they can show
//      it again. Everyone else reads that it is hidden and by whom.
//
import memberTypes from '../../../space-member-types/src/space-member-types.json' with { type: 'json' };
import permissions from '../../../space-permission-rules/src/space-permission-rules.json' with { type: 'json' };

const OFFERED = on => permissions.actions.filter(action => action.offered_on === on).map(action => action.id);
const SPACE_ACTIONS = OFFERED('space');
const ITEM_ACTIONS = OFFERED('item');
const setupOf = label => memberTypes.labels[label] ?? memberTypes.default;
const LIMITS = memberTypes.own_types;
const slug = words => words.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'type';

/** Read the complete permission graph in bounded pages, retaining legacy rows beyond the creation limit. */
export function readOwnMemberTypeRows(sql, spaceId, offered = false) {
  const result = [], pageSize = LIMITS.max;
  let after = null;
  for (;;) {
    const page = sql.exec(`SELECT type_id, label, inherits${offered ? ', added_at' : ''}
      FROM space_member_types WHERE space_id = ?
      ${after === null ? '' : offered ? 'AND (added_at, type_id) > (?, ?)' : 'AND type_id > ?'}
      ORDER BY ${offered ? 'added_at, type_id' : 'type_id'} LIMIT ?`,
    spaceId, ...(after === null ? [] : offered ? [after.added_at, after.type_id] : [after.type_id]), pageSize).toArray();
    for (const { added_at, ...row } of page) result.push(row);
    if (page.length < pageSize) return result;
    after = page.at(-1);
  }
}

/**
 * A space's own member types, in the order they are offered. Rows written before show-rules storage are read in place
 * until they are copied across (space_member_types), then the space's show-rules document (space_show_rule_types) holds
 * every type this module writes. A type copied into the document is read from the document, never from its row.
 */
export function ownMemberTypesOf(sql, spaceId) {
  const document = documentMemberTypesOf(sql, spaceId);
  const copied = new Set(document.map(type => type.id));
  const rows = readOwnMemberTypeRows(sql, spaceId, true).filter(row => !copied.has(row.type_id))
    .map(row => ({ id: row.type_id, label: row.label, inherits: JSON.parse(row.inherits || '[]') }));
  return [...rows, ...document.map(({ id, label, inherits }) => ({ id, label, inherits }))];
}

/** The types written to the space's show-rules document (space_show_rule_types), each with who added it and when. */
export function documentMemberTypesOf(sql, spaceId) {
  const row = sql.exec('SELECT types FROM space_show_rule_types WHERE space_id = ? LIMIT 1', spaceId).toArray()[0];
  return row ? JSON.parse(row.types) : [];
}

/**
 * A space's own member types as show-rules types (src/workspace/show-rules.mjs givenRules `spaceTypes`), read through
 * from their storage: nothing is copied here. Each is scoped to its space, so the show rules it holds apply only inside
 * that space.
 */
export function showRuleTypesOf(sql, spaceId) {
  return ownMemberTypesOf(sql, spaceId).map(type => ({
    id: type.id, label: type.label, inherits: type.inherits, rules: [], scope: { space_id: spaceId } }));
}

/** The named type and every type it inherits, in parent-first order, once each. */
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

// Whether a rule names a member type, in its who or anywhere in its when.
const whenNames = (node, typeId) => (node?.kind === 'group' ? (node.rules ?? []).some(child => whenNames(child, typeId)) : ['member_type', 'member_types'].includes(node?.field) && (node.params?.values ?? []).includes(typeId));
const namesType = (rule, typeId) => (rule.who?.kind === 'member_type' && rule.who.member_type === typeId) || whenNames(rule.when, typeId);

export const spaceMemberTypeMethods = {
  setUpSpaceMemberTypes() {
    this.sql.exec('CREATE TABLE IF NOT EXISTS space_member_types (space_id TEXT NOT NULL, type_id TEXT NOT NULL, label TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (space_id, type_id))');
    const typeColumns = this.sql.exec('PRAGMA table_info(space_member_types)').toArray().map(column => column.name);
    if (!typeColumns.includes('inherits')) this.sql.exec("ALTER TABLE space_member_types ADD COLUMN inherits TEXT NOT NULL DEFAULT '[]'");
    this.sql.exec('CREATE TABLE IF NOT EXISTS space_show_rule_types (space_id TEXT PRIMARY KEY, types TEXT NOT NULL DEFAULT \'[]\')');
    this.sql.exec("CREATE TABLE IF NOT EXISTS space_member_type_copy (id TEXT PRIMARY KEY, after_space_id TEXT NOT NULL DEFAULT '', after_type_id TEXT NOT NULL DEFAULT '', done_at TEXT)");
    const copyColumns = this.sql.exec('PRAGMA table_info(space_member_type_copy)').toArray().map(column => column.name);
    if (!copyColumns.includes('next_at')) this.sql.exec('ALTER TABLE space_member_type_copy ADD COLUMN next_at TEXT');
    this.sql.exec("INSERT OR IGNORE INTO space_member_type_copy (id) VALUES ('rows')");
    const columns = this.sql.exec('PRAGMA table_info(space_items)').toArray().map(column => column.name);
    if (!columns.includes('hidden_at')) this.sql.exec('ALTER TABLE space_items ADD COLUMN hidden_at TEXT');
    if (!columns.includes('hidden_by')) this.sql.exec('ALTER TABLE space_items ADD COLUMN hidden_by TEXT');
    // The earlier-role updates below find their rows by role, not by reading every member on each object start.
    this.sql.exec('CREATE INDEX IF NOT EXISTS members_by_role ON members (role)');
    // Roles written before types existed read as the type they are now (earlier_roles), once.
    for (const [label, setup] of Object.entries(memberTypes.labels)) {
      for (const [earlier, now] of Object.entries(setup.earlier_roles ?? {})) this.sql.exec("UPDATE members SET role = ? WHERE role = ? AND membership_id IN (SELECT id FROM memberships WHERE label = ?)", now, earlier, label);
    }
    const named = Object.keys(memberTypes.labels);
    for (const [earlier, now] of Object.entries(memberTypes.default.earlier_roles ?? {})) {
      this.sql.exec(`UPDATE members SET role = ? WHERE role = ? AND membership_id IN (SELECT id FROM memberships WHERE label NOT IN (${named.map(() => '?').join(', ')}))`, now, earlier, ...named);
    }
  },

  /** The type a person joining a space gets: its persistent choice, or the label's starting profile. */
  joiningType(label, spaceId = null) {
    if (spaceId) {
      const row = this.sql.exec('SELECT joins_as FROM space_state WHERE space_id = ?', spaceId).toArray()[0];
      if (row?.joins_as) return row.joins_as;
    }
    return setupOf(label).joins_as;
  },

  /** The label and pursuit-owned rows before community overlays; validate only once the entire graph is assembled. */
  baseMemberTypesOf(space) {
    const own = ownMemberTypesOf(this.sql, space.id);
    return [...setupOf(space.label).types.map(type => ({ ...type, own: false })), ...own.map(type => ({ ...type, own: true }))];
  },

  // Replaces the space's show-rules document of own types (src/space-member-types.mjs documentMemberTypesOf).
  writeDocumentMemberTypes(spaceId, types) {
    this.sql.exec(`INSERT INTO space_show_rule_types (space_id, types) VALUES (?, ?)
      ON CONFLICT(space_id) DO UPDATE SET types = excluded.types`, spaceId, JSON.stringify(types));
  },

  /** A space's member types in the order they are offered: its label's, then its own. */
  memberTypesOf(space, communityConfigOverride) {
    const types = this.baseMemberTypesOf(space);
    // Community roles are types under the same rule owner. A role may inherit another role's permissions.
    const stored = communityConfigOverride === undefined ? this.sql.exec('SELECT config FROM communities WHERE id = ? LIMIT 1', space.id).toArray()[0] : null;
    const config = communityConfigOverride === undefined ? (stored ? JSON.parse(stored.config) : null) : communityConfigOverride;
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
  memberTypeIdsOf(space, typeId, override) {
    const types = override ?? this.memberTypesOf(space);
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

  // Each thing on a page as this reader sees it: what they may do to it, and a hidden thing's words only for those who
  // may show it again. One decision per distinct maker and origin on the page.
  async thingsAsSeenBy(space, relay, rows, nameOf, { fresh = true } = {}) {
    const decisions = new Map();
    const mayFor = row => {
      const key = `${row.contributed_by}\u0000${row.origin}`;
      if (!decisions.has(key)) decisions.set(key, this.mayIn(space, relay, ITEM_ACTIONS, { by: row.contributed_by, origin: row.origin }));
      return decisions.get(key);
    };
    return Promise.all(rows.map(async row => {
      let item = this.outwardItem(row, relay, nameOf);
      const thing = { by: row.contributed_by, origin: row.origin };
      const access = this.spaceAccessState(space.id, relay, thing);
      const may = row.withdrawn_at ? Object.fromEntries(ITEM_ACTIONS.map(id => [id, false])) : await mayFor(row);
      if (fresh && !row.withdrawn_at && row.origin === 'private' && row.source_ref && (!row.hidden_at || may.hide_item)) {
        let current = null;
        if (typeof this.releasePrivateSourceToSpace === 'function') {
          try {
            // The current source owner, not the Space snapshot or a Person actor,
            // resolves this reference through native custody and sharing rights.
            current = await this.releasePrivateSourceToSpace({ relay: row.contributed_by, private_ref: row.source_ref, space_id: space.id });
          } catch {
            // A missing, withdrawn or unavailable original source has no words
            // to show. The stored Space copy is never a fallback authority.
            current = null;
          }
        }
        this.assertSpaceAccessUnchanged(space.id, relay, access, thing);
        const stillShared = this.sql.exec('SELECT withdrawn_at, source_ref FROM space_items WHERE id = ? AND space_id = ?', row.id, space.id).toArray()[0];
        if (current?.private_ref === row.source_ref && current?.kind === row.kind && stillShared && !stillShared.withdrawn_at && stillShared.source_ref === row.source_ref) {
          item = { ...item, title: current.title ?? null, body: current.body ?? null };
        } else {
          item = { ...item, title: null, body: null };
        }
      }
      this.assertSpaceAccessUnchanged(space.id, relay, access, thing);
      if (!row.hidden_at || row.withdrawn_at) return { ...item, may };
      const hidden = { by: nameOf(row.hidden_by), at: row.hidden_at };
      return may.hide_item ? { ...item, may, hidden } : { ...item, title: null, body: null, may, hidden };
    }));
  },

  // Gives a member another of the space's types. Undone when it would leave nobody able to change who may do what.
  async setMemberType({ relay, space_id: spaceId, member_id: memberId, member_type: typeId }) {
    const space = await this.allowedInSpace(spaceId, relay, 'set_member_type');
    const types = this.memberTypesOf(space);
    const type = types.find(one => one.id === typeId);
    if (!type) throw new Error(`That is not a type in this space. Its types are: ${types.map(one => one.label).join(', ')}.`);
    const member = this.sql.exec("SELECT role FROM members WHERE membership_id = ? AND relay = ? AND state = 'member'", space.id, String(memberId ?? '')).toArray()[0];
    if (!member) throw new Error('That person is not in this space.');
    if (member.role === typeId) return this.readSpaceRules({ relay, space_id: space.id });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const accessState = this.spaceAccessState(space.id, relay);
      const before = this.currentMembers(space.id);
      const beforeState = JSON.stringify(before.map(row => [row.relay, row.role]));
      const stillMaySet = (await this.decideInSpace(space, relay, 'set_member_type')).allowed;
      const someoneCanChange = (await Promise.all(before.map(async row => (await this.decideInSpace(space, row.relay, 'change_rules', undefined, undefined,
        { memberTypeOverride: { relay: String(memberId), type: typeId } })).allowed))).some(Boolean);
      const current = this.currentMembers(space.id);
      if (beforeState !== JSON.stringify(current.map(row => [row.relay, row.role]))) continue;
      if (accessState !== this.spaceAccessState(space.id, relay)) continue;
      if (!stillMaySet) throw new Error('The pursuit’s rules no longer let you give people their type.');
      if (!someoneCanChange) throw new Error(`Nobody here could change who can do what if they were ${type.label}. Give someone else that first.`);
      this.sql.exec('UPDATE members SET role = ? WHERE membership_id = ? AND relay = ? AND state = \'member\'', typeId, space.id, String(memberId));
      this.spaceChanged(space.id);
      return this.readSpaceRules({ relay, space_id: space.id });
    }
    throw new Error('Space membership changed while this type was being given. Try again.');
  },

  // When the next page of legacy rows is due to be copied, now and then paced; null once the copy is complete.
  spaceMemberTypeCopyNextAt() {
    // reads-ok: one row by its primary key, the copy cursor.
    const cursor = this.sql.exec("SELECT next_at, done_at FROM space_member_type_copy WHERE id = 'rows'").toArray()[0];
    if (cursor.done_at) return null;
    return cursor.next_at ? Date.parse(cursor.next_at) : Date.now();
  },

  // Copies one page of legacy space_member_types rows into their space's show-rules document, from a cursor kept in
  // space_member_type_copy. A type already in the document is left as it is, so a repeated page changes nothing. Each
  // copied type is read back from the document before the cursor moves past it, and a mismatch fails the run.
  copySpaceMemberTypesPage() {
    // reads-ok: one row by its primary key, the copy cursor.
    const cursor = this.sql.exec("SELECT after_space_id, after_type_id, done_at FROM space_member_type_copy WHERE id = 'rows'").toArray()[0];
    if (cursor.done_at) return;
    const size = memberTypes.own_types.copy_rows_per_run;
    const rows = this.sql.exec(`SELECT space_id, type_id, label, added_by, added_at, inherits FROM space_member_types
      WHERE (space_id, type_id) > (?, ?) ORDER BY space_id, type_id LIMIT ?`, cursor.after_space_id, cursor.after_type_id, size).toArray();
    const documents = new Map();
    for (const row of rows) {
      const types = documents.get(row.space_id) ?? documentMemberTypesOf(this.sql, row.space_id);
      if (!types.some(type => type.id === row.type_id)) types.push({ id: row.type_id, label: row.label, inherits: JSON.parse(row.inherits || '[]'), added_by: row.added_by, added_at: row.added_at });
      documents.set(row.space_id, types);
    }
    for (const [spaceId, types] of documents) this.writeDocumentMemberTypes(spaceId, types);
    const readBack = new Map([...documents.keys()].map(spaceId => [spaceId, documentMemberTypesOf(this.sql, spaceId)]));
    for (const row of rows) {
      const copied = readBack.get(row.space_id).find(type => type.id === row.type_id);
      if (copied?.label !== row.label || JSON.stringify(copied.inherits) !== JSON.stringify(JSON.parse(row.inherits || '[]'))) {
        throw new Error(`Member type ${row.type_id} did not read back from its space after it was copied. Its copy waits to be tried again.`);
      }
    }
    const last = rows.at(-1);
    const finishedAt = rows.length < size ? new Date().toISOString() : null;
    const nextAt = finishedAt ? null : new Date(Date.now() + memberTypes.own_types.copy_pace_ms).toISOString();
    this.sql.exec("UPDATE space_member_type_copy SET after_space_id = ?, after_type_id = ?, done_at = ?, next_at = ? WHERE id = 'rows'",
      last?.space_id ?? cursor.after_space_id, last?.type_id ?? cursor.after_type_id, finishedAt, nextAt);
  },

  // Takes another member out of the space, for whoever its rules let remove_member (at first, its owner): the same as
  // their leaving, so what they put there stays and their agents there stop. Refused for oneself (that is leaving)
  // and when nobody left could change who may do what.
  async removeMember({ relay, space_id: spaceId, member_id: memberId }) {
    const space = await this.allowedInSpace(spaceId, relay, 'remove_member');
    const id = String(memberId ?? '');
    if (id === relay) throw new Error('To go yourself, leave the space.');
    if (!this.isMemberNow(space.id, id)) throw new Error('That person is not in this space.');
    const before = this.spaceAccessState(space.id, relay);
    const membersBefore = JSON.stringify(this.currentMembers(space.id));
    const staying = this.currentMembers(space.id).filter(row => row.relay !== id);
    if (!(await Promise.all(staying.map(async row => (await this.decideInSpace(space, row.relay, 'change_rules')).allowed))).some(Boolean)) {
      throw new Error('Nobody left could change who may do what. Give someone else that first.');
    }
    this.assertSpaceAccessUnchanged(space.id, relay, before);
    if (membersBefore !== JSON.stringify(this.currentMembers(space.id))) throw new Error('Space membership changed while this removal was checked. Try again.');
    await this.leave({ relay: id, membership_id: space.id });
    return { removed: id, space_id: space.id };
  },

  // Adds the space's own member type, by its name; it is offered wherever a type is chosen.
  async addMemberType({ relay, space_id: spaceId, label, inherits = [] }) {
    const space = await this.allowedInSpace(spaceId, relay, 'change_rules');
    const name = typeof label === 'string' ? label.trim() : '';
    if (!name || name.length > LIMITS.max_label) throw new Error(`A type needs a name of up to ${LIMITS.max_label} characters.`);
    const types = this.memberTypesOf(space);
    if (types.some(type => type.label.toLowerCase() === name.toLowerCase())) throw new Error(`This space already has a type called ${name}.`);
    if (types.filter(type => type.own).length >= LIMITS.max) throw new Error(`A space can add up to ${LIMITS.max} types of its own.`);
    const taken = new Set(types.map(type => type.id));
    if (!Array.isArray(inherits) || inherits.some(parent => typeof parent !== 'string' || !taken.has(parent))) {
      throw new Error(`inherits is a list of member type ids from this space: ${[...taken].join(', ')}.`);
    }
    let id = slug(name);
    for (let n = 2; taken.has(id); n += 1) id = `${slug(name)}-${n}`;
    const added = { id, label: name, inherits: [...new Set(inherits)], added_by: relay, added_at: new Date().toISOString() };
    this.writeDocumentMemberTypes(space.id, [...documentMemberTypesOf(this.sql, space.id), added]);
    this.spaceChanged(space.id);
    return this.readSpaceRules({ relay, space_id: space.id });
  },

  // Sets the space's starting member profile for future joiners. This is rule-owner work, separate from choosing a
  // role for one invitation, which remains guarded by set_member_type at invite creation.
  async setJoiningType({ relay, space_id: spaceId, member_type: typeId }) {
    const space = await this.allowedInSpace(spaceId, relay, 'change_rules');
    const types = this.memberTypesOf(space);
    if (typeof typeId !== 'string' || !types.some(type => type.id === typeId)) {
      throw new Error('Choose a member type already in this space.');
    }
    this.sql.exec(`INSERT INTO space_state (space_id, last_activity_at, joins_as)
      VALUES (?, COALESCE((SELECT created_at FROM memberships WHERE id = ?), ''), ?)
      ON CONFLICT(space_id) DO UPDATE SET joins_as = excluded.joins_as`, space.id, space.id, typeId);
    this.spaceChanged(space.id);
    return { space_id: space.id, joins_as: typeId };
  },

  // Renames a pursuit's own type or changes its parents. Evaluate the candidate graph before keeping it so the
  // change cannot leave the pursuit without anyone able to edit its rules.
  async updateMemberType({ relay, space_id: spaceId, member_type: typeId, label, inherits }) {
    const space = await this.allowedInSpace(spaceId, relay, 'change_rules');
    const name = typeof label === 'string' ? label.trim() : undefined;
    if (name !== undefined && (!name || name.length > LIMITS.max_label)) throw new Error(`A type needs a name of up to ${LIMITS.max_label} characters.`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Rebuild from the current graph on every attempt. In particular, an omitted parent list/label must preserve a
      // concurrent edit when a prior awaited rules decision detects a race and retries.
      const types = this.memberTypesOf(space);
      const current = types.find(type => type.id === typeId);
      if (!current) throw new Error('That is not a type in this space.');
      if (current.source === 'community') throw new Error(`${current.label} is a community role. Change community settings to edit its role.`);
      if (!current.own) throw new Error(`${current.label} comes with every space like this one, so it stays.`);
      const nextName = name ?? current.label;
      const nextParents = inherits === undefined ? current.inherits ?? [] : inherits;
      const taken = new Set(types.filter(type => type.id !== typeId).map(type => type.id));
      if (!Array.isArray(nextParents) || nextParents.some(parent => typeof parent !== 'string' || !taken.has(parent))) throw new Error(`inherits is a list of other member type ids from this space: ${[...taken].join(', ')}.`);
      if (types.some(type => type.id !== typeId && type.label.toLowerCase() === nextName.toLowerCase())) throw new Error(`This space already has a type called ${nextName}.`);
      const candidate = types.map(type => type.id === typeId ? { ...type, label: nextName, inherits: [...new Set(nextParents)] } : type);
      for (const type of candidate) inheritedMemberTypes(candidate, type.id);
      const access = this.spaceAccessState(space.id, relay);
      const beforeMembers = this.currentMembers(space.id);
      const beforeState = JSON.stringify(beforeMembers.map(row => [row.relay, row.role]));
      const stillMayChange = (await this.decideInSpace(space, relay, 'change_rules')).allowed;
      const someoneCanChange = (await Promise.all(beforeMembers.map(async row => (await this.decideInSpace(space, row.relay, 'change_rules', undefined, undefined, { memberTypesOverride: candidate })).allowed))).some(Boolean);
      if (beforeState !== JSON.stringify(this.currentMembers(space.id).map(row => [row.relay, row.role]))) continue;
      if (access !== this.spaceAccessState(space.id, relay)) continue;
      if (!stillMayChange) throw new Error('The pursuit’s rules no longer let you change member types.');
      if (!someoneCanChange) throw new Error('Nobody here could change who can do what with those type permissions. Keep a member who can edit the rules.');
      const document = documentMemberTypesOf(this.sql, space.id);
      if (document.some(type => type.id === typeId)) this.writeDocumentMemberTypes(space.id, document.map(type => type.id === typeId ? { ...type, label: nextName, inherits: [...new Set(nextParents)] } : type));
      // The row a type was copied from (or still waiting to be) follows the same change, so the copy never reads back stale.
      this.sql.exec('UPDATE space_member_types SET label = ?, inherits = ? WHERE space_id = ? AND type_id = ?', nextName, JSON.stringify([...new Set(nextParents)]), space.id, typeId);
      this.spaceChanged(space.id);
      return this.readSpaceRules({ relay, space_id: space.id });
    }
    throw new Error('Space permissions changed while this type was being changed. Try again.');
  },

  // Removes one of the space's own types while nobody holds it and no rule names it.
  async removeMemberType({ relay, space_id: spaceId, member_type: typeId }) {
    const space = await this.allowedInSpace(spaceId, relay, 'change_rules');
    const type = this.memberTypesOf(space).find(one => one.id === typeId);
    if (!type) throw new Error('That is not a type in this space.');
    if (type.source === 'community') throw new Error(`${type.label} is a community role. Change community settings to edit its role.`);
    if (!type.own) throw new Error(`${type.label} comes with every space like this one, so it stays.`);
    if (this.currentMembers(space.id).some(row => row.role === typeId)) throw new Error(`Someone here is ${type.label}. Give them another type first.`);
    if (this.joiningType(space.label, space.id) === typeId) throw new Error(`New people join as ${type.label}. Change that first.`);
    if (this.sql.exec('SELECT 1 FROM space_invites WHERE space_id = ? AND member_type = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? LIMIT 1', space.id, typeId, new Date().toISOString()).toArray().length) throw new Error(`An open invite gives people the ${type.label} type. Revoke it first.`);
    if (this.spaceRuleSet(space.id).rules.some(rule => namesType(rule, typeId))) throw new Error(`A rule names ${type.label}. Change that rule first.`);
    const types = this.memberTypesOf(space);
    if (types.some(row => row.id !== typeId && inheritedMemberTypes(types, row.id).includes(typeId))) throw new Error(`Another type inherits ${type.label}. Change that type first.`);
    const document = documentMemberTypesOf(this.sql, space.id);
    if (document.some(one => one.id === typeId)) this.writeDocumentMemberTypes(space.id, document.filter(one => one.id !== typeId));
    this.sql.exec('DELETE FROM space_member_types WHERE space_id = ? AND type_id = ?', space.id, typeId);
    this.spaceChanged(space.id);
    return this.readSpaceRules({ relay, space_id: space.id });
  },

  // Hides a thing from the space's lists, or shows it again. Its words stay, for whoever may show it again.
  async hideSpaceItem({ relay, space_id: spaceId, item_id: itemId, hidden }) {
    const row = this.sql.exec('SELECT contributed_by, origin, withdrawn_at, hidden_at FROM space_items WHERE id = ? AND space_id = ?', String(itemId ?? ''), String(spaceId ?? '')).toArray()[0];
    const space = await this.allowedInSpace(spaceId, relay, 'hide_item', row ? { by: row.contributed_by, origin: row.origin } : null);
    if (!row) throw new Error('No item with that id in this space.');
    if (row.withdrawn_at) throw new Error('That was taken back, so there is nothing to hide.');
    const hide = hidden !== false;
    if (Boolean(row.hidden_at) !== hide) {
      this.sql.exec('UPDATE space_items SET hidden_at = ?, hidden_by = ? WHERE id = ?', hide ? new Date().toISOString() : null, hide ? relay : null, itemId);
      this.spaceChanged(space.id);
    }
    return { item_id: itemId, hidden: hide };
  },
};
