import test from 'node:test';
import assert from 'node:assert/strict';
import recordModelData from '../src/community-membership-record-model.json' with { type: 'json' };
import { createCommunityMemberships } from '../read-data/community-memberships.mjs';
import { nativeCommunityEvents } from '../read-data/community-events.mjs';
import { handleCommunityEventRequest } from '../do-work/community-event-route.mjs';

const model = recordModelData.bindings;
const recordId = (name, fields) => model[name].id_pattern.replace(/\{([a-z][a-z0-9_]*)\}/g, (_whole, field) => encodeURIComponent(fields[field]));
const labelData = {
  community: { joined_by: 'rules', configuration: { title: 'Starting', join: [{ free: true }], spaces: { events: 'members' } } },
  project: { joined_by: 'invitation', configuration: { title: 'Project start' } },
};
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
};
const stableText = value => JSON.stringify(stable(value));

class MemoryDoor {
  records = new Map();
  writes = [];
  async readRecord(type, id) {
    const row = this.records.get(`${type}\0${id}`);
    return row ? structuredClone(row) : null;
  }
  async *list({ type, where = {} }) {
    for (const [key, row] of this.records) {
      if (!key.startsWith(`${type}\0`)) continue;
      if (Object.entries(where).every(([field, value]) => row.value[field] === value)) yield structuredClone(row);
    }
  }
  async write(rows, { key }) {
    const actual = rows.map(row => this.records.get(`${row.type}\0${row.id}`) ?? null);
    for (let i = 0; i < rows.length; i += 1) {
      const expected = rows[i].expected;
      if (expected === null ? actual[i] !== null
        : actual[i] === null || actual[i].type !== expected.type || stableText(actual[i].value) !== stableText(expected.value)) {
        throw Object.assign(new Error('record compare-and-swap conflict'), { code: 'original_command_conflict' });
      }
    }
    this.writes.push({ key, rows: structuredClone(rows) });
    for (const row of rows) {
      const id = `${row.type}\0${row.id}`;
      if (row.value === null) this.records.delete(id);
      else this.records.set(id, { type: row.type, id: row.id, value: structuredClone(row.value) });
    }
    return { changed: true, write_count: rows.length };
  }
  seed(type, id, value) { this.records.set(`${type}\0${id}`, { type, id, value: structuredClone(value) }); }
}

function store({ door = new MemoryDoor(), maxWrites = 256, acceptedInvitation } = {}) {
  let nextKey = 0;
  const memberships = createCommunityMemberships({
    door, model, membership_labels: labelData, acceptedInvitation, maxWrites,
    requestKey: () => `synthetic-community-action:${++nextKey}`,
  });
  return { door, memberships };
}

const seedSpace = (door, { id = 'space-1', label = 'community', title = 'A community', createdBy = 'relay-owner', member = 'relay-member', memberRow = true } = {}) => {
  door.seed(model.membership.type, recordId('membership', { id }), { id, label, title, created_by: createdBy, created_at: '2026-01-01T00:00:00.000Z' });
  if (memberRow) door.seed(model.member.type, recordId('member', { membership_id: id, relay: member }), { membership_id: id, relay: member, role: 'member', state: 'member', changed_at: '2026-01-01T00:00:00.000Z' });
};

test('reads the current membership row and uses label configuration only when no saved configuration exists', async () => {
  const { door, memberships } = store();
  seedSpace(door);
  const current = await memberships.readCommunity('space-1');
  assert.equal(current.config.title, 'A community');
  assert.equal(current.config.spaces.events, 'members');
  assert.equal(await memberships.activeMember(current, 'relay-member'), true);
  assert.equal(await memberships.activeMember(current, 'relay-absent'), false);

  door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
    id: 'space-1', config: { join: [{ invited: true }] }, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
  });
  const saved = await memberships.readCommunity('space-1');
  assert.deepEqual(saved.config, { join: [{ invited: true }], title: 'A community' });
  assert.equal(saved.updated_at, '2026-01-03T00:00:00.000Z');
});

