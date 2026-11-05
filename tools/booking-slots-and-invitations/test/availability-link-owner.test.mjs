import test from 'node:test';
import assert from 'node:assert/strict';
import { createAvailabilityLinkOwner } from '../do-work/availability-link-owner.ts';

function harness({ ensure, reconcile, authorizeRecipient, assertRecipientCommit, assertCurrentCommit, readBusy, queryReservations } = {}) {
  const links = new Map(), reservations = new Map(), operations = new Map();
  const effectsSeen = [];
  const effectInputs = [];
  const busyInputs = [];
  const admittedEffects = new Set();
  let now = Date.parse('2026-10-14T00:00:00.000Z');
  const owner = createAvailabilityLinkOwner({
    store: {
      readLink: id => links.get(id) ?? null,
      writeLink: row => links.set(row.id, structuredClone(row)),
      listLinks: ({ after = '', limit }) => {
        const rows = [...links.values()].filter(row => row.id > after).sort((a, b) => a.id.localeCompare(b.id));
        return { links: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].id : null };
      },
      readReservation: id => reservations.get(id) ?? null,
      writeReservation: row => reservations.set(row.id, structuredClone(row)),
      queryReservations: queryReservations ?? (input => {
        const sameCalendar = (left, right) => ['source_id', 'connection_id', 'calendar_id', 'connected_at']
          .every(key => left?.[key] === right?.[key]);
        const candidateCalendars = input.calendars ?? [input.calendar];
        const overlaps = (start, end) => Number.isFinite(start) && Number.isFinite(end)
          && start < input.to_ms && input.from_ms < end;
        const rows = [...reservations.values()].filter(row => (['pending', 'booked'].includes(row.state) || (row.state === 'requested' && row.holds_slot === true))
          && [...(row.host_calendars ?? [row.calendar]), ...(row.pending_host_calendars ?? [])]
          .some(held => candidateCalendars.some(candidate => sameCalendar(held, candidate))) && (
          overlaps(row.occupied_start_ms ?? row.start_ms, row.occupied_end_ms ?? row.end_ms)
          || overlaps(row.pending_occupied_start_ms ?? row.pending_start_ms, row.pending_occupied_end_ms ?? row.pending_end_ms)
        ));
        return { reservations: rows.slice(0, input.limit), complete: rows.length <= input.limit };
      }),
      reservationsOfLink: ({ link_id, after = null, limit }) => {
        const rows = [...reservations.values()].filter(row => row.link_id === link_id).sort((a, b) => a.id.localeCompare(b.id)).filter(row => after === null || row.id > after);
        return { rows: rows.slice(0, limit).map(row => ({ record_id: row.id, reservation: structuredClone(row) })), next: rows.length > limit ? rows[limit - 1].id : null };
      },
      countGrantReservations: ({ link_id, grant_ref, limit }) => [...reservations.values()]
        .filter(row => row.link_id === link_id && row.grant_ref === grant_ref && ['pending', 'booked'].includes(row.state)).slice(0, limit).length,
      readOperation: id => operations.get(id) ?? null,
      writeOperation: row => operations.set(row.id, structuredClone(row)),
    },
    transaction: change => change(),
    current: () => {},
    assertCurrentCommit: assertCurrentCommit ?? (() => {}),
    authorizeRecipient: authorizeRecipient ?? (() => ({ identity: 'recipient:a' })),
    assertRecipientCommit: assertRecipientCommit ?? (() => {}),
    readBusy: async input => { busyInputs.push(structuredClone(input)); return readBusy ? readBusy(input) : { status: 'read', busy: [] }; },
    effects: {
      ensure: ensure ?? (async input => {
        effectInputs.push(structuredClone(input));
        if (!admittedEffects.has(input.request_key)) {
          admittedEffects.add(input.request_key); effectsSeen.push([input.operation.kind === 'reserve' ? 'create' : input.operation.kind, input.request_key]);
        }
        return { state: 'pending' };
      }),
      reconcile: reconcile ?? (async ({ operation }) => ({ state: 'completed', external_event_id: operation.kind === 'cancel' ? undefined : 'event-1' })),
    },
    now: () => now,
    opaqueId: (() => { let next = 0; return () => `opaque-${++next}`; })(),
    identity: value => `identity:${JSON.stringify(value)}`,
  });
  return { owner, effectsSeen, effectInputs, busyInputs, links, reservations, operations, setNow: value => { now = value; } };
}

const linkInput = {
  title: 'Meet with me', timezone: 'UTC', windows: [{ weekday: 4, start: '09:00', end: '10:00' }],
  calendar: { source_id: 'calendar-source:a', connection_id: 'connection:a', calendar_id: 'primary', connected_at: '2026-10-01T00:00:00Z' },
  duration_min: 30, step_min: 30, horizon_days: 30, repeat: true,
};

test('reservation commits before provider completion and reconciliation never redispatches', async () => {
  const h = harness();
  const link = await h.owner.create(linkInput);
  const available = await h.owner.recipientRead({ link_id: link.id, recipient: { bearer: true }, from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(available.slots.map(slot => slot.startMs), [Date.parse('2026-10-15T09:00:00Z'), Date.parse('2026-10-15T09:30:00Z')]);

  const first = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'reserve-1', start_ms: available.slots[0].startMs });
  assert.equal(first.reservation.state, 'pending');
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'create').length, 1);
  const reconciled = await h.owner.reconcile({ operation_id: first.operation.id, recipient: {} });
  assert.equal(reconciled.reservation.state, 'booked');
  assert.equal(h.reservations.get(reconciled.reservation.id).external_event_id, 'event-1');
  assert.equal(reconciled.reservation.external_event_id, undefined);

  const repeated = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'reserve-1', start_ms: available.slots[0].startMs });
  assert.equal(repeated.reservation.id, first.reservation.id);
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'create').length, 1);
});

