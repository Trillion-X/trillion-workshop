import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeCommunityEvents } from '../read-data/community-events.mjs';
import { checkedMemberDecision } from '../read-data/community-access.mjs';

function fixture(overrides = {}) {
  const events = new Map(), members = new Map(), calls = [], admissions = [];
  let queue = Promise.resolve();
  let relay = 'host', allowed = new Set(['host']), serial = 0;
  const community = { id: 'space', config: { title: 'Shared learning', spaces: { events: 'members' } } };
  const clone = value => value == null ? value : structuredClone(value);
  const key = (id, person) => JSON.stringify([id, person]);
  const roster = new Map(['host', 'member', 'other'].map(person => [key('space', person),
    { membership_id: 'space', relay: person, role: 'member', state: 'member' }]));
  const memberships = {
    read: id => clone(events.get(id)),
    events: parent => [...events.values()].filter(row => row.parent_id === parent).map(clone),
    member: (id, person) => clone((id === community.id ? roster : members).get(key(id, person))),
    members: id => [...members.values()].filter(row => row.membership_id === id).map(clone),
    putEvents: rows => { for (const row of rows) events.set(row.id, clone(row)); },
    putMember: row => members.set(key(row.membership_id, row.relay), clone(row)),
    removeEvent: id => {
      events.delete(id);
      for (const [entry, row] of members) if (row.membership_id === id) members.delete(entry);
    },
    transaction: async run => {
      const previous = queue;
      let release;
      queue = new Promise(resolve => { release = resolve; });
      await previous;
      const heldEvents = clone([...events]), heldMembers = clone([...members]);
      try { return await run(); }
      catch (error) {
        events.clear(); members.clear();
        for (const [id, row] of heldEvents) events.set(id, row);
        for (const [id, row] of heldMembers) members.set(id, row);
        throw error;
      } finally { release(); }
    },
  };
  const checkedMay = async (id, person, action, holds = []) => {
    if (id !== community.id) throw new Error('No space.');
    const space = await checkedMemberDecision({ community: clone(community), relay: person, holds, member: memberships.member(id, person) });
    if (action !== 'put_on_events' || !allowed.has(person)) throw Object.assign(new Error('No event permission.'), { status: 403 });
    return clone(space);
  };
  const readSpace = id => {
    if (id !== community.id) throw new Error('No space.');
    return clone(community);
  };
  const owner = nativeCommunityEvents({
    memberships, resource: 'space:space',
    principal: () => ({ resource: 'space:space', relay, holds: [], actor: relay ? { kind: 'account', id: relay } : undefined }),
    current: async (operation, input) => { admissions.push({ operation, input }); return true; },
    readCommunity: readSpace, communityValue: readSpace, checkedMay,
    mayIn: (_community, person) => ({ put_on_events: allowed.has(person) }),
    spaceChanged: (...args) => calls.push({ kind: 'changed', args }),
    tellEventCalendars: (spaceId, eventIds, onlyRelay, options, delivery) => calls.push({
      kind: 'calendars', args: [spaceId, eventIds, onlyRelay, options], delivery,
      captured: eventIds.every(id => delivery.events.some(row => row.id === id)),
      persisted: eventIds.every(id => events.has(id)),
    }),
    tellMembersOfMeetingChange: input => calls.push({ kind: 'message', input }),
    calendarUid: id => id + '@community.example.test',
    calendarOrganizer: () => ({ name: 'Our host', email: 'host@example.test' }),
    now: () => '2026-10-30T12:00:00.000Z',
    newId: prefix => prefix + '_' + ++serial,
    ...overrides,
  });
  const create = input => owner.createEvent({ community_id: 'space', title: 'Meet', starts_at: '2026-10-31T22:00:00Z',
    ends_at: '2026-10-31T23:30:00Z', ...input });
  return { owner, create, events, members, calls, admissions, memberships, community,
    use: person => { relay = person; }, allow: person => allowed.add(person), leave: person => roster.set(key('space', person), { membership_id: 'space', relay: person, role: 'member', state: 'left' }) };
}