test('events inherit join mode from their root membership and accepted invitation evidence is checked', async () => {
  const { door, memberships } = store({ acceptedInvitation: async (spaceId, relay) => spaceId === 'space-1' && relay === 'relay-invitee' });
  seedSpace(door, { memberRow: false });
  door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z' });
  door.seed(model.community.type, recordId('community', { id: 'space-1' }), { id: 'space-1', config: { join: [{ invited: true }] }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
  door.seed(model.member.type, recordId('member', { membership_id: 'space-1', relay: 'relay-invitee' }), { membership_id: 'space-1', relay: 'relay-invitee', role: 'member', state: 'member', changed_at: '2026-01-01T00:00:00.000Z' });
  const community = await memberships.readCommunity('space-1');
  assert.equal(community.joined_by_rules, true);
  assert.equal(await memberships.activeMember(community, 'relay-invitee'), true);
  assert.equal(await memberships.activeMember(community, 'relay-other'), false);
});

test('missing accepted-request owner does not block open spaces or explicit member invitation evidence', async () => {
  const door = new MemoryDoor();
  const memberships = createCommunityMemberships({
    door, model, membership_labels: labelData,
    requestKey: () => 'synthetic-community-action:no-request-owner',
  });
  seedSpace(door);
  const open = await memberships.readCommunity('space-1');
  assert.equal(await memberships.activeMember(open, 'relay-member'), true);

  door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
    id: 'space-1', config: { join: [{ invited: true }] }, created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  });
  const invitationOnly = await memberships.readCommunity('space-1');
  door.seed(model.member.type, recordId('member', { membership_id: 'space-1', relay: 'relay-marked' }), {
    membership_id: 'space-1', relay: 'relay-marked', role: 'member', state: 'member', admitted_by_invitation: true,
  });
  assert.equal(await memberships.activeMember(invitationOnly, 'relay-marked'), true);
  await assert.rejects(memberships.activeMember(invitationOnly, 'relay-member'), error => {
    assert.equal(error.status, 503);
    assert.equal(error.code, 'accepted_invitation_evidence_unavailable');
    return true;
  });
});

test('owner-scoped paid access fails closed when the matching offer came from a different owner', async () => {
  const { door, memberships } = store();
  seedSpace(door, { memberRow: false });
  door.seed(model.community.type, recordId('community', { id: 'space-1' }), { id: 'space-1', config: { join: [{ access: 'offer-1' }] }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' });
  const community = await memberships.readCommunity('space-1');
  door.seed(model.member.type, recordId('member', { membership_id: 'space-1', relay: 'relay-member' }), { membership_id: 'space-1', relay: 'relay-member', role: 'member', state: 'member', changed_at: '2026-01-01T00:00:00.000Z' });
  assert.equal(await memberships.activeMember(community, 'relay-member', [{ access: 'offer-1', by: 'relay-someone-else' }]), false);
  assert.equal(await memberships.activeMember(community, 'relay-member', [{ access: 'offer-1', by: 'relay-owner' }]), true);
});

test('invitation evidence grants only on an explicit boolean and unknown results perform no write', async () => {
  for (const evidence of [{ allowed: false }, {}, 'false', 1, undefined, null, false, true]) {
    const { door, memberships } = store({ acceptedInvitation: async () => evidence });
    seedSpace(door);
    door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
      id: 'space-1', config: { join: [{ invited: true }] },
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    });
    if (evidence === true) {
      assert.equal((await memberships.checkedMember('space-1', 'relay-member')).id, 'space-1');
    } else {
      await assert.rejects(memberships.checkedMember('space-1', 'relay-member'), error =>
        evidence === false
          ? error.status === 403 && error.code === 'community_membership_required'
          : error.status === 503 && error.code === 'accepted_invitation_evidence_unavailable');
    }
    assert.equal(door.writes.length, 0);
  }
});