test('pending moves hold both times, then reconcile into the new reservation time', async () => {
  const h = harness();
  const link = await h.owner.create(linkInput);
  const [first, second] = (await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' })).slots;
  const booked = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'reserve-move', start_ms: first.startMs });
  const reserved = await h.owner.reconcile({ operation_id: booked.operation.id, recipient: {} });
  const moving = await h.owner.move({ reservation_id: reserved.reservation.id, recipient: {}, request_key: 'move-1', start_ms: second.startMs });
  assert.equal(moving.reservation.pending_start_ms, second.startMs);
  const after = await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' });
  assert.deepEqual(after.slots, []);
  const moved = await h.owner.reconcile({ operation_id: moving.operation.id, recipient: {} });
  assert.equal(moved.reservation.start_ms, second.startMs);
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'move').length, 1);
});

test('revocation blocks new reservations but keeps existing manage links usable', async () => {
  const h = harness();
  const link = await h.owner.create(linkInput);
  const [slot] = (await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' })).slots;
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'reserve-cancel', start_ms: slot.startMs });
  const booked = await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  await h.owner.revoke({ link_id: link.id, expected_revision: link.revision });
  await assert.rejects(() => h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' }), /ended/);
  const cancelled = await h.owner.cancel({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'cancel-1' });
  assert.equal(h.reservations.get(cancelled.reservation.id).pending_operation_id, cancelled.operation.id);
  const done = await h.owner.reconcile({ operation_id: cancelled.operation.id, recipient: {} });
  assert.equal(done.reservation.state, 'cancelled');
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'cancel').length, 1);
});

test('one-off links expose only their saved calendar-drag occurrences', async () => {
  const h = harness();
  const oneOff = await h.owner.create({ ...linkInput, repeat: false, windows: [], one_off_slots: [
    { start_ms: Date.parse('2026-10-15T09:00:00Z'), end_ms: Date.parse('2026-10-15T09:30:00Z') },
  ] });
  const first = await h.owner.recipientRead({ link_id: oneOff.id, recipient: {}, from: '2026-10-15', to: '2026-10-16' });
  assert.deepEqual(first.slots.map(slot => slot.startMs), [Date.parse('2026-10-15T09:00:00Z')]);
  const later = await h.owner.recipientRead({ link_id: oneOff.id, recipient: {}, from: '2026-10-22', to: '2026-10-22' });
  assert.deepEqual(later.slots, []);
});



test('a crash before durable task admission recovers the original frozen effect', async () => {
  const admitted = new Map(); let interrupted = true;
  const h = harness({ ensure: async input => {
    if (interrupted) throw new Error('process disappeared before task admission');
    if (!admitted.has(input.request_key)) admitted.set(input.request_key, structuredClone(input));
    return { state: 'completed', external_event_id: 'event:recovered' };
  }, reconcile: async () => ({ state: 'unknown' }) });
  const link = await h.owner.create(linkInput);
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'original', start_ms: Date.parse('2026-10-15T09:00:00Z') });
  assert.equal(pending.reservation.state, 'pending');
  await h.owner.edit({ link_id: link.id, expected_revision: link.revision, changes: { title: 'Changed after the original commitment' } });
  interrupted = false;
  const recovered = await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  assert.equal(recovered.reservation.state, 'booked');
  assert.equal(admitted.size, 1);
  assert.equal(admitted.values().next().value.link.title, linkInput.title, 'recovery retains the original event input');
  assert.equal(admitted.values().next().value.request_key, pending.operation.id, 'the existing effect owner deduplicates by exact operation identity');
});

test('a different recipient cannot inspect, move or cancel an existing reservation', async () => {
  let identity = 'recipient:a';
  const h = harness({ authorizeRecipient: () => ({ identity }) });
  const link = await h.owner.create(linkInput);
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'same-key', start_ms: Date.parse('2026-10-15T09:00:00Z') });
  await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  identity = 'recipient:b';
  await assert.rejects(h.owner.readReservation({ reservation_id: pending.reservation.id, recipient: {} }), /unavailable/);
  await assert.rejects(h.owner.move({ reservation_id: pending.reservation.id, recipient: {}, request_key: 'move', start_ms: Date.parse('2026-10-15T09:30:00Z') }), /unavailable/);
  await assert.rejects(h.owner.cancel({ reservation_id: pending.reservation.id, recipient: {}, request_key: 'cancel' }), /unavailable/);
  assert.equal(h.effectsSeen.length, 1);
});

test('fresh commit refusal and unknown busy data cannot reserve a time', async () => {
  let revoked = false;
  const h = harness({ readBusy: async () => { revoked = true; return { status: 'read', busy: [] }; }, assertRecipientCommit: () => { if (revoked) throw new Error('grant revoked at commitment'); } });
  const link = await h.owner.create(linkInput);
  await assert.rejects(h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'revoked', start_ms: Date.parse('2026-10-15T09:00:00Z') }), /grant revoked/);
  assert.equal(h.reservations.size, 0); assert.equal(h.effectsSeen.length, 0);
  const unknown = harness({ readBusy: async () => ({ status: 'unknown', busy: [] }) });
  const other = await unknown.owner.create(linkInput);
  await assert.rejects(unknown.owner.reserve({ link_id: other.id, recipient: {}, request_key: 'unknown', start_ms: Date.parse('2026-10-15T09:00:00Z') }), /could not be read/);
  assert.equal(unknown.reservations.size, 0);
});

test('recipient reads cover actual local slot instants across the UTC date boundary', async () => {
  let asked;
  const h = harness({ readBusy: async input => { asked = input; return { status: 'read', busy: [{ startMs: Date.parse('2026-10-16T04:00:00Z'), endMs: Date.parse('2026-10-16T04:30:00Z') }] }; } });
  const link = await h.owner.create({ ...linkInput, timezone: 'America/Los_Angeles', windows: [{ weekday: 4, start: '21:00', end: '22:00' }] });
  const read = await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' });
  assert.equal(asked.from_ms, Date.parse('2026-10-16T04:00:00Z'));
  assert.equal(asked.to_ms, Date.parse('2026-10-16T05:00:00Z'));
  assert.deepEqual(read.slots.map(slot => slot.startMs), [Date.parse('2026-10-16T04:30:00Z')]);
});