test('creation persists original membership rows and recurring times in one series through the callable native owner', async () => {
  const f = fixture();
  const result = await f.create({ title: '  Weekly meeting  ', about: '  Bring notes  ',
    repeats: { every: 'week', count: 3, time_zone: 'America/New_York' } });
  assert.equal(result.event_ids.length, 3);
  assert.equal(new Set([...f.events.values()].map(row => row.series_id)).size, 1);
  assert.deepEqual([...f.events.values()].map(row => row.starts_at), [
    '2026-10-31T22:00:00.000Z', '2026-11-07T23:00:00.000Z', '2026-11-14T23:00:00.000Z',
  ]);
  for (const row of f.events.values()) {
    assert.equal(row.label, 'event');
    assert.equal(row.parent_id, 'space');
    assert.equal(row.created_by, 'host');
    assert.equal(row.title, 'Weekly meeting');
    assert.equal(row.about, 'Bring notes');
    assert.equal(Date.parse(row.ends_at) - Date.parse(row.starts_at), 90 * 60000);
  }
  assert.deepEqual(f.calls.map(call => call.kind), ['changed', 'calendars']);
  assert.deepEqual(f.calls[1].args.slice(0, 2), ['space', result.event_ids]);
  assert.equal(f.admissions[0].operation, 'community:createEvent');
  assert.equal((await f.owner.invoke('community:spaceEvents', { community_id: 'space' })).events.length, 3);
  await assert.rejects(async () => f.owner.invoke('community:missing', {}), /not installed/);
});

test('required adapters fail closed and input relay/holds never impersonate the principal', async () => {
  assert.throws(() => nativeCommunityEvents({}), /require/);
  const f = fixture();
  f.use('member');
  await assert.rejects(f.create({ relay: 'host', holds: [{ access: 'invented' }] }), /permission/);
  assert.equal(f.events.size, 0);
  assert.equal(f.calls.length, 0);
  const bad = fixture({ principal: () => ({ resource: 'wrong', relay: 'host', holds: [] }) });
  await assert.rejects(bad.create({}), /admitted resource principal/);
  const refused = fixture({ current: async () => { throw new Error('Permit revoked.'); } });
  await assert.rejects(refused.create({}), /revoked/);
  assert.equal(refused.events.size, 0);
  const ungranted = fixture({ checkedMay: () => false });
  await assert.rejects(ungranted.create({}), /did not grant/);
  assert.equal(ungranted.events.size, 0);
});

test('a principal change during permission lookup cannot write a membership', async () => {
  let who = 'host';
  const f = fixture({
    principal: () => ({ resource: 'space:space', relay: who, holds: [], actor: { kind: 'account', id: who } }),
    checkedMay: async () => { who = 'intruder'; return {}; },
  });
  await assert.rejects(f.create({}), /principal changed/);
  assert.equal(f.events.size, 0);
});

test('visibility, overlap boundaries, RSVP state and actionable move permissions share the same membership rows', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({});
  f.use('member');
  await f.owner.rsvp({ event_id: id, going: true });
  const read = () => f.owner.spaceEvents({ community_id: 'space', from: '2026-10-31T23:30:00Z', to: '2026-11-01T00:00:00Z' });
  const found = await read();
  assert.equal(found.events.length, 1, 'an end at the lower bound overlaps');
  assert.equal(found.events[0].you_are_going, true);
  assert.equal(found.events[0].may_move, false);
  assert.equal((await f.owner.spaceEvents({ community_id: 'space', to: '2026-10-31T22:00:00Z' })).events.length, 0,
    'a start at the upper bound is excluded');
  f.use(null);
  assert.equal((await read()).events.length, 0);
  f.community.config.spaces.events = 'everyone';
  const publicRead = await read();
  assert.equal(publicRead.events[0].you_are_going, false);
  assert.equal(publicRead.events[0].may_move, false);
  assert.equal('created_by' in publicRead.events[0], false);
  assert.equal('relay' in publicRead.events[0], false);
  f.community.config.spaces = {};
  f.use('member');
  assert.equal((await read()).events.length, 1, 'space members see meetings even without an events page');
  await assert.rejects(f.owner.eventFile({ event_id: id }), /Only members see/);
});