test('nested work on separate records doors keeps each transaction in its own resource', async () => {
  const first = store(), second = store();
  const original = { id: 'event-shared', label: 'event', title: 'First resource', revision: 1 };
  const other = { ...original, title: 'Second resource' };
  first.door.seed(model.membership.type, recordId('membership', { id: original.id }), original);
  second.door.seed(model.membership.type, recordId('membership', { id: other.id }), other);
  await first.memberships.transaction(async () => {
    assert.equal((await first.memberships.read(original.id)).title, 'First resource');
    await second.memberships.transaction(async () => {
      assert.equal((await second.memberships.read(other.id)).title, 'Second resource');
      await second.memberships.putEvents([{ ...other, title: 'Changed second resource' }]);
    });
    await first.memberships.putEvents([{ ...original, title: 'Changed first resource' }]);
  });
  assert.equal((await first.memberships.read(original.id)).title, 'Changed first resource');
  assert.equal((await second.memberships.read(other.id)).title, 'Changed second resource');
  assert.equal(first.door.writes.length, 1);
  assert.equal(second.door.writes.length, 1);
});

test('unavailable holdings preserve independent grants and fail only when paid evidence is required', async () => {
  const owned = store();
  seedSpace(owned.door, { member: 'relay-owner', createdBy: 'relay-owner' });
  const ownedCommunity = await owned.memberships.readCommunity('space-1');
  assert.equal(await owned.memberships.activeMember(ownedCommunity, 'relay-owner', null), true);

  const project = store();
  seedSpace(project.door, { label: 'project' });
  const projectCommunity = await project.memberships.readCommunity('space-1');
  assert.equal(await project.memberships.activeMember(projectCommunity, 'relay-member', null), true);

  const free = store();
  seedSpace(free.door);
  const freeCommunity = await free.memberships.readCommunity('space-1');
  assert.equal(await free.memberships.activeMember(freeCommunity, 'relay-member', null), true);

  const invited = store();
  seedSpace(invited.door);
  invited.door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
    id: 'space-1', config: { join: [{ invited: true }] }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
  invited.door.seed(model.member.type, recordId('member', { membership_id: 'space-1', relay: 'relay-marked' }), {
    membership_id: 'space-1', relay: 'relay-marked', role: 'member', state: 'member', admitted_by_invitation: true,
  });
  const invitedCommunity = await invited.memberships.readCommunity('space-1');
  assert.equal(await invited.memberships.activeMember(invitedCommunity, 'relay-marked', null), true);

  const paid = store();
  seedSpace(paid.door);
  paid.door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
    id: 'space-1', config: { join: [{ access: 'offer-1' }] }, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
  const paidCommunity = await paid.memberships.readCommunity('space-1');
  await assert.rejects(paid.memberships.checkedMember('space-1', 'relay-member', null), error =>
    error.status === 503 && error.code === 'access_holdings_evidence_unavailable');
  assert.equal(paid.door.writes.length, 0);
});

test('membership and rule read failures throw instead of becoming confirmed absence', async () => {
  const door = new MemoryDoor();
  door.readRecord = async () => { throw new Error('records transport unavailable'); };
  const { memberships } = store({ door });
  await assert.rejects(memberships.readCommunity('space-1'), /records transport unavailable/);
  await assert.rejects(memberships.ensureRules('space-1', { rules: '[]', changed_at: '2026-01-01T00:00:00.000Z' }), /records transport unavailable/);
  assert.equal(door.writes.length, 0);
});