test('booked buffers remain occupied and malformed recipient details are refused', async () => {
  const h = harness();
  const link = await h.owner.create({ ...linkInput, windows: [{ weekday: 4, start: '09:00', end: '11:00' }], step_min: 5, buffer_before_min: 5, buffer_after_min: 10 });
  await assert.rejects(h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'bad', start_ms: Date.parse('2026-10-15T09:00:00Z'), email: 42 }), /email address/);
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'buffered', start_ms: Date.parse('2026-10-15T09:00:00Z') });
  await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  const read = await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' });
  assert.equal(read.slots[0].startMs, Date.parse('2026-10-15T09:45:00Z'));
});

test('concurrent reservations across links sharing one calendar cannot commit the same slot', async () => {
  let arrivals = 0, release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const h = harness({ readBusy: async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothRead;
    return { status: 'read', busy: [] };
  } });
  const first = await h.owner.create(linkInput);
  const second = await h.owner.create({ ...linkInput, title: 'Another link, same calendar' });
  const start = Date.parse('2026-10-15T09:00:00Z');

  const results = await Promise.allSettled([
    h.owner.reserve({ link_id: first.id, recipient: {}, request_key: 'calendar-race-a', start_ms: start }),
    h.owner.reserve({ link_id: second.id, recipient: {}, request_key: 'calendar-race-b', start_ms: start }),
  ]);

  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /taken|open/);
  assert.equal(h.reservations.size, 1);
  assert.equal(h.effectsSeen.length, 1);
});

test('same-time reservations on different calendar incarnations do not block each other', async () => {
  let arrivals = 0, release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const h = harness({ readBusy: async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothRead;
    return { status: 'read', busy: [] };
  } });
  const first = await h.owner.create(linkInput);
  const second = await h.owner.create({ ...linkInput, title: 'Different calendar', calendar: {
    ...linkInput.calendar, connection_id: 'connection:b', calendar_id: 'primary:b',
  } });
  const start = Date.parse('2026-10-15T09:00:00Z');

  const results = await Promise.all([
    h.owner.reserve({ link_id: first.id, recipient: {}, request_key: 'different-calendar-a', start_ms: start }),
    h.owner.reserve({ link_id: second.id, recipient: {}, request_key: 'different-calendar-b', start_ms: start }),
  ]);

  assert.equal(results.length, 2);
  assert.equal(h.reservations.size, 2);
});

test('a pending reservation blocks competing links that share a co-host calendar before provider visibility', async () => {
  const h = harness();
  const shared = { source_id: 'calendar-source:shared', connection_id: 'connection:shared', calendar_id: 'team', connected_at: '2026-10-01T00:00:00Z' };
  const first = await h.owner.create({ ...linkInput, cohosts: [{ calendar: shared }] });
  const second = await h.owner.create({ ...linkInput, title: 'Different primary', calendar: { ...linkInput.calendar, connection_id: 'connection:b' }, cohosts: [{ calendar: shared }] });
  const start = Date.parse('2026-10-15T09:00:00Z');
  const held = await h.owner.reserve({ link_id: first.id, recipient: {}, request_key: 'cohost-pending-a', start_ms: start });
  assert.equal(held.reservation.state, 'pending');
  await assert.rejects(h.owner.reserve({ link_id: second.id, recipient: {}, request_key: 'cohost-pending-b', start_ms: start }), /taken|open/);
  assert.equal(h.reservations.size, 1);
  assert.equal(h.effectsSeen.length, 1);
});

test('moving and cancelling use the reservation calendar incarnation after a link calendar edit', async () => {
  const h = harness();
  const link = await h.owner.create(linkInput);
  const oldCalendar = structuredClone(link.calendar);
  const firstStart = Date.parse('2026-10-15T09:00:00Z');
  const secondStart = Date.parse('2026-10-15T09:30:00Z');
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'incarnation-reserve', start_ms: firstStart });
  const booked = await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  await h.owner.edit({ link_id: link.id, expected_revision: link.revision, changes: { calendar: {
    ...oldCalendar, connection_id: 'connection:replacement', connected_at: '2026-10-14T12:00:00Z',
  } } });

  const moving = await h.owner.move({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'incarnation-move', start_ms: secondStart });
  const moveBusyRead = h.busyInputs.find(input => input.reservation?.id === booked.reservation.id);
  assert.deepEqual(moveBusyRead.link.calendar, oldCalendar);
  assert.deepEqual(moveBusyRead.exclude_event.calendar, oldCalendar);
  const moved = await h.owner.reconcile({ operation_id: moving.operation.id, recipient: {} });
  const cancel = await h.owner.cancel({ reservation_id: moved.reservation.id, recipient: {}, request_key: 'incarnation-cancel' });
  const effectCalendars = h.effectInputs.filter(input => ['move', 'cancel'].includes(input.operation.kind))
    .map(input => input.link.calendar);
  assert.ok(effectCalendars.length >= 2);
  assert.ok(effectCalendars.every(calendar => JSON.stringify(calendar) === JSON.stringify(oldCalendar)));
  assert.deepEqual(h.reservations.get(cancel.reservation.id).calendar, oldCalendar);
  assert.equal(cancel.reservation.calendar, undefined);
});