test('creator still needs current membership; delegated permission can move another creator event only in its own space', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({});
  f.use('member');
  await assert.rejects(f.owner.moveEvent({ community_id: 'space', event_id: id, title: 'Changed' }), /permission/);
  await assert.rejects(f.owner.cancelEvent({ community_id: 'other-space', event_id: id }), /No event/);
  f.allow('member');
  await f.owner.moveEvent({ community_id: 'space', event_id: id, title: 'Allowed' });
  assert.equal(f.events.get(id).title, 'Allowed');
  f.use('host');
  f.leave('host');
  await assert.rejects(f.owner.moveEvent({ community_id: 'space', event_id: id, title: 'Gone' }), /Only members/);
  await assert.rejects(f.owner.cancelEvent({ community_id: 'space', event_id: id }), /Only members/);
  assert.equal(f.events.get(id).title, 'Allowed');
});

test('move keeps duration, null removes the end, bad ranges do not write, and notifications honor quiet and time changes', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({});
  const move = input => f.owner.moveEvent({ community_id: 'space', event_id: id, ...input });
  await move({ starts_at: '2026-11-01T22:00:00Z', title: 'Moved' });
  assert.equal(f.events.get(id).ends_at, '2026-11-01T23:30:00.000Z');
  assert.deepEqual(f.calls.filter(call => call.kind === 'message').map(call => call.input),
    [{ relay: 'host', space_id: 'space', change: 'moved', title: 'Moved' }]);
  await move({ title: 'Words only', about: '   ' });
  assert.equal(f.events.get(id).about, null);
  assert.equal(f.calls.filter(call => call.kind === 'message').length, 1);
  await move({ starts_at: '2026-11-02T22:00:00Z', quiet: true });
  assert.equal(f.calls.filter(call => call.kind === 'message').length, 1);
  await move({ ends_at: null });
  assert.equal(f.events.get(id).ends_at, null);
  await move({ starts_at: '2026-11-03T22:00:00Z' });
  assert.equal(f.events.get(id).ends_at, null);
  const before = structuredClone(f.events.get(id));
  await assert.rejects(move({ ends_at: '2026-11-03T21:00:00Z' }), /ends after/);
  await assert.rejects(move({ starts_at: null }), /starts_at/);
  await assert.rejects(move({ ends_at: '' }), /ends_at/);
  assert.deepEqual(f.events.get(id), before);
});

test('capacity and retries count active RSVP rows; declining is kept even before a yes and calendar refresh targets that member', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({ size_limit: 1 });
  f.use('member');
  await f.owner.rsvp({ event_id: id, going: true });
  await f.owner.rsvp({ event_id: id, going: true });
  assert.equal(f.members.size, 1);
  f.use('other');
  await assert.rejects(f.owner.rsvp({ event_id: id, going: true }), /full/);
  await f.owner.rsvp({ event_id: id, going: false });
  assert.equal(f.memberships.member(id, 'other').state, 'left');
  f.use('member');
  await f.owner.rsvp({ event_id: id, going: false });
  f.use('other');
  await f.owner.rsvp({ event_id: id, going: true });
  assert.equal(f.memberships.members(id).filter(row => row.state === 'member').length, 1);
  assert.deepEqual(f.calls.at(-1).args.slice(0, 3), ['space', [id], 'other']);
  f.leave('other');
  await assert.rejects(f.owner.rsvp({ event_id: id, going: false }), /Only members/);
});