test('rule defaults are inserted only after confirmed absence, and a compare-and-swap race returns the stored winner', async () => {
  const seeded = store();
  const starting = { rules: '[{"id":"default"}]', changed_at: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(await seeded.memberships.ensureRules('space-1', starting), starting);
  assert.deepEqual(await seeded.memberships.rules('space-1'), starting);
  const stored = { rules: '[{"id":"custom"}]', changed_at: '2026-02-01T00:00:00.000Z' };
  seeded.door.seed(model.rules.type, recordId('rules', { id: 'space-1' }), { id: 'space-1', ...stored });
  const writeCount = seeded.door.writes.length;
  assert.deepEqual(await seeded.memberships.ensureRules('space-1', starting), stored);
  assert.equal(seeded.door.writes.length, writeCount);
  const raced = store();
  const winner = { rules: '[{"id":"other-writer"}]', changed_at: '2026-03-01T00:00:00.000Z' };
  raced.door.write = async () => {
    raced.door.seed(model.rules.type, recordId('rules', { id: 'space-1' }), { id: 'space-1', ...winner });
    throw Object.assign(new Error('record compare-and-swap conflict'), { code: 'original_command_conflict' });
  };
  assert.deepEqual(await raced.memberships.ensureRules('space-1', starting), winner);
});

test('one request can seed different spaces without reusing a write replay key for different records', async () => {
  const door = new MemoryDoor();
  const write = door.write.bind(door), receipts = new Map();
  door.write = async (rows, options) => {
    const body = stableText(rows);
    if (receipts.has(options.key)) {
      if (receipts.get(options.key) !== body) throw Object.assign(new Error('One replay key names different record writes.'), { code: 'original_command_conflict' });
      return { replayed: true };
    }
    const result = await write(rows, options);
    receipts.set(options.key, body);
    return result;
  };
  const memberships = createCommunityMemberships({
    door, model, membership_labels: labelData, requestKey: () => 'one-native-request',
  });
  const starting = { rules: '[]', changed_at: '2026-01-01T00:00:00.000Z' };
  await memberships.ensureRules('space-1', starting);
  await memberships.ensureRules('space-2', starting);
  assert.deepEqual(await memberships.rules('space-1'), starting);
  assert.deepEqual(await memberships.rules('space-2'), starting);
  await memberships.transaction(async () => {
    await memberships.ensureRules('space-3', starting);
    await memberships.ensureRules('space-4', starting);
  });
  assert.equal(door.writes.length, 3);
  assert.equal(door.writes[2].key, 'one-native-request', 'nested defaults stay in their original domain transaction');
});

test('a transaction reads its staged rule default while preserving the first committed snapshot for CAS', async () => {
  const { door, memberships } = store();
  const starting = { rules: '[{"id":"default"}]', changed_at: '2026-01-01T00:00:00.000Z' };
  const readBack = await memberships.transaction(async () => {
    assert.deepEqual(await memberships.ensureRules('space-1', starting), starting);
    assert.deepEqual(await memberships.ensureRules('space-1', {
      rules: '[{"id":"competing-staged-default"}]',
      changed_at: '2026-02-01T00:00:00.000Z',
    }), starting);
    return memberships.rules('space-1');
  });
  assert.deepEqual(readBack, starting);
  assert.equal(door.writes.length, 1);
  assert.equal(door.writes[0].rows[0].expected, null);
});

test('read and list snapshots carry real optional record identity into expected conditions', async () => {
  const { door, memberships } = store();
  const id = recordId('membership', { id: 'event-identity' });
  door.records.set(`${model.membership.type}\0${id}`, {
    type: model.membership.type,
    id,
    value: { id: 'event-identity', label: 'event', revision: 1 },
    identity: 'opaque-record-identity',
  });
  await memberships.transaction(() => memberships.putEvents([
    { id: 'event-identity', label: 'event', revision: 2 },
  ]));
  assert.equal(door.writes[0].rows[0].expected.identity, 'opaque-record-identity');

  const secondId = recordId('member', { membership_id: 'event-identity', relay: 'relay-a' });
  door.records.set(`${model.member.type}\0${secondId}`, {
    type: model.member.type,
    id: secondId,
    value: { membership_id: 'event-identity', relay: 'relay-a', state: 'member' },
    identity: 'opaque-member-identity',
  });
  await memberships.transaction(() => memberships.removeEvent('event-identity'));
  assert.ok(door.writes[1].rows.some(row => row.expected?.identity === 'opaque-member-identity'));
});

test('the native RSVP action preserves unavailable invitation evidence as 503 and performs no write', async () => {
  const door = new MemoryDoor();
  const memberships = createCommunityMemberships({
    door, model, membership_labels: labelData,
    requestKey: () => 'synthetic-community-action:unavailable-invitation',
  });
  seedSpace(door, { memberRow: false });
  door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
    id: 'space-1', config: { join: [{ invited: true }], spaces: { events: 'members' } },
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  });
  door.seed(model.member.type, recordId('member', { membership_id: 'space-1', relay: 'relay-invitee' }), {
    membership_id: 'space-1', relay: 'relay-invitee', role: 'member', state: 'member', changed_at: '2026-01-01T00:00:00.000Z',
  });
  door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), {
    id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner',
    created_at: '2026-01-01T00:00:00.000Z', revision: 1,
  });
  await assert.rejects(memberships.checkedMember('space-1', 'relay-invitee'), error => error.status === 503
    && error.code === 'accepted_invitation_evidence_unavailable');
  const resource = 'space:space-1';
  const owner = nativeCommunityEvents({
    memberships, resource,
    principal: () => ({ resource, relay: 'relay-invitee', holds: [], actor: { kind: 'account', id: 'account-1' } }),
    current: async () => true, readCommunity: memberships.readCommunity, activeMember: memberships.activeMember,
    checkedMember: memberships.checkedMember, checkedMay: memberships.checkedMember,
    mayIn: async () => ({ put_on_events: false }), spaceChanged: () => {}, tellEventCalendars: () => {},
    tellMembersOfMeetingChange: () => {}, calendarOrganizer: () => ({ name: 'Host', email: 'host@example.test' }),
    calendarUid: id => `${id}@example.test`,
  });
  await assert.rejects(owner.rsvp({ event_id: 'event-1', going: true }), error => {
    assert.equal(error.message, 'The current network invitation owner could not verify accepted invitation evidence.');
    assert.equal(error.code, 'accepted_invitation_evidence_unavailable');
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(door.writes.length, 0);
});