test('moves and recovery retain the original co-host calendars after link edits', async () => {
  const h = harness();
  const originalCohost = { source_id: 'calendar-source:cohost', connection_id: 'connection:cohost', calendar_id: 'team', connected_at: '2026-10-01T00:00:00Z' };
  const link = await h.owner.create({ ...linkInput, cohosts: [{ calendar: originalCohost }] });
  const firstStart = Date.parse('2026-10-15T09:00:00Z'), secondStart = Date.parse('2026-10-15T09:30:00Z');
  const held = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'cohost-move-reserve', start_ms: firstStart });
  const booked = await h.owner.reconcile({ operation_id: held.operation.id, recipient: {} });
  await h.owner.edit({ link_id: link.id, expected_revision: link.revision, changes: { cohosts: [{ calendar: { ...originalCohost, connection_id: 'connection:replacement' } }] } });
  const moving = await h.owner.move({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'cohost-move', start_ms: secondStart });
  const persisted = h.reservations.get(booked.reservation.id);
  assert.deepEqual(persisted.host_calendars, [link.calendar, originalCohost]);
  assert.deepEqual(persisted.pending_host_calendars, [link.calendar, originalCohost]);
  assert.deepEqual(h.operations.get(moving.operation.id).effect_input.link.cohosts, [{ calendar: originalCohost }]);
  const recovery = await h.owner.reconcile({ operation_id: moving.operation.id, recipient: {} });
  assert.deepEqual(h.reservations.get(recovery.reservation.id).host_calendars, [link.calendar, originalCohost]);
  assert.equal(recovery.reservation.pending_host_calendars, undefined);
  const cancelling = await h.owner.cancel({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'cohost-cancel-after-edit' });
  const cancelInput = h.operations.get(cancelling.operation.id).effect_input;
  assert.deepEqual(cancelInput.link.calendar, link.calendar);
  assert.deepEqual(cancelInput.link.cohosts, [{ calendar: originalCohost }]);
});

test('an incomplete held-reservation query refuses a slot without admitting an effect', async () => {
  const h = harness({ queryReservations: () => ({ reservations: [], complete: false }) });
  const link = await h.owner.create(linkInput);
  await assert.rejects(h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' }), /more reservations than one read can verify/);
  await assert.rejects(h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'incomplete-query', start_ms: Date.parse('2026-10-15T09:00:00Z') }), /more reservations than one read can verify/);
  assert.equal(h.reservations.size, 0);
  assert.equal(h.effectsSeen.length, 0);
});

test('create, edit, revoke and delete recheck management rights inside their write transaction', async () => {
  const denied = new Set(['availability:link:create', 'availability:link:edit', 'availability:link:revoke', 'availability:link:delete']);
  const h = harness({ assertCurrentCommit: operation => {
    if (denied.has(operation)) throw new Error(`commit right revoked: ${operation}`);
  } });
  await assert.rejects(h.owner.create(linkInput), /commit right revoked: availability:link:create/);
  assert.equal(h.links.size, 0);

  denied.delete('availability:link:create');
  const link = await h.owner.create(linkInput);
  await assert.rejects(h.owner.edit({ link_id: link.id, expected_revision: link.revision, changes: { title: 'Changed' } }), /commit right revoked: availability:link:edit/);
  await assert.rejects(h.owner.revoke({ link_id: link.id, expected_revision: link.revision }), /commit right revoked: availability:link:revoke/);
  await assert.rejects(h.owner.delete({ link_id: link.id, expected_revision: link.revision }), /commit right revoked: availability:link:delete/);
  assert.equal(h.links.get(link.id).title, link.title);
  assert.equal(h.links.get(link.id).state, 'active');
  assert.equal(h.links.get(link.id).revision, link.revision);
});

test('recipient lifecycle replies omit internal task inputs, host configuration and provider identifiers', async () => {
  const h = harness();
  const link = await h.owner.create({ ...linkInput, cohosts: [{ calendar: { ...linkInput.calendar, calendar_id: 'cohost' }, private_contact: 'host-private' }], preferred_times_snapshot: { internal: 'template-private' } });
  const first = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'privacy', start_ms: Date.parse('2026-10-15T09:00:00Z'), name: 'A Guest', email: 'guest@example.test' });
  const booked = await h.owner.reconcile({ operation_id: first.operation.id, recipient: {} });
  const read = await h.owner.readReservation({ reservation_id: first.reservation.id, recipient: {} });
  for (const result of [first, booked, read]) {
    assert.equal(result.operation.effect_input, undefined);
    assert.equal(result.operation.input_identity, undefined);
    assert.equal(result.operation.request_key, undefined);
    assert.equal(result.reservation.calendar, undefined);
    assert.equal(result.reservation.recipient_identity, undefined);
    assert.equal(result.reservation.recipient, undefined);
    assert.equal(result.reservation.external_event_id, undefined);
    assert.doesNotMatch(JSON.stringify(result), /host-private|template-private|guest@example/);
  }
  const management = await h.owner.readReservation({ reservation_id: first.reservation.id });
  assert.equal(management.operation.effect_input.link.cohosts[0].private_contact, 'host-private');
});

test('recipient access revoked during effect admission refuses the reply while retaining the accepted operation', async () => {
  let revoked = false;
  const h = harness({ ensure: async () => { revoked = true; return { state: 'pending' }; }, authorizeRecipient: () => {
    if (revoked) throw new Error('current recipient grant ended');
    return { identity: 'recipient:a' };
  } });
  const link = await h.owner.create(linkInput);
  await assert.rejects(h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'late-revoke', start_ms: Date.parse('2026-10-15T09:00:00Z') }), /current recipient grant ended/);
  assert.equal(h.reservations.size, 1);
  assert.equal([...h.operations.values()][0].state, 'pending');
});