test('concurrent last-seat requests serialize their capacity check and write in the supplied transaction', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({ size_limit: 1 });
  // Two current command owners share the same membership owner, as two admitted
  // native invocations do; each principal remains stable during its own call.
  const other = fixture({ memberships: f.memberships,
    principal: () => ({ resource: 'space:space', relay: 'other', holds: [], actor: { kind: 'person', id: 'other' } }) });
  f.use('member');
  const outcomes = await Promise.allSettled([
    f.owner.rsvp({ event_id: id, going: true }), other.owner.rsvp({ event_id: id, going: true }),
  ]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(row => row.status === 'rejected' && /full/.test(row.reason.message)).length, 1);
  assert.equal(f.memberships.members(id).filter(row => row.state === 'member').length, 1);
});

test('cancellation captures existing calendar notices, atomically removes RSVP rows, then updates and notifies the space', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({});
  await f.owner.rsvp({ event_id: id, going: true });
  f.calls.length = 0;
  assert.deepEqual(await f.owner.cancelEvent({ community_id: 'space', event_id: id }), { event_id: id, cancelled: true });
  assert.equal(f.events.has(id), false);
  assert.equal(f.memberships.members(id).length, 0);
  assert.deepEqual(f.calls.map(call => call.kind), ['calendars', 'changed', 'message']);
  assert.equal(f.calls[0].captured, true);
  assert.equal(f.calls[0].persisted, false, 'the captured snapshot delivers only after cancellation commits');
  assert.deepEqual(f.calls[0].args, ['space', [id], null, { cancelled: true }]);
  assert.equal(f.calls[2].input.change, 'cancelled');
  await assert.rejects(f.owner.eventFile({ event_id: id }), /No community event/);
});

test('calendar file uses the shared invitation exporter, stable UID, organizer, visibility and default length; sends nothing', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({ ends_at: null, about: 'Join us' });
  f.calls.length = 0;
  const file = await f.owner.eventFile({ event_id: id });
  assert.match(file, new RegExp('UID:' + id + '@community.example.test'));
  assert.match(file, /METHOD:REQUEST/);
  assert.match(file, /DTSTART:20261031T220000Z/);
  assert.match(file, /DTEND:20261031T230000Z/);
  assert.match(file, /ORGANIZER;CN=Our host:mailto:host@example.test/);
  assert.match(file, /DESCRIPTION:Join us\\n\\nShared learning/);
  assert.equal(f.calls.length, 0);
  f.use(null);
  await assert.rejects(f.owner.eventFile({ event_id: id }), /Only members see/);
  f.community.config.spaces.events = 'everyone';
  assert.match(await f.owner.eventFile({ event_id: id }), /BEGIN:VCALENDAR/);
});

test('explicit zero duration stays zero when moved and exports as an instantaneous date-time event', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({ ends_at: '2026-10-31T22:00:00Z' });
  assert.equal(f.events.get(id).starts_at, f.events.get(id).ends_at);
  let file = await f.owner.eventFile({ event_id: id });
  assert.match(file, /DTSTART:20261031T220000Z/);
  assert.doesNotMatch(file, /(?:DTEND|DURATION):/);
  await f.owner.moveEvent({ community_id: 'space', event_id: id, starts_at: '2026-11-01T22:00:00Z' });
  assert.equal(f.events.get(id).starts_at, f.events.get(id).ends_at);
  file = await f.owner.eventFile({ event_id: id });
  assert.match(file, /DTSTART:20261101T220000Z/);
  assert.doesNotMatch(file, /(?:DTEND|DURATION):/);
});

test('post-write delivery errors retain committed outcomes for native command recovery, including cancellation', async () => {
  const f = fixture({ tellEventCalendars: async () => { throw new Error('Synthetic calendar unavailable.'); } });
  let failure;
  try { await f.create({}); } catch (error) { failure = error; }
  assert.equal(failure.committed, true);
  assert.equal(failure.effect, 'calendars');
  const id = failure.result.event_id;
  assert.equal(f.events.has(id), true);
  let cancellation;
  try { await f.owner.cancelEvent({ community_id: 'space', event_id: id }); } catch (error) { cancellation = error; }
  assert.equal(cancellation.committed, true);
  assert.deepEqual(cancellation.result, { event_id: id, cancelled: true });
  assert.equal(f.events.has(id), false, 'committed cancellation is retained even when calendar delivery needs recovery');
});