test('the real RSVP request consumer uses admitted owner-scoped paid evidence and refuses unavailable or foreign grants', async () => {
  for (const holds of [null, [{ access: 'offer-1', by: 'foreign-owner' }], [{ access: 'offer-1', by: 'relay-owner' }]]) {
    const { door, memberships } = store();
    seedSpace(door);
    door.seed(model.community.type, recordId('community', { id: 'space-1' }), {
      id: 'space-1', config: { join: [{ access: 'offer-1' }], spaces: { events: 'members' } },
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    });
    door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), {
      id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner',
      created_at: '2026-01-01T00:00:00.000Z', starts_at: '2026-03-01T12:00:00.000Z', revision: 1,
    });
    const effects = [], resource = 'synthetic-community-resource';
    // These are explicitly synthetic admitted holdings. This fixture does not
    // supply or qualify the missing native buyer/grantor identity bridge.
    const owner = nativeCommunityEvents({
      memberships, resource,
      principal: () => ({ resource, relay: 'relay-member', holds, actor: { kind: 'account', id: 'synthetic-account' } }),
      current: async () => true, readCommunity: memberships.readCommunity, activeMember: memberships.activeMember,
      checkedMember: memberships.checkedMember, checkedMay: memberships.checkedMember,
      mayIn: async () => ({ put_on_events: false }),
      spaceChanged: () => effects.push('space'), tellEventCalendars: () => effects.push('calendar'),
      tellMembersOfMeetingChange: () => effects.push('message'),
      calendarOrganizer: () => ({ name: 'Host', email: 'host@example.test' }), calendarUid: id => `${id}@example.test`,
    });
    const response = await handleCommunityEventRequest(owner, new Request('https://synthetic.invalid/community/events/event-1/rsvp', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ going: true, holds: [{ access: 'offer-1', by: 'relay-owner' }], relay: 'relay-owner' }),
    }), async () => ({ relay: 'relay-member', holds }));
    const answer = await response.json();
    if (holds === null) {
      assert.equal(response.status, 503);
      assert.equal(answer.code, 'access_holdings_evidence_unavailable');
    } else if (holds[0].by === 'foreign-owner') {
      assert.equal(response.status, 403);
      assert.equal(answer.code, 'community_membership_required');
    } else {
      assert.equal(response.status, 200);
      assert.deepEqual(answer, { event_id: 'event-1', going: true });
      assert.equal((await memberships.member('event-1', 'relay-member')).state, 'member');
      assert.equal(await memberships.member('event-1', 'relay-owner'), null);
      assert.equal((await memberships.read('event-1')).revision, 2);
      assert.deepEqual(effects, ['calendar']);
      continue;
    }
    assert.equal(await memberships.member('event-1', 'relay-member'), null);
    assert.equal((await memberships.read('event-1')).revision, 1);
    assert.equal(door.writes.length, 0);
    assert.deepEqual(effects, []);
  }
});