test('revoked links can be restored with current rights and revision while deleted links stay ended', async () => {
  let denied = false;
  const h = harness({ assertCurrentCommit: operation => { if (denied && operation === 'availability:link:restore') throw new Error('restore rights ended'); } });
  const link = await h.owner.create(linkInput);
  const revoked = await h.owner.revoke({ link_id: link.id, expected_revision: link.revision });
  await assert.rejects(h.owner.restore({ link_id: link.id, expected_revision: link.revision }), /changed/);
  denied = true;
  await assert.rejects(h.owner.restore({ link_id: link.id, expected_revision: revoked.revision }), /restore rights ended/);
  denied = false;
  const restored = await h.owner.restore({ link_id: link.id, expected_revision: revoked.revision });
  assert.equal(restored.state, 'active');
  const removed = await h.owner.delete({ link_id: link.id, expected_revision: restored.revision });
  await assert.rejects(h.owner.restore({ link_id: link.id, expected_revision: removed.revision }), /deleted availability link/);
});

test('editing a one-off link retains expired occurrences without admitting newly inserted past times', async () => {
  const h = harness();
  const link = await h.owner.create({ ...linkInput, repeat: false, windows: [], one_off_slots: [
    { start_ms: Date.parse('2026-10-15T09:00:00Z'), end_ms: Date.parse('2026-10-15T09:30:00Z') },
  ] });
  h.setNow(Date.parse('2026-10-16T00:00:00Z'));
  const renamed = await h.owner.edit({ link_id: link.id, expected_revision: link.revision, changes: { title: 'Updated title' } });
  assert.equal(renamed.title, 'Updated title');
  assert.deepEqual(renamed.one_off_slots, link.one_off_slots);
  await assert.rejects(h.owner.edit({ link_id: link.id, expected_revision: renamed.revision, changes: { one_off_slots: [
    { start_ms: Date.parse('2026-10-15T10:00:00Z'), end_ms: Date.parse('2026-10-15T10:30:00Z') },
  ] } }), /new one-off time/);
});

test('saved one-off duration changes preserve historical occurrences and update only future elapsed bounds',async()=>{
 const h=harness(),first=Date.parse('2026-10-15T09:00:00Z'),future=Date.parse('2026-10-17T09:00:00Z');
 const link=await h.owner.create({...linkInput,repeat:false,windows:[],one_off_slots:[{start_ms:first,end_ms:first+30*60000},{start_ms:future,end_ms:future+30*60000}]});
 h.setNow(Date.parse('2026-10-16T00:00:00Z'));
 const saved=await h.owner.edit({link_id:link.id,expected_revision:link.revision,changes:{duration_min:60,one_off_slots:[link.one_off_slots[0],{start_ms:future,end_ms:future+60*60000}]}});
 assert.equal(saved.one_off_slots[0].end_ms,first+30*60000);assert.equal(saved.one_off_slots[1].end_ms,future+60*60000);
 await assert.rejects(h.owner.edit({link_id:link.id,expected_revision:saved.revision,changes:{one_off_slots:[{start_ms:first,end_ms:first+60*60000},saved.one_off_slots[1]]}}),/new one-off time/);
});

test('a link holding one booking per share grant refuses that grant a second while another grant still books', async () => {
  let grant = 'grant:a';
  const h = harness({ authorizeRecipient: () => ({ identity: 'recipient:a', grant }) });
  const link = await h.owner.create({ ...linkInput, per_grant_max: 1 });
  const [first, second] = (await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' })).slots;
  const held = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'a-1', start_ms: first.startMs });
  assert.equal(h.reservations.get(held.reservation.id).grant_ref, 'grant:a');
  await assert.rejects(() => h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'a-2', start_ms: second.startMs }),
    error => error.code === 'grant-limit' && error.status === 409);
  grant = 'grant:b';
  const other = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'b-1', start_ms: second.startMs });
  assert.equal(other.reservation.state, 'pending');
});

test('a day limit closes the rest of a day once that many of the link\'s bookings start on it', async () => {
  const h = harness();
  const link = await h.owner.create({ ...linkInput, windows: [{ weekday: 4, start: '09:00', end: '10:00' }, { weekday: 5, start: '09:00', end: '10:00' }], per_day_max: 1 });
  const [slot] = (await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' })).slots;
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'day-1', start_ms: slot.startMs });
  await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  const after = await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-16' });
  assert.deepEqual(after.slots.map(item => item.date), ['2026-10-16', '2026-10-16']);
});

test('a recipient moves or cancels only until the link\'s change notice; the organizer still changes it', async () => {
  let organizer = false;
  const h = harness({ authorizeRecipient: () => ({ identity: 'recipient:a', ...(organizer ? { organizer: true } : {}) }) });
  const link = await h.owner.create({ ...linkInput, change_notice_min: 1440 });
  const [first, second] = (await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' })).slots;
  const pending = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'notice-1', start_ms: first.startMs });
  const booked = await h.owner.reconcile({ operation_id: pending.operation.id, recipient: {} });
  assert.equal(booked.may_move, true);
  h.setNow(first.startMs - 60 * 60_000);
  const read = await h.owner.readReservation({ reservation_id: booked.reservation.id, recipient: {} });
  assert.equal(read.may_move, false);
  assert.equal(read.may_cancel, false);
  await assert.rejects(() => h.owner.cancel({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'late-cancel' }), error => error.code === 'change-closed');
  await assert.rejects(() => h.owner.move({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'late-move', start_ms: second.startMs }), error => error.code === 'change-closed');
  organizer = true;
  const cancelled = await h.owner.cancel({ reservation_id: booked.reservation.id, recipient: {}, request_key: 'organizer-cancel' });
  assert.equal(cancelled.operation.kind, 'cancel');
});

test('booking limits and the video call choice are validated and kept on the link', async () => {
  const h = harness();
  for (const bad of [{ per_grant_max: 0 }, { per_day_max: 1.5 }, { change_notice_min: -1 }, { video_call: 'yes' }]) {
    await assert.rejects(() => h.owner.create({ ...linkInput, ...bad }), error => error.status === 400);
  }
  const plain = await h.owner.create(linkInput);
  assert.deepEqual([plain.per_grant_max, plain.per_day_max, plain.change_notice_min, plain.video_call], [null, null, 0, false]);
  const call = await h.owner.create({ ...linkInput, video_call: true, per_grant_max: 1 });
  assert.deepEqual([call.video_call, call.per_grant_max], [true, 1]);
});