test('a stale event after asynchronous permission checks cannot overwrite a newer move', async () => {
  let wait = false, entered, continuePermission;
  const waiting = new Promise(resolve => { entered = resolve; });
  const f = fixture({ checkedMay: async () => {
    if (wait) { entered(); await new Promise(resolve => { continuePermission = resolve; }); }
    return { id: 'space', config: { title: 'Shared learning', spaces: { events: 'members' } } };
  } });
  const { event_id: id } = await f.create({});
  f.use('member');
  // The direct concurrent writer models another committed owner, so this
  // case uses optimistic conflict detection rather than the fixture's lock.
  f.memberships.transaction = run => run();
  wait = true;
  const moving = f.owner.moveEvent({ community_id: 'space', event_id: id, title: 'Stale' });
  await waiting;
  f.memberships.putEvents([{ ...f.events.get(id), title: 'Newer' }]);
  continuePermission();
  await assert.rejects(moving, /event changed/);
  assert.equal(f.events.get(id).title, 'Newer');
});

test('invalid starts, end ranges, and titles are rejected before creating any event', async () => {
  const f = fixture();
  for (const input of [{ starts_at: null }, { starts_at: 'not a time' }, { title: '  ' },
    { ends_at: '2026-10-31T20:00:00Z' }, { size_limit: 0 }]) await assert.rejects(f.create(input));
  assert.equal(f.events.size, 0);
  assert.equal(f.calls.length, 0);
});

test('an asynchronous atomic commit finishes before any calendar or notification callback', async () => {
  const f = fixture();
  const original = f.memberships.transaction;
  let entered, commit;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.memberships.transaction = async run => {
    const result = await original(run);
    entered();
    await new Promise(resolve => { commit = resolve; });
    return result;
  };
  const creating = f.create({});
  await waiting;
  assert.equal(f.calls.length, 0);
  commit();
  const result = await creating;
  assert.equal(f.events.has(result.event_id), true);
  assert.deepEqual(f.calls.map(call => call.kind), ['changed', 'calendars']);
});

test('a failed series write rolls back all event rows and sends no effects', async () => {
  const persisted = fixture();
  const memberships = {
    ...persisted.memberships,
    putEvents: rows => {
      persisted.memberships.putEvents(rows.slice(0, 1));
      throw new Error('Synthetic write failure.');
    },
  };
  const f = fixture({ memberships });
  await assert.rejects(f.create({ repeats: { every: 'week', count: 3, time_zone: 'America/New_York' } }), /write failure/);
  assert.equal(persisted.events.size, 0);
  assert.equal(f.calls.length, 0);
});

test('a principal change only after commit retains the created event outcome without replaying writes', async () => {
  let person = 'host', writes = 0;
  const f = fixture({ principal: () => ({ resource: 'space:space', relay: person, holds: [], actor: { kind: 'account', id: person } }) });
  const originalWrite = f.memberships.putEvents;
  f.memberships.putEvents = rows => { writes += 1; return originalWrite(rows); };
  const originalTransaction = f.memberships.transaction;
  f.memberships.transaction = async run => {
    const result = await originalTransaction(run);
    person = 'revoked-principal';
    return result;
  };
  let failure;
  try { await f.create({}); } catch (error) { failure = error; }
  assert.equal(failure.committed, true);
  assert.equal(failure.effect, 'admission');
  assert.match(failure.message, /principal changed/);
  assert.equal(f.events.has(failure.result.event_id), true);
  assert.equal(writes, 1);
  assert.equal(f.events.size, 1);
  assert.equal(f.calls.length, 0);
  person = 'host';
  const readback = await f.owner.spaceEvents({ community_id: 'space' });
  assert.equal(readback.events[0].event_id, failure.result.event_id);
  assert.equal(writes, 1, 'recovery reads the persisted target instead of creating another');
});