test('missing communities are 404 and completed membership denials are 403', async () => {
  const { memberships } = store();
  await assert.rejects(memberships.checkedMember('missing-space', 'relay-member'), error => {
    assert.equal(error.status, 404);
    assert.equal(error.code, 'community_not_found');
    return true;
  });
  const denied = store();
  seedSpace(denied.door, { memberRow: false });
  await assert.rejects(denied.memberships.checkedMember('space-1', 'relay-absent'), error => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'community_membership_required');
    return true;
  });
});

test('fresh accessState detects permission changes and point-rule CAS rejects a stale RSVP', async () => {
  const { door, memberships } = store();
  seedSpace(door);
  door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z', starts_at: '2026-03-01T12:00:00.000Z', size_limit: 2, revision: 1 });
  door.seed(model.rules.type, recordId('rules', { id: 'space-1' }), { id: 'space-1', rules: '[{"id":"allow-rsvp"}]', changed_at: '2026-01-01T00:00:00.000Z' });
  const before = await memberships.accessState('space-1', 'relay-member');
  door.seed(model.rules.type, recordId('rules', { id: 'space-1' }), { id: 'space-1', rules: '[{"id":"deny-rsvp"}]', changed_at: '2026-02-01T00:00:00.000Z' });
  const after = await memberships.accessState('space-1', 'relay-member');
  assert.notEqual(after, before);
  // A point-rule condition still has a real CAS path. The separate complete
  // graph dependency is unavailable rather than falsely called a point CAS.
  await assert.rejects(memberships.transaction(async () => {
    await memberships.rules('space-1');
    door.seed(model.rules.type, recordId('rules', { id: 'space-1' }), { id: 'space-1', rules: '[{"id":"newer-denial"}]', changed_at: '2026-02-02T00:00:00.000Z' });
    await memberships.putMember({ membership_id: 'event-1', relay: 'relay-member', role: 'going', state: 'member', changed_at: '2026-02-02T00:00:00.000Z' });
  }), /compare-and-swap conflict/);
  assert.equal(await memberships.member('event-1', 'relay-member'), null);
});

test('an unfenced permission collection refuses a dependent write before the records door, with or without an insertion', async () => {
  for (const insert of [false, true]) {
    const { door, memberships } = store();
    seedSpace(door);
    door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', revision: 1 });
    await assert.rejects(memberships.transaction(async () => {
      await memberships.accessState('space-1', 'relay-member');
      if (insert) door.seed(model.own_member_type.type, recordId('own_member_type', { space_id: 'space-1', type_id: 'new-type' }), { space_id: 'space-1', type_id: 'new-type', label: 'New type', inherits: [] });
      await memberships.putMember({ membership_id: 'event-1', relay: 'relay-member', role: 'going', state: 'member', changed_at: '2026-02-01T00:00:00.000Z' });
    }), error => error.status === 503 && error.code === 'community_collection_snapshot_unavailable');
    assert.equal(door.writes.length, 0);
    assert.equal(await memberships.member('event-1', 'relay-member'), null);
    assert.equal((await memberships.read('event-1')).revision, 1);
  }
});