const slotsOf = async (h, link) => (await h.owner.recipientRead({ link_id: link.id, recipient: {}, from: '2026-10-15', to: '2026-10-15' })).slots;

test('a link with seats lets several people hold the same time, counts the seats left and refuses the one after the last', async () => {
  let who = 'recipient:a';
  const h = harness({ authorizeRecipient: () => ({ identity: who }) });
  const link = await h.owner.create({ ...linkInput, seats_per_slot: 2 });
  const [nine, ninethirty] = await slotsOf(h, link);
  assert.deepEqual([nine.seats_left, ninethirty.seats_left], [2, 2]);
  const first = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'seat-a', start_ms: nine.startMs });
  await h.owner.reconcile({ operation_id: first.operation.id, recipient: {} });
  assert.deepEqual((await slotsOf(h, link)).map(slot => [slot.time, slot.seats_left]), [['09:00', 1], ['09:30', 2]]);
  await assert.rejects(() => h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'seat-a-again', start_ms: nine.startMs }),
    error => error.code === 'seat-held' && error.status === 409);
  who = 'recipient:b';
  const second = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'seat-b', start_ms: nine.startMs });
  await h.owner.reconcile({ operation_id: second.operation.id, recipient: {} });
  assert.deepEqual((await slotsOf(h, link)).map(slot => slot.time), ['09:30'], 'a full time leaves the offer while the next time stays open');
  who = 'recipient:c';
  await assert.rejects(() => h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'seat-c', start_ms: nine.startMs }),
    error => error.code === 'slot-taken' && error.status === 409);
  assert.equal([...h.reservations.values()].filter(row => row.state === 'booked').length, 2);
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'create').length, 2, 'each seat makes its own calendar event');
});

test('the events of a link\'s other seats are told to the calendar read, so they never make the time look busy', async () => {
  let who = 'recipient:a';
  const h = harness({ authorizeRecipient: () => ({ identity: who }) });
  const seated = await h.owner.create({ ...linkInput, seats_per_slot: 3 });
  const plain = await h.owner.create({ ...linkInput, title: 'No seats', calendar: { ...linkInput.calendar, calendar_id: 'other' } });
  const start = Date.parse('2026-10-15T09:00:00Z');
  const booked = await h.owner.reserve({ link_id: seated.id, recipient: {}, request_key: 'seat-1', start_ms: start });
  await h.owner.reconcile({ operation_id: booked.operation.id, recipient: {} });
  h.busyInputs.length = 0;
  who = 'recipient:b';
  await h.owner.reserve({ link_id: seated.id, recipient: {}, request_key: 'seat-2', start_ms: start });
  assert.deepEqual(h.busyInputs.at(-1).exclude_events, [{ calendar: seated.calendar, event_id: 'event-1' }]);
  h.busyInputs.length = 0;
  await slotsOf(h, plain);
  assert.equal(h.busyInputs.at(-1).exclude_events, undefined, 'a link without seats excludes nothing');
});

test('a different time that overlaps a seated time stays blocked, and the last seat goes to only one of two simultaneous bookers', async () => {
  let arrivals = 0, release, who = 'recipient:a';
  const bothRead = new Promise(resolve => { release = resolve; });
  const h = harness({ authorizeRecipient: () => ({ identity: who }), readBusy: async () => {
    if (who === 'gate') { arrivals += 1; if (arrivals === 2) release(); await bothRead; }
    return { status: 'read', busy: [] };
  } });
  const link = await h.owner.create({ ...linkInput, seats_per_slot: 2, step_min: 15 });
  const start = Date.parse('2026-10-15T09:00:00Z');
  const held = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'first', start_ms: start });
  assert.ok(!(await slotsOf(h, link)).some(slot => slot.startMs === start + 15 * 60_000), 'an overlapping start is not offered');
  await assert.rejects(() => h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'overlap', start_ms: start + 15 * 60_000 }), error => error.code === 'slot-taken');
  assert.equal(held.reservation.state, 'pending');
  const results = await Promise.allSettled(['gate-1', 'gate-2'].map(async (key, index) => {
    who = 'gate';
    return h.owner.reserve({ link_id: link.id, recipient: { key }, request_key: key, start_ms: start });
  }));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'one seat was left');
  assert.match(results.find(result => result.status === 'rejected').reason.message, /taken|open|already/);
  assert.equal([...h.reservations.values()].filter(row => row.start_ms === start).length, 2);
});

test('seats and confirmation settings are validated, and seats cannot be combined with co-hosts', async () => {
  const h = harness();
  for (const bad of [{ seats_per_slot: 0 }, { seats_per_slot: 1.5 }, { seats_per_slot: 'many' }, { requires_confirmation: 'yes' }, { pending_blocks_slot: 1 },
    { seats_per_slot: 2, cohosts: [{ calendar: { ...linkInput.calendar, calendar_id: 'co' }, email: 'co@example.com' }] }]) {
    await assert.rejects(() => h.owner.create({ ...linkInput, ...bad }), error => error.status === 400, JSON.stringify(bad));
  }
  const plain = await h.owner.create(linkInput);
  assert.deepEqual([plain.seats_per_slot, plain.requires_confirmation, plain.pending_blocks_slot], [null, false, false]);
});

