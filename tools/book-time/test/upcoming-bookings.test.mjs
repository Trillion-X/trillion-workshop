// The host's upcoming list (read-data/upcoming-bookings.mjs): the old "Your upcoming sessions" assertions as tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingBookings } from '../read-data/upcoming-bookings.mjs';

const now = '2026-11-19T12:00:00Z';
const row = (id, scheduled_start, extra = {}) => ({ id, host_ref: 'host:ana', status: 'confirmed', scheduled_start, attendees: [{ email: 'x@example.com' }], meeting_url: `https://meet.example/${id}`, ...extra });

test('the host sees every upcoming booking, earliest first, with who, when and the call link', () => {
  const list = upcomingBookings([row('late', '2026-11-22T10:00:00Z'), row('soon', '2026-11-20T09:00:00Z')], { host: 'host:ana', now });
  assert.deepEqual(list.map(item => item.id), ['soon', 'late']);
  assert.equal(list[0].call, 'https://meet.example/soon');
  assert.deepEqual(list[0].who, [{ email: 'x@example.com' }]);
});

test('another host, a cancelled, completed or no-show booking, and a past start are not upcoming', () => {
  const rows = [
    row('theirs', '2026-11-20T09:00:00Z', { host_ref: 'host:other' }),
    row('cancelled', '2026-11-20T10:00:00Z', { status: 'cancelled' }),
    row('done', '2026-11-20T11:00:00Z', { status: 'completed' }),
    row('missed', '2026-11-20T12:00:00Z', { status: 'no_show' }),
    row('past', '2026-11-18T09:00:00Z'),
  ];
  assert.deepEqual(upcomingBookings(rows, { host: 'host:ana', now }), []);
});

test('a waiting booking with no attendees or no call link still lists, with those fields empty', () => {
  const [item] = upcomingBookings([row('bare', '2026-11-20T09:00:00Z', { status: 'pending_confirmation', attendees: undefined, meeting_url: undefined })], { host: 'host:ana', now });
  assert.equal(item.id, 'bare');
  assert.deepEqual(item.who, []);
  assert.equal(item.call, null);
});

test('an unreadable now is refused in words, not read as the epoch', () => {
  assert.throws(() => upcomingBookings([], { host: 'host:ana', now: 'soon' }), /now must be an ISO time/);
});