test('permission collection reads remain available without writing captured authorization rows', async () => {
  const { door, memberships } = store();
  seedSpace(door);
  assert.equal(typeof await memberships.accessState('space-1', 'relay-member'), 'string');
  assert.deepEqual(await memberships.ownMemberTypes('space-1'), []);
  assert.equal(typeof await memberships.transaction(() => memberships.accessState('space-1', 'relay-member')), 'string');
  assert.equal(door.writes.length, 0);
});

test('a post-snapshot own-member-type insertion must invalidate the event write', { todo: 'native atomic collection witness is not bound; the interim adapter returns unavailable instead' }, async () => {
  const { door, memberships } = store();
  seedSpace(door);
  door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z', revision: 1 });
  await assert.rejects(memberships.transaction(async () => {
    await memberships.accessState('space-1', 'relay-member');
    door.seed(model.own_member_type.type, recordId('own_member_type', { space_id: 'space-1', type_id: 'new-type' }), { space_id: 'space-1', type_id: 'new-type', label: 'New type', inherits: [] });
    await memberships.putMember({ membership_id: 'event-1', relay: 'relay-member', role: 'going', state: 'member', changed_at: '2026-02-01T00:00:00.000Z' });
  }), error => error?.code === 'original_command_conflict');
});

test('concurrent last-seat RSVPs serialize on event.revision in one compare-and-swap batch', async () => {
  const { door, memberships } = store();
  door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z', size_limit: 1, revision: 1 });
  let arrivals = 0, release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const attempt = relay => memberships.transaction(async () => {
    const event = await memberships.read('event-1');
    const attending = (await memberships.members('event-1')).filter(row => row.state === 'member');
    arrivals += 1;
    if (arrivals === 2) release();
    await bothRead;
    if (event.size_limit && attending.length >= event.size_limit) throw new Error('full');
    await memberships.putMember({ membership_id: 'event-1', relay, role: 'going', state: 'member', changed_at: '2026-02-01T00:00:00.000Z' });
  });
  const results = await Promise.allSettled([attempt('relay-a'), attempt('relay-b')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, JSON.stringify(results.map(result => result.status === 'rejected' ? String(result.reason?.stack ?? result.reason) : 'fulfilled')));
  assert.equal(results.filter(result => result.status === 'rejected' && /compare-and-swap conflict/.test(result.reason.message)).length, 1);
  assert.equal((await memberships.members('event-1')).filter(row => row.state === 'member').length, 1);
  assert.equal((await memberships.read('event-1')).revision, 2);
});

test('event removal deletes the event and its RSVP rows in one batch, or refuses before a partial delete', async () => {
  const { door, memberships } = store({ maxWrites: 3 });
  door.seed(model.membership.type, recordId('membership', { id: 'event-1' }), { id: 'event-1', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z', revision: 1 });
  for (const relay of ['relay-a', 'relay-b']) door.seed(model.member.type, recordId('member', { membership_id: 'event-1', relay }), { membership_id: 'event-1', relay, role: 'going', state: 'member', changed_at: '2026-01-01T00:00:00.000Z' });
  await memberships.transaction(() => memberships.removeEvent('event-1'));
  assert.equal(await memberships.read('event-1'), null);
  assert.deepEqual(await memberships.members('event-1'), []);
  assert.equal(door.writes.at(-1).rows.length, 3);

  const tooMany = store({ maxWrites: 2 });
  tooMany.door.seed(model.membership.type, recordId('membership', { id: 'event-2' }), { id: 'event-2', label: 'event', parent_id: 'space-1', title: 'Event', created_by: 'relay-owner', created_at: '2026-01-01T00:00:00.000Z', revision: 1 });
  for (const relay of ['relay-a', 'relay-b']) tooMany.door.seed(model.member.type, recordId('member', { membership_id: 'event-2', relay }), { membership_id: 'event-2', relay, role: 'going', state: 'member', changed_at: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(tooMany.memberships.transaction(() => tooMany.memberships.removeEvent('event-2')), /atomic record writes/);
  assert.ok(await tooMany.memberships.read('event-2'));
  assert.equal(tooMany.door.writes.length, 0);
});