test('a link that asks for confirmation records a request, makes the calendar event only when the organizer confirms, and frees the time on decline', async () => {
  let who = 'recipient:a';
  const h = harness({ authorizeRecipient: () => ({ identity: who }) });
  const link = await h.owner.create({ ...linkInput, requires_confirmation: true });
  const [nine] = await slotsOf(h, link);
  const asked = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'ask-a', start_ms: nine.startMs });
  assert.equal(asked.reservation.state, 'requested');
  assert.equal(asked.may_cancel, true);
  assert.equal(h.effectsSeen.length, 0, 'nothing reaches the calendar before the organizer answers');
  assert.equal((await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'ask-a', start_ms: nine.startMs })).reservation.id, asked.reservation.id, 'a retried request is the same request');
  assert.equal([...h.reservations.values()].length, 1);
  assert.equal((await slotsOf(h, link)).length, 2, 'by default a waiting request leaves its time open to others');
  who = 'recipient:b';
  const rival = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'ask-b', start_ms: nine.startMs });
  assert.deepEqual((await h.owner.reservations({ link_id: link.id, state: 'requested' })).reservations.map(row => row.id).sort(), [asked.reservation.id, rival.reservation.id].sort());

  const confirmed = await h.owner.confirm({ reservation_id: asked.reservation.id, request_key: 'yes-a' });
  assert.equal(confirmed.reservation.state, 'pending');
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'create').length, 1);
  const booked = await h.owner.reconcile({ operation_id: confirmed.operation.id });
  assert.equal(booked.reservation.state, 'booked');
  assert.equal((await h.owner.confirm({ reservation_id: asked.reservation.id, request_key: 'yes-a' })).reservation.id, asked.reservation.id);
  assert.equal(h.effectsSeen.filter(([kind]) => kind === 'create').length, 1, 'confirming again with the same key makes no second event');

  await assert.rejects(() => h.owner.confirm({ reservation_id: rival.reservation.id, request_key: 'yes-b' }), error => error.code === 'slot-taken' && error.status === 409);
  const declined = await h.owner.decline({ reservation_id: rival.reservation.id, request_key: 'no-b' });
  assert.deepEqual([declined.reservation.state, declined.reservation.ended_by, declined.reservation.ended_reason], ['cancelled', 'organizer', 'declined']);
  assert.equal(declined.operation.state, 'completed');
  assert.equal((await h.owner.decline({ reservation_id: rival.reservation.id, request_key: 'no-b' })).reservation.state, 'cancelled', 'declining again with the same key answers the same outcome');
  await assert.rejects(() => h.owner.decline({ reservation_id: rival.reservation.id, request_key: 'no-b-2' }), error => error.code === 'reservation-changed');
  await assert.rejects(() => h.owner.confirm({ reservation_id: rival.reservation.id, request_key: 'yes-b-2' }), error => error.code === 'reservation-changed');
  assert.equal(h.effectsSeen.length, 1, 'declining makes no calendar change');
  const everything = await h.owner.reservations({ link_id: link.id });
  assert.deepEqual(everything.reservations.map(row => row.state).sort(), ['booked', 'cancelled']);
});

test('a request can hold its time while it waits, and the person who asked can withdraw it but not move it', async () => {
  const h = harness();
  const link = await h.owner.create({ ...linkInput, requires_confirmation: true, pending_blocks_slot: true });
  const [nine, ninethirty] = await slotsOf(h, link);
  const asked = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'hold', start_ms: nine.startMs });
  assert.equal(h.reservations.get(asked.reservation.id).holds_slot, true);
  assert.deepEqual((await slotsOf(h, link)).map(slot => slot.time), ['09:30'], 'the waiting request holds 09:00');
  await assert.rejects(() => h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'rival', start_ms: nine.startMs }), error => error.code === 'slot-taken');
  await assert.rejects(() => h.owner.move({ reservation_id: asked.reservation.id, recipient: {}, request_key: 'move', start_ms: ninethirty.startMs }), error => error.code === 'reservation-requested');
  const withdrawn = await h.owner.cancel({ reservation_id: asked.reservation.id, recipient: {}, request_key: 'withdraw' });
  assert.equal(withdrawn.reservation.state, 'cancelled');
  assert.equal(h.reservations.get(asked.reservation.id).ended_by, 'recipient');
  assert.equal(h.effectsSeen.length, 0);
  assert.deepEqual((await slotsOf(h, link)).map(slot => slot.time), ['09:00', '09:30'], 'withdrawing frees the time');
});

test('a request for a time that has passed cannot be confirmed, only declined', async () => {
  const h = harness();
  const link = await h.owner.create({ ...linkInput, requires_confirmation: true });
  const [nine] = await slotsOf(h, link);
  const asked = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'late', start_ms: nine.startMs });
  h.setNow(nine.startMs + 60_000);
  await assert.rejects(() => h.owner.confirm({ reservation_id: asked.reservation.id, request_key: 'too-late' }), error => error.code === 'request-expired');
  assert.equal((await h.owner.decline({ reservation_id: asked.reservation.id, request_key: 'close' })).reservation.state, 'cancelled');
});

const hostB = { source_id: 'calendar-source:a', connection_id: 'connection:b', calendar_id: 'team', connected_at: '2026-10-01T00:00:00Z' };
const sameCal = (left, right) => ['source_id', 'connection_id', 'calendar_id', 'connected_at'].every(key => left?.[key] === right?.[key]);
// A calendar read where each host can be busy at its own times: A and B's busy times are chosen by the test.
const twoHostsRead = busyOf => async input => {
  const hosts = [input.link.calendar, ...(input.link.cohosts ?? []).map(host => host.calendar)];
  const byHost = hosts.map(calendar => ({ calendar, busy: busyOf(calendar) }));
  return { status: 'read', busy: byHost.flatMap(entry => entry.busy), ...(input.by_calendar ? { by_calendar: byHost } : {}) };
};
const nineAm = Date.parse('2026-10-15T09:00:00Z');
const busyAt = (start, minutes = 30) => ({ startMs: start, endMs: start + minutes * 60_000 });
const teamLink = { ...linkInput, windows: [{ weekday: 4, start: '09:00', end: '12:00' }], cohosts: [{ calendar: hostB, email: 'b@example.com' }] };