test('fresh grant refusal before commit rolls back staged writes and delivers no effects', async () => {
  let granted = true;
  const f = fixture({ current: async () => { if (!granted) throw new Error('Grant revoked.'); return true; } });
  const originalWrite = f.memberships.putEvents;
  f.memberships.putEvents = rows => { originalWrite(rows); granted = false; };
  await assert.rejects(f.create({}), /Grant revoked/);
  assert.equal(f.events.size, 0);
  assert.equal(f.calls.length, 0);
});

test('fresh grant refusal after commit carries the persisted result and prevents calendar delivery', async () => {
  let granted = true;
  const f = fixture({ current: async () => { if (!granted) throw new Error('Grant revoked.'); return true; } });
  const originalTransaction = f.memberships.transaction;
  f.memberships.transaction = async run => {
    const result = await originalTransaction(run);
    granted = false;
    return result;
  };
  let failure;
  try { await f.create({}); } catch (error) { failure = error; }
  assert.equal(failure.committed, true);
  assert.equal(failure.effect, 'admission');
  assert.equal(f.events.has(failure.result.event_id), true);
  assert.equal(f.events.size, 1);
  assert.equal(f.calls.length, 0);
});

test('a duplicate generated series identity cannot overwrite an occurrence', async () => {
  const f = fixture({ newId: prefix => prefix + '_same' });
  await assert.rejects(f.create({ repeats: { every: 'week', count: 3, time_zone: 'America/New_York' } }), /identity is already/);
  assert.equal(f.events.size, 0);
  assert.equal(f.calls.length, 0);
});

test('ordinary memberships and events without a parent never become an event action target', async () => {
  const f = fixture();
  for (const row of [{ id: 'ordinary', label: 'group', parent_id: 'space' },
    { id: 'orphan', label: 'event', parent_id: null }]) {
    f.events.set(row.id, row);
    await assert.rejects(f.owner.rsvp({ event_id: row.id }), /No community event/);
    await assert.rejects(f.owner.eventFile({ event_id: row.id }), /No community event/);
    await assert.rejects(f.owner.moveEvent({ community_id: 'space', event_id: row.id, title: 'Overwrite' }), /No event/);
    await assert.rejects(f.owner.cancelEvent({ community_id: 'space', event_id: row.id }), /No event/);
    assert.deepEqual(f.events.get(row.id), row);
  }
  assert.equal((await f.owner.spaceEvents({ community_id: 'space' })).events.length, 0);
  assert.equal(f.calls.length, 0);
});

test('a current admission callback must positively confirm rather than return false or unknown', async () => {
  for (const verdict of [false, undefined, null, { status: 'unknown' }]) {
    const f = fixture({ current: async () => verdict });
    await assert.rejects(f.create({}), error => error.status === (verdict === false ? 403 : 503));
    assert.equal(f.events.size, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('unknown holdings reach the membership owner without inventing or accepting caller grants', async () => {
  let checked = 0;
  const f = fixture({
    principal: () => ({ resource: 'space:space', relay: 'host', holds: null, actor: { kind: 'account', id: 'host' } }),
    checkedMay: (_id, _relay, _action, holds) => {
      assert.equal(holds, null);
      checked += 1;
      return true;
    },
  });
  const result = await f.create({ holds: [{ access: 'forged', by: 'host' }] });
  assert.equal(checked, 1);
  assert.equal(f.events.has(result.event_id), true);
});

test('withheld or malformed native actors cannot write through a relay alone', async () => {
  for (const actor of [undefined, null, {}, { kind: 'service', id: 'host' }, { kind: 'account', id: '' }]) {
    const f = fixture({ principal: () => ({ resource: 'space:space', relay: 'host', holds: [], actor }) });
    await assert.rejects(f.create({ actor: { kind: 'account', id: 'host' } }), error => error.status === 403);
    assert.equal(f.events.size, 0);
    assert.equal(f.calls.length, 0);
  }
});

test('unavailable membership evidence cannot expose member-only events or calendar files', async () => {
  const gated = { id: 'space', joined_by_rules: true, owner_relay: 'owner',
    config: { title: 'Shared learning', spaces: { events: 'members' }, join: [{ access: 'paid', says: 'Pay to join' }] } };
  const f = fixture({
    readCommunity: () => structuredClone(gated),
    principal: () => ({ resource: 'space:space', relay: 'host', holds: null, actor: { kind: 'account', id: 'host' } }),
  });
  f.events.set('private-event', { id: 'private-event', label: 'event', parent_id: 'space',
    title: 'Private event', starts_at: '2026-10-31T22:00:00Z', ends_at: null });
  const unavailable = error => error.status === 503 && error.code === 'event_membership_unknown';
  await assert.rejects(f.owner.spaceEvents({ community_id: 'space' }), unavailable);
  await assert.rejects(f.owner.eventFile({ event_id: 'private-event' }), unavailable);
  assert.equal(f.calls.length, 0);
});

for (const { label, result, status, code } of [
  { label: 'denied decision', result: { allowed: false, status: 'denied' }, status: 403, code: 'event_access_denied' },
  { label: 'unknown decision', result: { status: 'unknown', error: 'Synthetic lookup unavailable.' }, status: 503, code: 'event_access_unknown' },
  { label: 'wrong community', result: { id: 'another-space', config: { title: 'Another space', spaces: { events: 'members' } } }, status: 503, code: 'event_access_unknown' },
  { label: 'invalid community config', result: { id: 'space', config: { title: '', spaces: { events: 'members' } } }, status: 503, code: 'event_access_unknown' },
  { label: 'decision disguised as community', result: { id: 'space', config: { title: 'Shared learning' }, allowed: false, status: 'denied' }, status: 403, code: 'event_access_denied' },
]) {
  test('access callback rejects ' + label + ' without writes or effects', async () => {
    const refused = error => error.status === status && error.code === code;
    const creating = fixture({ checkedMay: () => structuredClone(result) });
    let creates = 0;
    const originalCreate = creating.memberships.putEvents;
    creating.memberships.putEvents = rows => { creates += 1; return originalCreate(rows); };
    await assert.rejects(creating.create({}), refused);
    assert.equal(creates, 0);
    assert.equal(creating.events.size, 0);
    assert.equal(creating.calls.length, 0);
  });
}

test('a member who has left cannot change or answer an event, and nothing is written', async () => {
  const f = fixture();
  const { event_id: id } = await f.create({});
  f.calls.length = 0;
  f.leave('host');
  const before = structuredClone(f.events.get(id));
  const refused = error => error.status === 403 && error.code === 'community_membership_required';
  await assert.rejects(f.owner.rsvp({ event_id: id, going: true }), refused);
  await assert.rejects(f.owner.moveEvent({ community_id: 'space', event_id: id, title: 'Forbidden change' }), refused);
  await assert.rejects(f.owner.cancelEvent({ community_id: 'space', event_id: id }), refused);
  assert.equal(f.members.size, 0);
  assert.deepEqual(f.events.get(id), before);
  assert.equal(f.calls.length, 0);
});

test('access callback accepts explicit true and the original matching community result', async () => {
  for (const result of [true, { id: 'space', config: { title: 'Shared learning', spaces: { events: 'members' } } }]) {
    const f = fixture({ checkedMay: () => structuredClone(result) });
    const { event_id: id } = await f.create({});
    await f.owner.rsvp({ event_id: id, going: true });
    await f.owner.moveEvent({ community_id: 'space', event_id: id, title: 'Permitted change' });
    assert.equal(f.events.get(id).title, 'Permitted change');
    assert.equal(f.memberships.member(id, 'host').state, 'member');
    assert.ok(f.calls.some(call => call.kind === 'calendars'));
  }
});