test('hosts who take turns offer a time when any one of them is free, and give each booking to one host', async () => {
  const busy = { a: [busyAt(nineAm)], b: [] };
  const h = harness({ readBusy: twoHostsRead(calendar => sameCal(calendar, hostB) ? busy.b : busy.a) });
  const everyone = await h.owner.create(teamLink);
  const turns = await h.owner.create({ ...teamLink, host_mode: 'take_turns', title: 'Take turns', calendar: { ...linkInput.calendar, calendar_id: 'owner-two' } });
  assert.equal((await slotsOf(h, everyone)).some(slot => slot.startMs === nineAm), false, 'everyone must be free, and host A is busy at 09:00');
  const offered = await slotsOf(h, turns);
  assert.equal(offered.some(slot => slot.startMs === nineAm), true, 'host B is free at 09:00, so taking turns offers it');
  assert.ok(offered.every(slot => slot.free_hosts === undefined), 'which hosts are free is never shown to the visitor');

  const first = await h.owner.reserve({ link_id: turns.id, recipient: {}, request_key: 'turn-1', start_ms: nineAm });
  const row = h.reservations.get(first.reservation.id);
  assert.ok(sameCal(row.calendar, hostB), 'only host B was free, so B takes it');
  assert.deepEqual(row.host_calendars.map(calendar => calendar.calendar_id), ['team']);
  const effect = h.effectInputs.at(-1);
  assert.ok(sameCal(effect.link.calendar, hostB) && (effect.link.cohosts ?? []).length === 0, 'the calendar event is made on B\'s calendar alone');
  assert.equal((await slotsOf(h, turns)).some(slot => slot.startMs === nineAm), false, 'B is now booked and A is busy: the time is gone');
});

test('hosts who take turns are spread evenly, or by weight', async () => {
  const h = harness({ readBusy: twoHostsRead(() => []) });
  const even = await h.owner.create({ ...teamLink, host_mode: 'take_turns' });
  const who = async (link, key, at) => {
    const booked = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: key, start_ms: at });
    return h.reservations.get(booked.reservation.id).calendar.calendar_id;
  };
  const starts = [0, 30, 60, 90].map(minutes => nineAm + minutes * 60_000);
  assert.deepEqual([await who(even, 'e1', starts[0]), await who(even, 'e2', starts[1]), await who(even, 'e3', starts[2]), await who(even, 'e4', starts[3])],
    ['primary', 'team', 'primary', 'team'], 'equal weights alternate');
  const weighted = await h.owner.create({ ...teamLink, host_mode: 'take_turns', title: 'Weighted', calendar: { ...linkInput.calendar, calendar_id: 'owner-two' }, host_weight: 1,
    cohosts: [{ calendar: { ...hostB, calendar_id: 'team-two' }, email: 'b@example.com', weight: 3 }] });
  const picks = [];
  for (const [index, at] of starts.entries()) picks.push(await who(weighted, `w${index}`, at));
  assert.deepEqual(picks.sort(), ['owner-two', 'team-two', 'team-two', 'team-two'], 'a host of weight 3 takes three of four');
});

test('a booking that took turns stays with its host when it is moved, and the other host\'s busy time does not matter', async () => {
  const busy = { a: [], b: [] };
  const h = harness({ readBusy: twoHostsRead(calendar => sameCal(calendar, hostB) ? busy.b : busy.a) });
  const link = await h.owner.create({ ...teamLink, host_mode: 'take_turns' });
  const first = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'm1', start_ms: nineAm });
  await h.owner.reconcile({ operation_id: first.operation.id, recipient: {} });
  const host = h.reservations.get(first.reservation.id).calendar;
  busy.a = [busyAt(nineAm + 30 * 60_000, 120)];
  busy.b = [busyAt(nineAm + 30 * 60_000, 120)];
  await assert.rejects(() => h.owner.move({ reservation_id: first.reservation.id, recipient: {}, request_key: 'm2', start_ms: nineAm + 30 * 60_000 }), error => error.code === 'slot-taken');
  busy.a = [];
  busy.b = [busyAt(nineAm + 30 * 60_000, 120)];
  const sameHost = sameCal(host, hostB);
  if (sameHost) await assert.rejects(() => h.owner.move({ reservation_id: first.reservation.id, recipient: {}, request_key: 'm3', start_ms: nineAm + 30 * 60_000 }), error => error.code === 'slot-taken');
  else assert.equal((await h.owner.move({ reservation_id: first.reservation.id, recipient: {}, request_key: 'm3', start_ms: nineAm + 30 * 60_000 })).reservation.pending_start_ms, nineAm + 30 * 60_000);
  assert.ok(sameCal(h.reservations.get(first.reservation.id).calendar, host), 'the host never changes');
});

test('host modes and weights are validated; a request to a link whose hosts take turns goes to a host and is confirmed on that host\'s calendar', async () => {
  const h = harness({ readBusy: twoHostsRead(() => []) });
  for (const bad of [{ host_mode: 'random' }, { host_weight: 0 }, { host_weight: 1.5 }, { cohosts: [{ calendar: hostB, email: 'b@example.com', weight: 101 }] }]) {
    await assert.rejects(() => h.owner.create({ ...teamLink, ...bad }), error => error.status === 400, JSON.stringify(bad));
  }
  const link = await h.owner.create({ ...teamLink, host_mode: 'take_turns', requires_confirmation: true });
  const asked = await h.owner.reserve({ link_id: link.id, recipient: {}, request_key: 'ask', start_ms: nineAm });
  assert.equal(asked.reservation.state, 'requested');
  const host = h.reservations.get(asked.reservation.id).calendar;
  const confirmed = await h.owner.confirm({ reservation_id: asked.reservation.id, request_key: 'yes' });
  assert.equal(confirmed.reservation.state, 'pending');
  assert.ok(sameCal(h.effectInputs.at(-1).link.calendar, host) && (h.effectInputs.at(-1).link.cohosts ?? []).length === 0);
});
